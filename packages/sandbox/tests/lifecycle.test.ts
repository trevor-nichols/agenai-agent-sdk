// ------------------------------------------------------------------------------------------------
//                lifecycle.test.ts - Public lifecycle behavior - Controlled resource fixtures
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxCleanupError, SandboxOperationError, SandboxRunError, SandboxStartError, SandboxStateError, SandboxUnsupportedError, SandboxValidationError,
  parseSandboxRelativePath, withSandbox } from '../src/index.js';
import { parseSandboxRecoveryRecord } from '../src/index.js';
import type { SandboxRecoveryRecord, SandboxReconciliation, SandboxRequest } from '../src/index.js';
import { createSandboxBackend } from '../src/backend/index.js';
import { artifactPath, exportFiles, fixture, gate, inputFile, nextTurn, processSpec, request } from './fixtures/backend.js';

const inProcess = Object.freeze({ kind: 'in_process' as const });
const bounded = { timeout: 3000 };

test('required workspace disk quota rejects before driver reservation while ordinary work remains usable', bounded, async () => {
  const physical = fixture();
  const admitted: SandboxRequest[] = [];
  const backend = createSandboxBackend({ ...physical.driver, reserve(value) { admitted.push(value); return physical.driver.reserve(value); } });
  for (const bytes of [1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => backend.reserve({ policy: { ...request().policy,
      workspaceDiskQuota: { kind: 'required', bytes, accounting: 'allocated_blocks' } } }, inProcess), SandboxUnsupportedError);
  }
  assert.equal(admitted.length, 0);
  assert.deepEqual([...physical.resources], []);
  const owner = backend.reserve(request(), inProcess);
  assert.deepEqual(admitted.map((value) => value.policy.workspaceDiskQuota), [{ kind: 'not_requested' }]);
  const sandbox = await owner.start();
  try {
    assert.deepEqual(sandbox.effective.workspaceDiskQuota, { kind: 'not_requested' });
    await sandbox.importTree([inputFile('ordinary workspace remains writable')]);
    assert.deepEqual([...physical.files], [['input.txt', Buffer.from('ordinary workspace remains writable')]]);
  } finally { await owner.destroy(); }
  assert.deepEqual([...physical.resources], []);
});

test('recovery v2 rejects legacy and missing configuration identity before driver reconciliation', bounded, async () => {
  const physical = fixture();
  const original = physical.backend.reserve(request(), inProcess).recoveryRecord;
  let reconciliations = 0;
  const backend = createSandboxBackend({ ...physical.driver, async reconcile(record, options) {
    reconciliations += 1; return physical.driver.reconcile(record, options);
  } });
  const { configurationDigest, ...legacy } = original;
  void configurationDigest;
  // @ts-expect-error A legacy format cannot carry current recovery authority.
  await assert.rejects(backend.reconcile({ ...legacy, format: 'agenai.sandbox-recovery.v1' }), SandboxValidationError);
  // @ts-expect-error Current recovery records require the complete backend configuration identity.
  await assert.rejects(backend.reconcile({ ...legacy, format: 'agenai.sandbox-recovery.v2' }), SandboxValidationError);
  await assert.rejects(backend.reconcile({ ...original, configurationDigest: 'sha256:invalid' }), SandboxValidationError);
  assert.equal(reconciliations, 0);
  assert.deepEqual([...physical.resources], []);
  const result = await backend.reconcile(original);
  assert.equal(reconciliations, 1);
  assert.equal(result.kind, 'matched');
  if (result.kind !== 'matched') throw new Error('Expected exact current recovery to retain its cleanup owner.');
  await result.owner.destroy();
  assert.deepEqual([...physical.resources], []);
});

// Each case exercises public owners against an independently retained physical-resource port.
test('failed initial persistence prevents acquisition and retains a usable cleanup owner', bounded, async () => {
  const physical = fixture();
  const failure = new Error('disk full');
  const owner = physical.backend.reserve(request(), { kind: 'persisted', async persist() { throw failure; } });
  await assert.rejects(owner.start(), (error: unknown) => {
    assert.ok(error instanceof SandboxStartError);
    assert.equal(error.owner, owner);
    assert.ok(error.cause instanceof SandboxOperationError);
    assert.equal(error.cause.code, 'persistence_failure');
    assert.equal(error.cause.cause, failure);
    return true;
  });
  assert.deepEqual([...physical.resources], []);
  await owner.destroy();
  assert.equal(owner.state.kind, 'destroyed');
  assert.deepEqual([...physical.resources], []);
});

