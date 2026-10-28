import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxCleanupError } from '@agen-ai/sandbox';
import { runSandboxCli, SandboxCliRunError } from '../index.js';
import { createCredentialFixture } from './fixture.js';

async function reserve(physical: ReturnType<typeof createCredentialFixture>) {
  const sandbox = await physical.owner.start();
  return sandbox.reserveProcess({ executable: '/opt/agenai/native/fixture', args: [], env: {}, cwd: sandbox.workspace });
}

test('direct CLI consumption keeps native exit truth, bounds output and discards diagnostic content', { timeout: 2000 }, async () => {
  const physical = createCredentialFixture();
  try {
    const result = await runSandboxCli(await reserve(physical), { stdin: 'none' });
    assert.deepEqual(result, { receipt: { kind: 'exited', code: 7 }, stdoutBytes: 22, stderrBytes: 30 });
    assert.equal(Buffer.concat(physical.nativeInput).length, 0);
    assert.equal(physical.stopAttempts, 1); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await physical.owner.destroy(); }
});

test('a leader receipt stops descendants even while their output pipes remain open', { timeout: 2000 }, async () => {
  const physical = createCredentialFixture({ finishOnEof: false });
  try {
    const running = runSandboxCli(await reserve(physical), { stdin: 'none' });
    await physical.eof; physical.exit.resolve({ kind: 'exited', code: 0 });
    assert.deepEqual(await running, { receipt: { kind: 'exited', code: 0 }, stdoutBytes: 0, stderrBytes: 0 });
    assert.equal(physical.stopAttempts, 1); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await physical.owner.destroy(); }
});

test('cancellation stops the original workload and never retains a caller error or fabricates a native signal', { timeout: 2000 }, async () => {
  const physical = createCredentialFixture({ finishOnEof: false }); const controller = new AbortController();
  try {
    const running = runSandboxCli(await reserve(physical), { stdin: 'none', signal: controller.signal });
    await physical.eof; controller.abort(new Error('private-caller-cancellation-text'));
    await assert.rejects(running, (error: unknown) => {
      assert(error instanceof SandboxCliRunError); assert.equal(error.code, 'cancelled');
      assert.deepEqual(error.receipt, { kind: 'unavailable', reason: 'sandbox_stopped' });
      assert(!String(error).includes('private-caller-cancellation-text')); assert.equal(error.cause, undefined); return true;
    });
    assert.deepEqual([...physical.resources], ['storage']); assert.equal(physical.stopAttempts, 1);
  } finally { await physical.owner.destroy(); }
});

test('stderr exhaustion stops the same owner without retaining raw bytes', { timeout: 2000 }, async () => {
  const physical = createCredentialFixture({ finishOnEof: false });
  try {
    const running = runSandboxCli(await reserve(physical), { stdin: 'none' });
    await physical.eof; physical.stderr.push(Buffer.alloc(1024 * 1024 + 1, 0xa5));
    await assert.rejects(running, (error: unknown) => {
      assert(error instanceof SandboxCliRunError); assert.equal(error.code, 'output_limit');
      assert.deepEqual(error.receipt, { kind: 'unavailable', reason: 'sandbox_stopped' }); return true;
    });
    assert.equal(physical.stopAttempts, 1); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await physical.owner.destroy(); }
});

test('failed whole-owner stop preserves its original cleanup owner, leader receipt and explicit retry', { timeout: 2000 }, async () => {
  const physical = createCredentialFixture({ firstStopFails: true });
  try {
    let retained: SandboxCliRunError | undefined;
    await assert.rejects(runSandboxCli(await reserve(physical), { stdin: 'none' }), (error: unknown) => {
      assert(error instanceof SandboxCliRunError); assert.equal(error.code, 'cleanup_failed');
      assert.deepEqual(error.receipt, { kind: 'exited', code: 7 });
      assert(error.cleanupFailure instanceof SandboxCleanupError); assert.equal(error.cleanupFailure.owner, physical.owner);
      assert.deepEqual([...physical.resources], ['compute', 'storage']);
      assert(!JSON.stringify(error).includes('Controlled original cleanup failure'));
      retained = error; return true;
    });
    assert(retained); await retained.retryCleanup();
    assert.deepEqual([...physical.resources], ['storage']); assert.equal(physical.stopAttempts, 2);
  } finally { await physical.owner.destroy(); }
});

test('failed cancellation cleanup returns retry ownership even when the original leader has no receipt yet', { timeout: 2000 }, async () => {
  const physical = createCredentialFixture({ firstStopFails: true, finishOnEof: false });
  const controller = new AbortController();
  try {
    const running = runSandboxCli(await reserve(physical), { stdin: 'none', signal: controller.signal });
    await physical.eof; controller.abort();
    let retained: SandboxCliRunError | undefined;
    await assert.rejects(running, (error: unknown) => {
      assert(error instanceof SandboxCliRunError); assert.equal(error.code, 'cancelled'); assert.equal(error.receipt, undefined);
      assert(error.cleanupFailure instanceof SandboxCleanupError); assert.equal(error.cleanupFailure.owner, physical.owner);
      retained = error; return true;
    });
    assert.equal(physical.stopAttempts, 1); assert.deepEqual([...physical.resources], ['compute', 'storage']);
    assert(retained); await retained.retryCleanup();
    assert.equal(physical.stopAttempts, 2); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await physical.owner.destroy(); }
});
