// ------------------------------------------------------------------------------------------------
//                process.ts - The owned SDK worker: explicit environment, sole reader and joined shutdown
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WorkerFailure } from './errors.js';
import { boundedLines, encodeLine, LINE_BYTES, parseLine, TOOL_CALL_BYTES, workerMessage, type ConfigureMessage, type DriverMessage, type WorkerMessage } from './protocol.js';

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));
const READY_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 10_000;
const GROUP_JOIN_MS = 5_000;

/** Startup failed and the worker group could not be joined; `retryCleanup` keeps that owner. */
export class WorkerCleanupFailure extends WorkerFailure {
  constructor(readonly startupError: unknown, readonly cleanupError: unknown, readonly retryCleanup: () => Promise<void>) {
    super('startup', 'The Claude worker failed to start and could not be joined.', { cause: startupError });
  }
}

export type WorkerEvent = WorkerMessage | Readonly<{ type: 'transport_failed'; error: WorkerFailure }>;

export interface WorkerProcess {
  /** The sole consumer of worker output; installed once, before readiness resolves. */
  listen(listener: (event: WorkerEvent) => void): void;
  send(message: DriverMessage): void;
  /** Requests a graceful close, then kills and joins the whole worker process group. Retryable. */
  close(): Promise<void>;
}

export interface WorkerLaunch {
  readonly directory: string;
  readonly home: string;
  readonly temporary: string;
  readonly configure: ConfigureMessage;
  readonly signal?: AbortSignal;
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Starts the worker in its own process group with a fixed minimal environment. The credential
 * travels only in the first stdin line. Resolves after the worker proves the exact owned tool server.
 */
export async function startWorker(launch: WorkerLaunch): Promise<Readonly<{ worker: WorkerProcess; tools: readonly string[] }>> {
  launch.signal?.throwIfAborted();
  const child = spawn(process.execPath, [WORKER], {
    cwd: launch.directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: launch.home, TMPDIR: launch.temporary, LANG: 'C.UTF-8' },
  });
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
  child.stderr.resume();
  let listener: ((event: WorkerEvent) => void) | undefined;
  const backlog: WorkerEvent[] = [];
  let transportFailed = false;
  let closedReceipt = false;
  const deliver = (event: WorkerEvent) => {
    if (event.type === 'closed') closedReceipt = true;
    if (listener) listener(event);
    else if (backlog.length < 64) backlog.push(event);
    else {
      transportFailed = true;
      backlog.splice(0, backlog.length, { type: 'transport_failed', error: new WorkerFailure('transport', 'Claude worker output had no owner.') });
    }
  };
  const failTransport = (cause: unknown): WorkerFailure => {
    const error = new WorkerFailure('transport', 'The Claude worker transport failed.', { cause });
    if (!transportFailed) {
      transportFailed = true;
      deliver({ type: 'transport_failed', error });
    }
    return error;
  };
  child.stdin.on('error', failTransport);
  const pump = (async () => {
    try {
      for await (const line of boundedLines(child.stdout, TOOL_CALL_BYTES)) {
        const message = parseLine(workerMessage, line);
        if (message.type !== 'tool_call' && Buffer.byteLength(line) + 1 > LINE_BYTES) throw new RangeError('Worker control line exceeds its byte bound.');
        deliver(message);
      }
      if (!closedReceipt) throw new Error('The worker output ended without a close receipt.');
    } catch (cause) {
      failTransport(cause);
    }
  })();

  let joined = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (joined) return Promise.resolve();
    closing ??= join().finally(() => { closing = undefined; });
    return closing;
  };
  const join = async (): Promise<void> => {
    if (!transportFailed && child.exitCode === null && child.stdin.writable) child.stdin.write(encodeLine({ type: 'close' }));
    child.stdin.end();
    await Promise.race([exited, delay(CLOSE_TIMEOUT_MS)]);
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already empty */ }
      const deadline = Date.now() + GROUP_JOIN_MS;
      while (groupAlive(pid) && Date.now() < deadline) await delay(25);
      if (groupAlive(pid)) throw new WorkerFailure('runtime', 'The Claude worker process group did not exit.');
    }
    await exited;
    await pump;
    joined = true;
  };

  const worker: WorkerProcess = Object.freeze({
    listen(next: (event: WorkerEvent) => void) {
      if (listener) throw new Error('The worker output already has its owner.');
      listener = next;
      for (const event of backlog.splice(0)) next(event);
    },
    send(message: DriverMessage) {
      if (transportFailed) throw new WorkerFailure('transport', 'The Claude worker no longer accepts input.');
      try {
        if (!child.stdin.writable) throw new Error('The worker input is closed.');
        child.stdin.write(encodeLine(message));
      } catch (cause) { throw failTransport(cause); }
    },
    close,
  });

  try {
    if (pid === undefined) throw new WorkerFailure('startup', 'The Claude worker did not start.');
    child.stdin.write(encodeLine(launch.configure));
    const tools = await new Promise<readonly string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new WorkerFailure('startup', 'The Claude worker was not ready in time.')), READY_TIMEOUT_MS);
      const abort = () => reject(launch.signal?.reason ?? new DOMException('Claude session opening was aborted.', 'AbortError'));
      launch.signal?.addEventListener('abort', abort, { once: true });
      const settle = () => { clearTimeout(timer); launch.signal?.removeEventListener('abort', abort); };
      const first = (event: WorkerEvent) => {
        settle();
        if (event.type === 'ready') resolve(event.tools);
        else if (event.type === 'failed') reject(new WorkerFailure('startup', `Claude did not become ready: ${event.message}`));
        else if (event.type === 'transport_failed') reject(event.error);
        else reject(new WorkerFailure('startup', `The Claude worker sent ${event.type} before readiness.`));
      };
      if (backlog.length) first(backlog.shift()!);
      else listener = (event) => { listener = undefined; first(event); };
    });
    return { worker, tools };
  } catch (cause) {
    listener = undefined;
    try { await close(); } catch (cleanupError) { throw new WorkerCleanupFailure(cause, cleanupError, close); }
    throw cause;
  }
}