test('checkpoints settle serially before effects and cleanup survives persistence failure after acquisition', bounded, async () => {
  const physical = fixture();
  const beforeAcquisition = gate(); const entered = gate();
  const phases: string[] = [];
  const owner = physical.backend.reserve(request(), { kind: 'persisted', async persist(record) {
    phases.push(`${record.phase}:${record.resources[0]?.identity.kind}`);
    if (phases.length === 2) { entered.resolve(); await beforeAcquisition.promise; }
    if (record.resources.some((resource) => resource.identity.kind === 'identified')) throw new Error('durable write failed after create');
  } });
  const startup = owner.start();
  const rejected = assert.rejects(startup, SandboxStartError);
  await entered.promise;
  assert.deepEqual([...physical.resources], []);
  assert.deepEqual(phases, ['reserved:planned', 'starting:planned']);
  beforeAcquisition.resolve();
  await rejected;
  assert.deepEqual([...physical.resources], ['storage']);
  assert.deepEqual(owner.recoveryRecord.resources.map((resource) => resource.identity.kind), ['identified', 'identified']);
  await owner.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('malformed and replaced checkpoints fence launch while retaining every acquired identity', bounded, async () => {
  for (const options of [{ malformedCheckpoint: true }, { changedCheckpointIdentity: 'operationId' }, { changedCheckpointIdentity: 'configurationDigest' }] as const) {
    const physical = fixture(options);
    const owner = physical.backend.reserve(request(), inProcess);
    await assert.rejects(owner.start(), SandboxStartError);
    assert.equal(physical.processStarted, false);
    assert.deepEqual([...physical.resources], ['storage']);
    assert.equal(owner.recoveryRecord.operationId, 'operation-1');
    assert.equal(owner.recoveryRecord.configurationDigest, `sha256:${'3'.repeat(64)}`);
    await owner.destroy();
    assert.deepEqual([...physical.resources], []);
  }
});

test('cancelled startup never returns a usable late sandbox and cleanup retains the pending actual operation', bounded, async () => {
  const late = gate();
  const physical = fixture({ startupReply: late.promise });
  const owner = physical.backend.reserve(request({ cleanupMs: 15 }), inProcess);
  const controller = new AbortController();
  const startup = owner.start({ signal: controller.signal });
  const rejected = assert.rejects(startup, (error: unknown) => {
    assert.ok(error instanceof SandboxStartError);
    assert.ok(error.cause instanceof SandboxOperationError);
    assert.equal(error.cause.code, 'cancelled'); return true;
  });
  await physical.acquired.promise;
  controller.abort();
  await rejected;
  await physical.stopping.promise;
  await nextTurn();
  assert.deepEqual([...physical.resources], ['storage']);
  let original: SandboxCleanupError | undefined;
  await assert.rejects(owner.destroy(), (error: unknown) => {
    assert.ok(error instanceof SandboxCleanupError); original = error;
    assert.equal(error.owner, owner); return true;
  });
  assert.deepEqual([...physical.resources], ['storage']);
  assert.equal(physical.destroyAttempts, 0);
  late.resolve();
  await owner.destroy();
  assert.equal(original?.name, 'SandboxCleanupError');
  assert.deepEqual([...physical.resources], []);
  await assert.rejects(owner.start(), SandboxStateError);
});

test('concurrent stop and destroy join actual cleanup across observation timeout without replay', bounded, async () => {
  const stopped = gate();
  const physical = fixture({ stopGate: stopped.promise });
  const owner = physical.backend.reserve(request({ cleanupMs: 15 }), inProcess);
  const sandbox = await owner.start();
  const stoppedObservation = sandbox.stop();
  const destroyedObservation = sandbox.destroy();
  const failures = await Promise.allSettled([stoppedObservation, destroyedObservation, sandbox.destroy()]);
  assert.deepEqual(failures.map((result) => result.status), ['rejected', 'rejected', 'rejected']);
  assert.deepEqual([...physical.resources].sort(), ['compute', 'storage']);
  assert.equal(physical.stopAttempts, 1);
  const retry = sandbox.destroy();
  stopped.resolve();
  await retry;
  assert.deepEqual([...physical.resources], []);
  assert.equal(physical.stopAttempts, 1);
  assert.equal(physical.destroyAttempts, 1);
});

test('elapsed startup deadline stops compute while retaining the late physical startup task', bounded, async () => {
  const late = gate(); const physical = fixture({ startupReply: late.promise });
  const owner = physical.backend.reserve(request({ startupMs: 15, cleanupMs: 15 }), inProcess);
  const started = owner.start();
  const rejected = assert.rejects(started, (error: unknown) => {
    assert.ok(error instanceof SandboxStartError);
    assert.ok(error.cause instanceof SandboxOperationError); assert.equal(error.cause.code, 'deadline_exceeded'); return true;
  });
  await physical.acquired.promise; await rejected;
  assert.deepEqual([...physical.resources], ['storage']);
  const destroyed = owner.destroy();
  late.resolve(); await destroyed;
  assert.deepEqual([...physical.resources], []);
});

test('process cancellation owns a late stream result and never replays its start', bounded, async () => {
  const late = gate(); const physical = fixture({ processReply: late.promise });
  const sandbox = await physical.backend.reserve(request({ cleanupMs: 15 }), inProcess).start();
  const process = sandbox.reserveProcess(processSpec);
  const controller = new AbortController();
  const started = process.start({ signal: controller.signal });
  const rejected = assert.rejects(started, (error: unknown) => {
    assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'cancelled'); return true;
  });
  await physical.processEntered.promise; controller.abort(); await rejected;
  assert.deepEqual([...physical.resources], ['storage']);
  await assert.rejects(sandbox.destroy(), SandboxCleanupError);
  assert.equal(physical.destroyAttempts, 0);
  late.resolve(); await sandbox.destroy();
  assert.deepEqual([...physical.resources], []);
  await assert.rejects(process.start(), SandboxStateError);
});

test('already cancelled sandbox and process openings reject without native effects', bounded, async () => {
  const controller = new AbortController(); controller.abort();
  const initial = fixture();
  const owner = initial.backend.reserve(request(), inProcess);
  await assert.rejects(owner.start({ signal: controller.signal }), SandboxStartError);
  assert.deepEqual([...initial.resources], []);
  await owner.destroy();
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  await assert.rejects(sandbox.reserveProcess(processSpec).start({ signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'cancelled'); return true;
  });
  assert.equal(physical.processStarted, false);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});

test('actual compute or storage cleanup failure can retry against the same resource owner', bounded, async () => {
  for (const options of [{ failFirstStop: true }, { failFirstDestroy: true }]) {
    const physical = fixture(options);
    const owner = physical.backend.reserve(request(), inProcess);
    const sandbox = await owner.start();
    let failure: SandboxCleanupError | undefined;
    await assert.rejects(sandbox.destroy(), (error: unknown) => { assert.ok(error instanceof SandboxCleanupError); failure = error; return true; });
    assert.equal(failure?.owner, owner);
    assert.equal(physical.resources.has('storage'), true);
    await failure?.retryCleanup();
    assert.deepEqual([...physical.resources], []);
    assert.equal(owner.state.kind, 'destroyed');
  }
});

test('withSandbox preserves arbitrary primary values and cleanup failure with the original retry owner', bounded, async () => {
  for (const primary of [undefined, null, 'callback failure', new Error('provider cleanup failed')]) {
    const physical = fixture({ failFirstDestroy: true });
    let retained: SandboxRunError | undefined;
    await assert.rejects(withSandbox(physical.backend, request(), async () => { throw primary; }, { recovery: inProcess }), (error: unknown) => {
      assert.ok(error instanceof SandboxRunError);
      assert.equal(error.primaryError, primary);
      assert.ok(error.cleanupError instanceof SandboxCleanupError);
      retained = error; return true;
    });
    assert.deepEqual([...physical.resources], ['storage']);
    await retained?.retryCleanup();
    assert.deepEqual([...physical.resources], []);
    assert.equal(retained?.primaryError, primary);
  }
});

test('successful later sandbox destruction preserves a callback provider-cleanup error', bounded, async () => {
  const physical = fixture();
  const providerFailure = new Error('provider cleanup still pending');
  await assert.rejects(withSandbox(physical.backend, request(), async () => { throw providerFailure; }, { recovery: inProcess }), (error: unknown) => error === providerFailure);
  assert.deepEqual([...physical.resources], []);
  assert.equal(await withSandbox(fixture().backend, request(), async () => 'complete', { recovery: inProcess }), 'complete');
});

test('leader exit is separate from stop; retained output exports only after compute removal', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  await sandbox.importTree([inputFile('copied input')]);
  physical.files.set(artifactPath, Uint8Array.from([0, 255, 17, 42]));
  const process = sandbox.reserveProcess(processSpec);
  const streams = await process.start();
  physical.leader.resolve({ kind: 'exited', code: 0 });
  assert.deepEqual(await streams.exit, { kind: 'exited', code: 0 });
  assert.equal(physical.resources.has('compute'), true);
  assert.throws(() => sandbox.exportTree({ kind: 'files', paths: [artifactPath] }, async () => {}), SandboxStateError);
  await process.stop();
  assert.deepEqual([...physical.resources], ['storage']);
  assert.deepEqual(await exportFiles(sandbox, [artifactPath]), [{ path: 'artifact.bin', bytes: Uint8Array.from([0, 255, 17, 42]), executable: false }]);
  await assert.rejects(exportFiles(sandbox, [artifactPath, 'missing.bin']), (error: unknown) => {
    assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'driver_failure'); return true;
  });
  await sandbox.destroy();
  assert.deepEqual([...physical.resources], []);
  assert.throws(() => sandbox.exportTree({ kind: 'files', paths: [artifactPath] }, async () => {}), SandboxStateError);
});

