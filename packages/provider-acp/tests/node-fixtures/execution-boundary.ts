import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { NodeAcpExecutionBoundary } from '../../src/node/index.js';

/** Only the inspected controlled peer runs here; it creates no descendants. This is not a platform reference. */
export function controlledPeerExecutionBoundary(): NodeAcpExecutionBoundary {
  return { reserve(input) {
    let child: ChildProcessWithoutNullStreams | undefined;
    let closed = false;
    let stopped = false;
    let pending: Promise<void> | undefined;
    let complete = false;
    const signal = (value: NodeJS.Signals | 0): boolean => {
      if (!child?.pid) return false;
      try { process.kill(-child.pid, value); return true; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
        throw error;
      }
    };
    return {
      start(context) {
        context.signal?.throwIfAborted();
        if (stopped || child) throw new Error('Controlled execution is already started or stopped.');
        child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: { ...input.env },
          detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('error', () => {});
        child.once('close', () => { closed = true; });
        return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr };
      },
      release() {
        stopped = true;
        if (complete) return Promise.resolve();
        if (!pending) {
          child?.stdin.end();
          signal('SIGTERM');
          pending = (async () => {
            const deadline = performance.now() + input.shutdownTimeoutMs;
            while (child && (!closed || signal(0)) && performance.now() < deadline) await delay(5);
            if (child && (!closed || signal(0))) {
              signal('SIGKILL');
              const killDeadline = performance.now() + input.shutdownTimeoutMs;
              while ((!closed || signal(0)) && performance.now() < killDeadline) await delay(5);
              if (!closed || signal(0)) throw new Error('Controlled execution did not join.');
            }
            child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
            complete = true;
          })().finally(() => { pending = undefined; });
        }
        return pending;
      },
    };
  } };
}
