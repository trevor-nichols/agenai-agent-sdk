import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AcpConnectionStreams } from '@agen-ai/provider-acp';
import type { NodeAcpExecutionBoundary, NodeAcpExecutionInput, NodeAcpExecutionReservation } from '@agen-ai/provider-acp/node';

/** This fixture owns one known peer which never creates children. It does not qualify arbitrary process containment. */
export function createControlledPeerOwner(expected: NodeAcpExecutionInput) {
  let reservations = 0;
  let starts = 0;
  let joinedReleases = 0;
  const boundary: NodeAcpExecutionBoundary = {
    reserve(input) {
      reservations += 1;
      assert.deepEqual(input, expected);
      assert.ok(Object.isFrozen(input) && Object.isFrozen(input.args) && Object.isFrozen(input.env));
      let fenced = false;
      let child: ChildProcessWithoutNullStreams | undefined;
      let startup: Promise<AcpConnectionStreams> | undefined;
      let closed: Promise<void> | undefined;
      let releasePromise: Promise<void> | undefined;
      let released = false;
      const reservation: NodeAcpExecutionReservation = {
        start(context) {
          assert.equal(fenced, false, 'A released reservation cannot start.');
          assert.equal(startup, undefined, 'A reservation cannot start twice.');
          context.signal?.throwIfAborted();
          starts += 1;
          const owned = spawn(input.executable, [...input.args], {
            cwd: input.cwd, env: { ...input.env }, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          });
          child = owned;
          closed = new Promise<void>((resolve) => { owned.once('close', () => resolve()); });
          startup = new Promise<AcpConnectionStreams>((resolve, reject) => {
            const abort = () => reject(context.signal?.reason);
            owned.once('spawn', () => {
              if (context.signal?.aborted) abort();
              else resolve({ stdin: owned.stdin, stdout: owned.stdout, stderr: owned.stderr });
            });
            owned.on('error', reject);
            owned.once('close', () => {
              owned.off('error', reject);
              context.signal?.removeEventListener('abort', abort);
            });
            context.signal?.addEventListener('abort', abort, { once: true });
            if (context.signal?.aborted) abort();
          });
          return startup;
        },
        release() {
          fenced = true;
          if (released) return Promise.resolve();
          if (releasePromise) return releasePromise;
          child?.kill('SIGKILL');
          releasePromise = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                Promise.all([startup?.catch(() => {}), closed]),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => reject(new Error('Controlled peer startup and exit did not join.')), input.shutdownTimeoutMs);
                }),
              ]);
              if (child?.pid !== undefined) {
                assert.throws(() => process.kill(child!.pid!, 0), { code: 'ESRCH' });
                assert.throws(() => process.kill(-child!.pid!, 0), { code: 'ESRCH' });
              }
              released = true;
              joinedReleases += 1;
            } finally { if (timer) clearTimeout(timer); }
          })().catch((error: unknown) => { releasePromise = undefined; throw error; });
          return releasePromise;
        },
      };
      return Object.freeze(reservation);
    },
  };
  return { boundary, observations: () => ({ reservations, starts, joinedReleases }) };
}
