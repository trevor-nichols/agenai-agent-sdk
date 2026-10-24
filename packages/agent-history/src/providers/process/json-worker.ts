import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { HistoryProcessOwner } from './owner.js';
import { terminateProcessGroup, waitForGroupExit } from './group.js';

interface JsonWorkerResources {
  readonly executable: string;
  readonly temporaryRoot: string;
}

interface JsonMutationObserver {
  dispatch(): void;
  receipt(value: unknown, dispatched: boolean): void;
}
const MUTATION_PERMIT = '{"version":1,"kind":"dispatch"}\n';

export class HistoryJsonWorkerOwner {
  private constructor(private readonly owner: HistoryProcessOwner, private readonly resources: JsonWorkerResources, private readonly worker: URL) {}

  static async create(resources: JsonWorkerResources, worker: URL, prefix: string): Promise<HistoryJsonWorkerOwner> {
    return new HistoryJsonWorkerOwner(await HistoryProcessOwner.create(resources.temporaryRoot, prefix), resources, worker);
  }

  async run(input: string, signal: AbortSignal, environment: Readonly<Record<string, string>> = {}): Promise<unknown> {
    return this.execute(input, signal, environment);
  }

  async mutate(input: string, signal: AbortSignal, observer: JsonMutationObserver,
    environment: Readonly<Record<string, string>> = {}): Promise<unknown> {
    return this.execute(input, signal, environment, observer);
  }

  private async execute(input: string, signal: AbortSignal, environment: Readonly<Record<string, string>>,
    observer?: JsonMutationObserver): Promise<unknown> {
    signal.throwIfAborted();
    if (Buffer.byteLength(input) + (observer === undefined ? 0 : 1 + Buffer.byteLength(MUTATION_PERMIT)) > 32_768) {
      throw new AgentHistoryError('limit_exhausted', 'Native history request exceeds its worker envelope.');
    }
    return this.owner.run(async (scope) => {
      const operationRoot = scope.root;
      const paths = Object.fromEntries(['home', 'config', 'cache', 'data', 'state', 'tmp'].map((name) => [name, join(operationRoot, name)]));
      await Promise.all(Object.values(paths).map((path) => mkdir(path, { mode: 0o700 })));
      scope.signal.throwIfAborted();
      const child = spawn(this.resources.executable, [
        '--as=4294967296', '--cpu=12', '--nofile=128', '--core=0', '--', process.execPath,
        '--jitless', '--max-old-space-size=128', fileURLToPath(this.worker),
      ], { cwd: operationRoot, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
        ...environment, PATH: '/usr/bin:/bin', HOME: paths.home, XDG_CONFIG_HOME: paths.config, XDG_CACHE_HOME: paths.cache,
        XDG_DATA_HOME: paths.data, XDG_STATE_HOME: paths.state, TMPDIR: paths.tmp,
        LANG: 'C.UTF-8', CI: '1',
      } });
      let failure: AgentHistoryError | undefined;
      let outputBytes = 0;
      const chunks: Buffer[] = [];
      let pending = Buffer.alloc(0);
      const mutation: { phase: 'waiting' | 'permitted' | 'done'; result?: unknown } = { phase: 'waiting' };
      const stop = (error?: AgentHistoryError) => {
        failure ??= error;
        if (child.pid === undefined) return;
        try { terminateProcessGroup(child.pid); }
        catch (cleanupError) {
          failure = cleanupError instanceof AgentHistoryError ? cleanupError : new AgentHistoryError('cleanup_failed', 'Native history worker cleanup failed.');
        }
      };
      const exited = new Promise<{ code: number | null }>((resolve) => {
        child.once('error', () => { failure ??= new AgentHistoryError('native_failure', 'Native history worker could not start.'); });
        child.once('exit', () => stop());
        child.once('close', (code) => resolve({ code }));
      });
      scope.ownCleanup(async () => {
        stop();
        await exited;
        if (child.pid !== undefined) await waitForGroupExit(child.pid);
      });
      const consume = (chunk: Buffer, stdout: boolean) => {
        outputBytes += chunk.length;
        if (outputBytes > 262_144) {
          stop(new AgentHistoryError('limit_exhausted', 'Native history worker exceeded its output limit.'));
        } else if (stdout && observer === undefined) chunks.push(chunk);
        else if (stdout && observer !== undefined) {
          pending = Buffer.concat([pending, chunk]);
          let newline: number;
          try {
            while ((newline = pending.indexOf(10)) !== -1) {
              const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, newline)));
              pending = pending.subarray(newline + 1);
              if (mutation.phase === 'done') throw new Error('Unexpected frame after receipt');
              if (frame !== null && typeof frame === 'object' && 'kind' in frame && frame.kind === 'ready') {
                if (mutation.phase !== 'waiting' || Object.keys(frame).length !== 2 || !('version' in frame) || frame.version !== 1) {
                  throw new Error('Invalid mutation readiness');
                }
                scope.signal.throwIfAborted();
                observer.dispatch();
                mutation.phase = 'permitted';
                child.stdin.end(MUTATION_PERMIT);
              } else {
                observer.receipt(frame, mutation.phase === 'permitted');
                mutation.result = frame;
                mutation.phase = 'done';
                child.stdin.end();
              }
            }
          } catch (error) {
            stop(error instanceof AgentHistoryError ? error : new AgentHistoryError('native_failure', 'Native history worker returned an invalid mutation frame.'));
          }
        }
      };
      child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
      child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
      child.stdin.on('error', () => stop(new AgentHistoryError('native_failure', 'Native history worker input closed unexpectedly.')));
      const cancel = () => stop(new AgentHistoryError('cancelled', 'Native history read was cancelled.'));
      scope.signal.addEventListener('abort', cancel, { once: true });
      if (scope.signal.aborted) cancel();
      const timer = setTimeout(() => stop(new AgentHistoryError('deadline_exceeded', 'Native history worker exceeded its wall deadline.')), 20_000);
      try {
        if (observer === undefined) child.stdin.end(input);
        else child.stdin.write(`${input}\n`);
        const exit = await exited;
        if (failure) throw failure;
        if (exit.code !== 0) throw new AgentHistoryError('native_failure', 'Native history worker exited without a result.');
        if (observer !== undefined) {
          if (mutation.phase !== 'done' || pending.length !== 0) throw new AgentHistoryError('native_failure', 'Native history worker exited without a complete mutation receipt.');
          return mutation.result;
        }
        try {
          const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          return result;
        } catch { throw new AgentHistoryError('native_failure', 'Native history worker returned an invalid response.'); }
      } finally {
        clearTimeout(timer);
        scope.signal.removeEventListener('abort', cancel);
      }
    }, signal);
  }

  dispose(): Promise<void> { return this.owner.dispose(); }
}