test('file admission is synchronous, process reservation closes imports permanently, and destruction aborts export', bounded, async () => {
  const importGate = gate(); const exportGate = gate();
  const physical = fixture({ importGate: importGate.promise, exportGate: exportGate.promise });
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  const importing = sandbox.importTree([inputFile('one input')]);
  await physical.importing.promise;
  assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
  assert.throws(() => sandbox.importTree([inputFile('overlap')]), SandboxStateError);
  importGate.resolve(); await importing;
  sandbox.reserveProcess(processSpec);
  assert.throws(() => sandbox.importTree([inputFile('too late')]), SandboxStateError);
  assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
  assert.equal(physical.processStarted, false);
  assert.equal(physical.importCount, 1);
  await sandbox.stop();
  const exported = exportFiles(sandbox, [parseSandboxRelativePath('input.txt')]);
  const rejected = assert.rejects(exported);
  await physical.exporting.promise;
  assert.throws(() => sandbox.exportTree({ kind: 'files', paths: [artifactPath] }, async () => {}), SandboxStateError);
  await sandbox.destroy(); await rejected;
  assert.deepEqual([...physical.resources], []);
});

test('destroy retains storage until an admitted export actually settles after cancellation', bounded, async () => {
  const released = gate();
  const physical = fixture({ exportGate: released.promise, ignoreFileCancellation: true });
  const sandbox = await physical.backend.reserve(request({ cleanupMs: 15 }), inProcess).start();
  physical.files.set(artifactPath, Uint8Array.from([19, 23]));
  await sandbox.stop();
  const exported = exportFiles(sandbox, [artifactPath]);
  const rejected = assert.rejects(exported, (error: unknown) => {
    assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'cancelled'); return true;
  });
  await physical.exporting.promise;
  await assert.rejects(sandbox.destroy(), SandboxCleanupError); await rejected;
  assert.deepEqual([...physical.resources], ['storage']);
  assert.equal(physical.destroyAttempts, 0);
  released.resolve(); await sandbox.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('stop aborts import before joining it and prevents publication of partial inputs', bounded, async () => {
  const pending = gate(); const physical = fixture({ importGate: pending.promise });
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  const imported = sandbox.importTree([inputFile('not published')]);
  const rejected = assert.rejects(imported, (error: unknown) => {
    assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'cancelled'); return true;
  });
  await physical.importing.promise;
  await sandbox.stop(); await rejected;
  assert.deepEqual([...physical.resources], ['storage']);
  assert.deepEqual([...physical.files], []);
  assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});

