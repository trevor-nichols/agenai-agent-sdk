// ------------------------------------------------------------------------------------------------
//                lifetime.test.ts - Caller-owned execution lifetime - Public owner behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SandboxOperationError, SandboxValidationError, parseSandboxRequest, withSandbox } from '../src/index.js';
import type { SandboxExecutionPolicy, SandboxRequestInput } from '../src/index.js';
import { fixture, gate, inputFile, nextTurn, processSpec, request } from './fixtures/backend.js';

const bounded = { timeout: 3000 };
const recovery = { kind: 'in_process' as const };
const day = 24 * 60 * 60 * 1000;

function input(execution?: SandboxExecutionPolicy): SandboxRequestInput {
  const { resources, temporaryStorage, network, transfers, streams } = request().policy;
  return { policy: { resources, temporaryStorage, network, transfers, streams,
    deadlines: { startupMs: 1000, cleanupMs: 1000 },
    ...(execution === undefined ? {} : { execution }),
  } };
}

function clock(context: TestContext) {
  let now = 0;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.mock.method(performance, 'now', () => now);
  context.mock.method(Date, 'now', () => now);
  return async (milliseconds: number) => {
    now += milliseconds;
    context.mock.timers.tick(milliseconds);
    await nextTurn();
  };
}

test('execution defaults to until-stopped and finite duration admission has no application ceiling', () => {
  assert.deepEqual(parseSandboxRequest(input()).policy.execution, { kind: 'until_stopped' });
  assert.deepEqual(parseSandboxRequest(input({ kind: 'until_stopped' })).policy.execution, { kind: 'until_stopped' });
  for (const timeoutMs of [1, 3 * day, 30 * day, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(parseSandboxRequest(input({ kind: 'deadline', timeoutMs })).policy.execution, { kind: 'deadline', timeoutMs });
  }
  for (const execution of [{ kind: 'deadline', timeoutMs: 0 }, { kind: 'deadline', timeoutMs: -1 },
    { kind: 'deadline', timeoutMs: 1.5 }, { kind: 'deadline', timeoutMs: Infinity },
    { kind: 'deadline', timeoutMs: Number.MAX_SAFE_INTEGER + 1 }, { kind: 'until_stopped', timeoutMs: 10 }, null]) {
    assert.throws(() => parseSandboxRequest({ policy: { ...input().policy, execution } }), SandboxValidationError);
  }
  assert.throws(() => parseSandboxRequest({ policy: { ...input().policy,
    deadlines: { ...input().policy.deadlines, executionMs: 300_000 } } }), SandboxValidationError);
});

for (const selection of ['omitted', 'explicit'] as const) {
  test(`${selection} until-stopped execution preserves live binary streams across simulated days until explicit close`, bounded, async (context) => {
    const advance = clock(context);
    const physical = fixture();
    const owner = physical.backend.reserve(input(selection === 'explicit' ? { kind: 'until_stopped' } : undefined), recovery);
    try {
      const sandbox = await owner.start();
      const streams = await sandbox.reserveProcess(processSpec).start();
      await advance(7 * day);
      assert.equal(sandbox.state.kind, 'ready');
      assert.equal(physical.resources.has('compute'), true);
      const received = new Promise<Buffer>((resolve) => streams.stdout.once('data', (chunk: Buffer) => resolve(chunk)));
      await new Promise<void>((resolve, reject) => streams.stdin.write(Buffer.from([0, 255, 17]), (error) => error ? reject(error) : resolve()));
      assert.deepEqual(await received, Buffer.from([0, 255, 17]));
      await sandbox.stop();
      assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
      assert.deepEqual([...physical.resources], ['storage']);
    } finally { await owner.destroy(); }
    assert.deepEqual([...physical.resources], []);
  });
}

for (const timeoutMs of [3 * day, 2_147_483_647 + 2000]) {
  test(`an explicit ${timeoutMs}ms execution deadline stops the workload only after its full duration`, bounded, async (context) => {
    const advance = clock(context);
    const physical = fixture();
    const owner = physical.backend.reserve(input({ kind: 'deadline', timeoutMs }), recovery);
    try {
      const sandbox = await owner.start();
      const streams = await sandbox.reserveProcess(processSpec).start();
      await advance(timeoutMs - 1);
      assert.equal(physical.resources.has('compute'), true);
      assert.equal(sandbox.state.kind, 'ready');
      await advance(1);
      await physical.stopping.promise;
      await sandbox.stop();
      assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
      assert.deepEqual([...physical.resources], ['storage']);
    } finally { await owner.destroy(); }
    assert.deepEqual([...physical.resources], []);
  });
}

test('a scoped callback has no implicit deadline and caller abort destroys its environment without accepting a late result', bounded, async (context) => {
  const advance = clock(context);
  const physical = fixture();
  const entered = gate(); const release = gate();
  const controller = new AbortController();
  let completed = false;
  const run = withSandbox(physical.backend, input(), async (sandbox) => {
    await sandbox.reserveProcess(processSpec).start();
    entered.resolve();
    return release.promise;
  }, { recovery, signal: controller.signal });
  void run.then(() => { completed = true; }, () => { completed = true; });
  const cancelled = assert.rejects(run, (error: unknown) => error instanceof SandboxOperationError && error.code === 'cancelled');
  try {
    await entered.promise;
    await advance(7 * day);
    assert.equal(completed, false);
    assert.equal(physical.resources.has('compute'), true);
    controller.abort();
    await cancelled;
    assert.deepEqual([...physical.resources], []);
  } finally { controller.abort(); release.resolve(); await run.catch(() => {}); }
  await nextTurn();
  assert.deepEqual([...physical.resources], []);
});

test('a scoped callback honors an explicit deadline beyond the Node timer range without overflow', bounded, async (context) => {
  const advance = clock(context);
  const physical = fixture();
  const entered = gate(); const release = gate();
  const timeoutMs = 30 * day;
  const run = withSandbox(physical.backend, input({ kind: 'deadline', timeoutMs }), async () => {
    entered.resolve(); return release.promise;
  }, { recovery });
  const expired = assert.rejects(run, (error: unknown) => error instanceof SandboxOperationError && error.code === 'deadline_exceeded');
  try {
    await entered.promise;
    await advance(timeoutMs - 1);
    assert.equal(physical.resources.has('compute'), true);
    await advance(1);
    await expired;
    assert.deepEqual([...physical.resources], []);
  } finally { release.resolve(); await run.catch(() => {}); }
});

test('caller-selected transfer deadline retains cleanup ownership independently of execution', bounded, async (context) => {
  const advance = clock(context);
  const pending = gate();
  const physical = fixture({ importGate: pending.promise });
  const owner = physical.backend.reserve(input(), recovery);
  try {
    const sandbox = await owner.start();
    const importing = sandbox.importTree([inputFile('pending')], { deadlineAt: new Date(Date.now() + 1000).toISOString() });
    const expired = assert.rejects(importing, (error: unknown) => error instanceof SandboxOperationError && error.code === 'deadline_exceeded');
    await physical.importing.promise;
    await advance(1000);
    await expired;
    await sandbox.stop();
    assert.deepEqual([...physical.files], []);
    assert.deepEqual([...physical.resources], ['storage']);
  } finally { pending.resolve(); await owner.destroy(); }
  assert.deepEqual([...physical.resources], []);
});

test('an import has no implicit duration and an explicit long transfer deadline uses sliced timers', bounded, async (context) => {
  const advance = clock(context);
  for (const deadline of ['omitted', 'finite'] as const) {
    const pending = gate();
    const physical = fixture({ importGate: pending.promise });
    const owner = physical.backend.reserve(input(), recovery);
    const timeoutMs = 30 * day;
    try {
      const sandbox = await owner.start();
      let completed = false;
      const importing = sandbox.importTree([inputFile('retained')], deadline === 'omitted' ? undefined
        : { deadlineAt: new Date(Date.now() + timeoutMs).toISOString() });
      void importing.then(() => { completed = true; }, () => { completed = true; });
      const expired = deadline === 'finite'
        ? assert.rejects(importing, (error: unknown) => error instanceof SandboxOperationError && error.code === 'deadline_exceeded') : undefined;
      await physical.importing.promise;
      await advance(timeoutMs - 1);
      assert.equal(completed, false);
      assert.equal(physical.resources.has('compute'), true);
      if (deadline === 'finite') {
        await advance(1); await expired; await sandbox.stop();
        assert.deepEqual([...physical.resources], ['storage']);
      } else {
        await advance(timeoutMs);
        assert.equal(completed, false);
        pending.resolve();
        assert.equal((await importing).payloadBytes, 8n);
        assert.deepEqual(physical.files.get('input.txt'), Buffer.from('retained'));
      }
    } finally { pending.resolve(); await owner.destroy(); }
    assert.deepEqual([...physical.resources], []);
  }
});
