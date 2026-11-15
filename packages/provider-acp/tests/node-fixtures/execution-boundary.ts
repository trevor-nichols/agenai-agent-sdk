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
    let groupGone = false;
    const signal = (value: NodeJS.Signals | 0): boolean => {
      if (groupGone || !child?.pid) return false;
      try { process.kill(-child.pid, value); return true; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          groupGone = true;
          return false;
        }
        throw error;
      }
    };
    const signalAndWait = async (initialSignal: NodeJS.Signals): Promise<boolean> => {
      if (!child) return true;
      let nextSignal: NodeJS.Signals | 0 = initialSignal;
      let pendingSignalError: Error | undefined;
      const deadline = performance.now() + input.shutdownTimeoutMs;
      for (;;) {
        try {
          if (!signal(nextSignal) && closed) return true;
        } catch (error) {
          if (closed || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error;
          // Darwin can deny signals before reaping; only close plus ESRCH proves cleanup.
          pendingSignalError = error;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          if (pendingSignalError) throw pendingSignalError;
          return false;
        }
        nextSignal = 0;
        await delay(Math.min(5, remaining));
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
          pending = Promise.resolve().then(async () => {
            child?.stdin.end();
            if (!await signalAndWait('SIGTERM') && !await signalAndWait('SIGKILL')) throw new Error('Controlled execution did not join.');
            child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
            complete = true;
          }).finally(() => { pending = undefined; });
        }
        return pending;
      },
    };
  } };
}
