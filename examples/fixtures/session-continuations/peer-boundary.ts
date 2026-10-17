import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { NodeAcpExecutionBoundary } from '@agen-ai/provider-acp/node';

function absent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ESRCH';
}

export function assertPeerGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), absent, 'The owned peer process must be gone after SDK close.');
  assert.throws(() => process.kill(-pid, 0), absent, 'The owned peer process group must also be gone.');
}

// This boundary is sufficient only for the bundled inspected peer, which creates no descendants.
// A production provider needs a boundary that owns all descendants, including detached workloads.
export function controlledPeerBoundary(): NodeAcpExecutionBoundary {
  return { reserve(input) {
    let child: ChildProcessWithoutNullStreams | undefined;
    let stopped = false;
    let closed = false;
    let released = false;
    let releasing: Promise<void> | undefined;
    let groupGone = false;
    function signal(value: NodeJS.Signals | 0): boolean {
      if (!child?.pid || groupGone) return false;
      try { process.kill(-child.pid, value); return true; }
      catch (cause) {
        if (!absent(cause)) throw cause;
        groupGone = true;
        return false;
      }
    }
    async function joined(): Promise<boolean> {
      const deadline = performance.now() + input.shutdownTimeoutMs;
      while (child && (!closed || signal(0))) {
        if (performance.now() >= deadline) return false;
        await delay(5);
      }
      return true;
    }
    return {
      start(context) {
        context.signal?.throwIfAborted();
        assert.equal(stopped || child !== undefined, false);
        child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: { ...input.env },
          detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('error', () => {});
        child.once('close', () => { closed = true; });
        return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr };
      },
      release() {
        stopped = true;
        if (released) return Promise.resolve();
        if (!releasing) releasing = (async () => {
          child?.stdin.end();
          signal('SIGTERM');
          if (!await joined()) {
            signal('SIGKILL');
            if (!await joined()) throw new Error('The controlled peer did not join. Retain this reservation and retry release.');
          }
          child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
          released = true;
        })().finally(() => { releasing = undefined; });
        return releasing;
      },
    };
  } };
}
