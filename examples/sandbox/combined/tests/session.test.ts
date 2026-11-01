import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { SandboxOperationError } from '@agen-ai/sandbox';
import type { SandboxProcessExit } from '@agen-ai/sandbox';
import { CombinedProgramSession } from '../session.js';

function session() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const exit = Promise.withResolvers<SandboxProcessExit>();
  return { stdin, stdout, stderr, exit, session: new CombinedProgramSession({ stdin, stdout, stderr, exit: exit.promise }, 1000) };
}

test('a cancel-mode stop with open stdin accepts only the SDK typed cancellation', async () => {
  const stopped = async (reason: Error) => {
    const current = session();
    current.session.beginStop();
    for (const stream of [current.stdin, current.stdout, current.stderr]) stream.destroy(reason);
    current.exit.resolve({ kind: 'unavailable', reason: 'sandbox_stopped' });
    return current.session.settle();
  };
  assert.equal(await stopped(new SandboxOperationError('cancelled', 'Sandbox compute is stopping.')), undefined);
  const raw = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
  assert.deepEqual((await stopped(raw))?.errors, [raw, raw, raw]);
});

test('a typed stdin closure before stop remains a session failure', async () => {
  const current = session();
  const closed = new SandboxOperationError('cancelled', 'Sandbox compute is stopping.');
  current.stdin.destroy(closed);
  await new Promise<void>((resolve) => setImmediate(resolve));
  current.session.beginStop(); current.stdout.end(); current.stderr.end();
  assert.deepEqual((await current.session.settle())?.errors, [closed]);
});