test('unsupported policy, malformed recipe, and second process reject before native start effects', bounded, async () => {
  const physical = fixture();
  const unsupported = { policy: { ...request().policy, network: { kind: 'outbound' as const } } };
  assert.throws(() => physical.backend.reserve(unsupported, inProcess), SandboxUnsupportedError);
  assert.deepEqual([...physical.resources], []);
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  assert.throws(() => sandbox.reserveProcess({ ...processSpec, env: { INVALID: 'contains\0NUL' } }));
  assert.equal(physical.processStarted, false);
  const process = sandbox.reserveProcess(processSpec);
  assert.throws(() => sandbox.reserveProcess(processSpec), SandboxStateError);
  await process.start();
  await assert.rejects(process.start(), SandboxStateError);
  assert.equal(physical.processStarted, true);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});

test('read-only reconciliation returns a cleanup-only owner that preserves stop and storage disposal', bounded, async () => {
  const physical = fixture({ failFirstDestroy: true });
  const original = physical.backend.reserve(request(), inProcess);
  await original.start();
  const backend = createSandboxBackend(physical.driver);
  const result = await backend.reconcile(original.recoveryRecord);
  assert.equal(result.kind, 'matched');
  if (result.kind !== 'matched') throw new Error('expected matched recovery');
  assert.equal('start' in result.owner, false);
  await assert.rejects(result.owner.destroy(), SandboxCleanupError);
  assert.deepEqual([...physical.resources], ['storage']);
  await result.owner.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('reconciliation preserves exact retained identities and rejects false absence before cleanup effects', bounded, async () => {
  const physical = fixture();
  const original = physical.backend.reserve(request(), inProcess);
  const untouched = original.recoveryRecord;
  await original.start();
  const retained = original.recoveryRecord;
  const native = await physical.driver.reconcile(retained);
  if (native.kind !== 'matched') throw new Error('Expected a matched physical cleanup owner.');
  const observed = (record: SandboxRecoveryRecord, kind: 'matched' | 'uncertain' = 'matched'): SandboxReconciliation => ({
    kind, owner: { recoveryRecord: record, stop: () => native.owner.stop(), destroy: () => native.owner.destroy() },
  });
  const backendReturning = (result: SandboxReconciliation) => createSandboxBackend({ ...physical.driver, async reconcile() { return result; } });
  const replacementDigest = `sha256:${'2'.repeat(64)}`;
  const changedRecords = [
    { ...retained, imageDigest: replacementDigest },
    { ...retained, policyDigest: replacementDigest },
    { ...retained, configurationDigest: replacementDigest },
    { ...retained, authority: { kind: 'verified', backendIdentity: 'another-engine' } },
    { ...retained, authority: { kind: 'unverified' }, phase: 'reserved', resources: untouched.resources },
    { ...retained, resources: retained.resources.slice(1) },
    ...['name', 'id', 'fingerprint'].map((field) => ({ ...retained, resources: retained.resources.map((resource, index) => index !== 0 ? resource : {
      ...resource,
      ...(field === 'name' ? { name: 'replacement-compute' } : { identity: {
        kind: 'identified', id: field === 'id' ? 'replacement-id' : 'compute-id-1',
        fingerprint: field === 'fingerprint' ? replacementDigest : retained.imageDigest,
      } }),
    }) })),
  ].map(parseSandboxRecoveryRecord);
  try {
    for (const changed of changedRecords) {
      for (const kind of ['matched', 'uncertain'] as const) {
        await assert.rejects(backendReturning(observed(changed, kind)).reconcile(retained), SandboxStateError);
      }
      await assert.rejects(backendReturning({ kind: 'absent', record: changed }).reconcile(retained), SandboxStateError);
      assert.deepEqual([...physical.resources].sort(), ['compute', 'storage']);
    }
    const entered = parseSandboxRecoveryRecord({ ...retained, phase: 'starting', resources: retained.resources.map((resource) => ({ ...resource, identity: { kind: 'creating' } })) });
    await assert.rejects(backendReturning({ kind: 'absent', record: entered }).reconcile(entered), SandboxStateError);
    await assert.rejects(backendReturning(observed(retained)).reconcile(untouched), SandboxStateError);
    await assert.rejects(backendReturning(observed(entered)).reconcile(untouched), SandboxStateError);
    assert.deepEqual([...physical.resources].sort(), ['compute', 'storage']);
    assert.equal(physical.stopAttempts, 0);
    assert.equal(physical.destroyAttempts, 0);
    let cleanupRecord = retained;
    const cleanupResult: SandboxReconciliation = { kind: 'matched', owner: {
      get recoveryRecord() { return cleanupRecord; }, stop: () => native.owner.stop(), destroy: () => native.owner.destroy(),
    } };
    const matched = await backendReturning(cleanupResult).reconcile(entered);
    assert.equal(matched.kind, 'matched');
    if (matched.kind !== 'matched') throw new Error('Expected entered acquisition to resolve its exact observed identities.');
    assert.deepEqual(matched.owner.recoveryRecord.resources.map((resource) => resource.identity), [
      { kind: 'identified', id: 'compute-id-1', fingerprint: retained.imageDigest },
      { kind: 'identified', id: 'storage-id-1', fingerprint: retained.imageDigest },
    ]);
    cleanupRecord = parseSandboxRecoveryRecord({ ...retained, imageDigest: replacementDigest });
    await assert.rejects(matched.owner.destroy(), SandboxCleanupError);
    assert.deepEqual([...physical.resources].sort(), ['compute', 'storage']);
    assert.equal(physical.stopAttempts, 0);
    cleanupRecord = retained;
    await matched.owner.destroy();
    assert.deepEqual([...physical.resources], []);
    const absentRecord = parseSandboxRecoveryRecord({ ...retained, phase: 'destroyed' });
    assert.deepEqual(await backendReturning({ kind: 'absent', record: absentRecord }).reconcile(retained), { kind: 'absent', record: absentRecord });
    assert.deepEqual(await backendReturning({ kind: 'absent', record: untouched }).reconcile(untouched), { kind: 'absent', record: untouched });
  } finally { await original.destroy(); }
});
