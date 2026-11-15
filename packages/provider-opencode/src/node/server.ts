// ------------------------------------------------------------------------------------------------
//                server.ts - The owned OpenCode server process: explicit environment and joined shutdown
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeFailure } from './errors.js';

const READY_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 10_000;
const GROUP_JOIN_MS = 5_000;
const ANNOUNCEMENT_BYTES = 4_096;
const ANNOUNCEMENT = /^\{"url":"(http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4}))"\}$/u;

/** Opening failed and the server group could not be joined; `retryCleanup` keeps that owner. */
export class NativeCleanupFailure extends NativeFailure {
  constructor(readonly openingError: unknown, readonly cleanupError: unknown, readonly retryCleanup: () => Promise<void>) {
    super('startup', 'The OpenCode session failed to open and could not be cleaned up.', { cause: openingError });
  }
}

export interface NativeServer {
  /** The private loopback origin announced on the server's own output. */
  readonly url: string;
  /** Resolves (never rejects) once the server process has exited. */
  readonly exited: Promise<void>;
  /** Closes stdin, then kills and joins the whole server process group. Retryable. */
  close(): Promise<void>;
}

export interface NativeServerLaunch {
  readonly executable: string;
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** Only `ESRCH` proves the group is empty; every other polling outcome means it may remain. */
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Starts `opencode serve` in its own process group with exactly the supplied environment. */
export async function startNativeServer(launch: NativeServerLaunch): Promise<NativeServer> {
  launch.signal?.throwIfAborted();
  const child = spawn(launch.executable, ['serve', '--stdio', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: launch.directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...launch.environment },
  });
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
  child.stdin.on('error', () => {});
  child.stderr.resume();

  const announced = new Promise<string>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new NativeFailure('startup', 'The OpenCode server did not announce its endpoint in time.')), READY_TIMEOUT_MS);
    const abort = () => reject(launch.signal?.reason ?? new DOMException('OpenCode session opening was aborted.', 'AbortError'));
    launch.signal?.addEventListener('abort', abort, { once: true });
    const settle = () => { clearTimeout(timer); launch.signal?.removeEventListener('abort', abort); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function onData(chunk: string) {
      text += chunk;
      const end = text.indexOf('\n');
      if (end === -1 && text.length <= ANNOUNCEMENT_BYTES) return;
      child.stdout.off('data', onData);
      child.stdout.resume();
      settle();
      const match = end === -1 ? null : ANNOUNCEMENT.exec(text.slice(0, end).trim());
      if (match && Number(match[2]) <= 65_535) resolve(match[1]!);
      else reject(new NativeFailure('startup', 'The OpenCode server announced an unexpected endpoint.'));
    });
    void exited.then(() => { settle(); reject(new NativeFailure('startup', 'The OpenCode server exited before announcing its endpoint.')); });
  });
  void announced.catch(() => undefined);

  let joined = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (joined) return Promise.resolve();
    closing ??= join().finally(() => { closing = undefined; });
    return closing;
  };
  const join = async (): Promise<void> => {
    child.stdin.end();
    await Promise.race([exited, delay(CLOSE_TIMEOUT_MS, undefined, { ref: false })]);
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* polled below */ }
      const deadline = Date.now() + GROUP_JOIN_MS;
      while (groupAlive(pid) && Date.now() < deadline) await delay(25);
      if (groupAlive(pid)) throw new NativeFailure('runtime', 'The OpenCode server process group did not exit.');
    }
    await exited;
    joined = true;
  };

  try {
    if (pid === undefined) throw new NativeFailure('startup', 'The OpenCode server did not start.');
    const url = await announced;
    return Object.freeze({ url, exited, close });
  } catch (cause) {
    try { await close(); } catch (cleanupError) { throw new NativeCleanupFailure(cause, cleanupError, close); }
    throw cause;
  }
}
