// ------------------------------------------------------------------------------------------------
//                resources.test.ts - Observable Docker ownership and recovery - Unix HTTP boundary
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDockerSandboxBackend } from '../src/index.js';
import { SandboxCleanupError, SandboxStartError, SandboxValidationError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { engineFixture, gate, imageDigest, sandboxRequest } from './fixtures/engine.js';

test('constructor and reservation remain inert and reject non-data or implicit authority', () => {
  const config = { endpoint: 'unix:///tmp/absent-agenai-test-engine.sock', namespace: 'inert-test', imageDigest, spillDirectory: '/tmp/absent-agenai-spill', user: { uid: 65534, gid: 65534 } };
  const reservation = createDockerSandboxBackend(config).reserve(sandboxRequest(), { kind: 'in_process' });
  assert.deepEqual(reservation.state, { kind: 'reserved' });
  assert.equal(reservation.recoveryRecord.authority.kind, 'unverified');
  assert.deepEqual(reservation.recoveryRecord.resources.map(({ role, identity }) => [role, identity.kind]), [['compute', 'planned'], ['storage', 'planned'], ['export', 'planned']]);
  let accessorReads = 0;
  const accessor = { ...config, get endpoint() { accessorReads += 1; return config.endpoint; } };
  for (const invalid of [{ ...config, endpoint: 'tcp://127.0.0.1:2375' }, { ...config, extra: true }, { ...config, user: { uid: 0, gid: 1 } },
    { ...config, user: { uid: 262144, gid: 1 } }, { ...config, endpoint: 'unix:///tmp/../engine.sock' }, accessor]) {
    assert.throws(() => createDockerSandboxBackend(invalid), SandboxValidationError);
  }
  assert.equal(accessorReads, 0);
});

test('unsupported daemon and image volumes fail before resource acquisition', async () => {
  for (const options of [{ unsupportedDaemon: true }, { imageVolumes: true }]) {
    const fixture = await engineFixture(options);
    try {
      const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
      await assert.rejects(reservation.start(), SandboxStartError);
      assert.deepEqual(fixture.effects, []);
      assert.equal(reservation.recoveryRecord.resources.every((resource) => resource.identity.kind === 'planned'), true);
      await reservation.destroy();
    } finally { await fixture.close(); }
  }
});

test('workload policy is read back and stop removes compute while retaining the never-started accessor and storage', async () => {
  const fixture = await engineFixture();
  try {
    const persisted: SandboxRecoveryRecord[] = [];
    const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'persisted', async persist(record) { persisted.push(record); } });
    const sandbox = await reservation.start();
    const compute = [...fixture.containers.values()].find((container) => container.Name.endsWith('-compute'));
    assert.ok(compute);
    assert.equal(compute.Config.User, '65534:65534');
    assert.deepEqual(compute.Config.Entrypoint, ['/bin/sh']);
    assert.deepEqual(compute.Config.Env, ['HOME=/home/sandbox', 'TMPDIR=/tmp', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']);
    assert.deepEqual({ cpu: compute.HostConfig.NanoCpus, memory: compute.HostConfig.Memory, swap: compute.HostConfig.MemorySwap,
      pids: compute.HostConfig.PidsLimit, caps: compute.HostConfig.CapDrop, security: compute.HostConfig.SecurityOpt, network: compute.HostConfig.NetworkMode,
      readOnly: compute.HostConfig.ReadonlyRootfs, binds: compute.HostConfig.Binds }, {
      cpu: 500_000_000, memory: 67_108_864, swap: 67_108_864, pids: 32, caps: ['ALL'], security: ['no-new-privileges:true'], network: 'none', readOnly: true, binds: [],
    });
    assert.equal(sandbox.workspace, '/workspace/work');
    assert.deepEqual(sandbox.effective.workspaceDiskQuota, { kind: 'not_requested' });
    for (const role of ['storage', 'compute', 'export']) {
      const sequence = persisted.map((record) => record.resources.find((resource) => resource.role === role)?.identity.kind);
      assert.ok(sequence.indexOf('creating') < sequence.indexOf('identified'));
    }
    await sandbox.stop();
    assert.equal(fixture.containers.has(compute.Id), false);
    assert.deepEqual([...fixture.containers.values()].map((container) => ({ role: container.Name.split('-').at(-1), state: container.State })),
      [{ role: 'export', state: { Running: false, Status: 'created' } }]);
    assert.equal(fixture.volumes.size, 1);
    assert.equal(fixture.effects.filter((effect) => effect.path.endsWith('/start')).length, 1);
    await sandbox.destroy(); await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size }, { containers: 0, volumes: 0, networks: 0 });
  } finally { await fixture.close(); }
});

test('owned outbound bridge is explicit and destroyed independently from retained files', async () => {
  const fixture = await engineFixture();
  try {
    const reservation = fixture.backend.reserve(sandboxRequest('outbound'), { kind: 'in_process' });
    const sandbox = await reservation.start();
    const networkId = [...fixture.networks.keys()][0];
    assert.equal([...fixture.containers.values()].find((container) => container.State.Running)?.HostConfig.NetworkMode, networkId);
    assert.equal(sandbox.effective.network.kind, 'outbound');
    assert.equal(fixture.backend.support.networkAllowlist, false);
    await sandbox.stop();
    assert.equal(fixture.networks.has(networkId), true);
    await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size }, { containers: 0, volumes: 0, networks: 0 });
  } finally { await fixture.close(); }
});

test('daemon normalization of its unsupported OOM default preserves startup and exact cleanup ownership', async () => {
  const fixture = await engineFixture({ normalizeUnsupportedOomOnStart: true });
  try {
    const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    const sandbox = await reservation.start();
    assert.equal([...fixture.containers.values()].find((container) => container.State.Running)?.HostConfig.OomKillDisable, null);
    assert.equal((await fixture.backend.reconcile(reservation.recoveryRecord)).kind, 'matched');
    await sandbox.stop();
    assert.equal([...fixture.containers.values()].some((container) => container.State.Running), false);
    await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { await fixture.close(); }
});

test('a daemon that ignores a requested limit never yields ready execution and still retains cleanup', async () => {
  const fixture = await engineFixture({ ignoreMemory: true });
  try {
    const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    await assert.rejects(reservation.start(), SandboxStartError);
    assert.equal(fixture.effects.filter((effect) => effect.path.endsWith('/start')).length, 0);
    assert.equal(fixture.containers.size, 1);
    await reservation.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { await fixture.close(); }
});

for (const identity of ['creating', 'identified'] as const) {
  test(`persistence failure at storage ${identity} fences startup while physical destruction still completes`, async () => {
    const fixture = await engineFixture();
    try {
      const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'persisted', async persist(record) {
        if (record.resources.some((resource) => resource.role === 'storage' && resource.identity.kind === identity)) throw new Error('store unavailable');
      } });
      await assert.rejects(reservation.start(), SandboxStartError);
      assert.equal(fixture.volumes.size, identity === 'identified' ? 1 : 0);
      assert.equal(fixture.containers.size, 0);
      await reservation.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
    } finally { await fixture.close(); }
  });
}

for (const [role, expected] of [
  ['storage', { containers: 0, volumes: 0, networks: 0 }],
  ['network', { containers: 0, volumes: 1, networks: 0 }],
  ['compute', { containers: 0, volumes: 1, networks: 1 }],
  ['export', { containers: 1, volumes: 1, networks: 1 }],
] as const) {
  test(`cancellation while persisting ${role} creation destroys acquired resources without dispatching the pending create`, { timeout: 5000 }, async () => {
    const persistenceEntered = gate();
    const persistenceReply = gate();
    const controller = new AbortController();
    const fixture = await engineFixture();
    const reservation = fixture.backend.reserve(sandboxRequest('outbound'), { kind: 'persisted', async persist(record) {
      if (record.phase === 'starting' && record.resources.some((resource) => resource.role === role && resource.identity.kind === 'creating')) {
        persistenceEntered.resolve();
        await persistenceReply.promise;
      }
    } });
    try {
      const startup = assert.rejects(reservation.start({ signal: controller.signal }), SandboxStartError);
      await persistenceEntered.promise;
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size }, expected);
      const creates = fixture.effects.filter((effect) => effect.method === 'POST').length;
      controller.abort();
      const destroyed = reservation.destroy();
      void destroyed.catch(() => {});
      persistenceReply.resolve();
      await startup;
      await destroyed;
      await reservation.destroy();
      assert.deepEqual(reservation.state, { kind: 'destroyed' });
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size }, { containers: 0, volumes: 0, networks: 0 });
      assert.equal(fixture.effects.filter((effect) => effect.method === 'POST').length, creates);
    } finally { persistenceReply.resolve(); await fixture.close(); }
  });
}

test('stop joins a late compute creation and permanently removes its exact ID', async () => {
  const delayedReply = gate();
  const fixture = await engineFixture({ pauseComputeCreate: delayedReply });
  try {
    const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    const startup = reservation.start().then(() => 'ready', () => 'failed');
    await fixture.computeCreating.promise;
    let stopped = false;
    const stop = reservation.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(fixture.containers.size, 1);
    delayedReply.resolve();
    assert.equal(await startup, 'failed');
    await stop;
    assert.equal(fixture.containers.size, 0);
    assert.equal(fixture.effects.filter((effect) => effect.path.endsWith('/start')).length, 0);
    assert.equal(fixture.volumes.size, 1);
    await reservation.destroy();
    assert.equal(fixture.volumes.size, 0);
  } finally { delayedReply.resolve(); await fixture.close(); }
});

test('physical compute removal precedes blocked recovery persistence and public stop joins entered writes', { timeout: 10_000 }, async () => {
  for (const blockAt of ['running', 'stopping']) {
    const persistenceEntered = gate();
    const persistenceReply = gate();
    const fixture = await engineFixture();
    let stopped: Promise<void> | undefined;
    try {
      const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'persisted', async persist(record) {
        if (record.phase === blockAt) { persistenceEntered.resolve(); await persistenceReply.promise; }
      } });
      const startup = reservation.start().then(() => 'ready', () => 'failed');
      if (blockAt === 'running') await persistenceEntered.promise;
      else assert.equal(await startup, 'ready');
      let stopSettled = false;
      stopped = reservation.stop().then(() => { stopSettled = true; });
      void stopped.catch(() => {});
      await persistenceEntered.promise;
      const deadline = gate<never>();
      const timer = setTimeout(() => deadline.reject(new Error('Physical compute removal waited on blocked recovery persistence.')), 2000);
      try { await Promise.race([fixture.computeDeleted.promise, deadline.promise]); }
      finally { clearTimeout(timer); }
      assert.equal([...fixture.containers.values()].some((container) => container.State.Running), false);
      assert.equal(fixture.volumes.size, 1);
      const settlementWindow = gate<'pending'>();
      const settlementTimer = setTimeout(() => settlementWindow.resolve('pending'), 100);
      try { assert.equal(await Promise.race([stopped.then(() => 'settled'), settlementWindow.promise]), 'pending'); }
      finally { clearTimeout(settlementTimer); }
      assert.equal(stopSettled, false);
      persistenceReply.resolve();
      assert.equal(await startup, blockAt === 'running' ? 'failed' : 'ready');
      await stopped;
      await reservation.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
    } finally { persistenceReply.resolve(); await stopped?.catch(() => {}); await fixture.close(); }
  }
});

test('lost create replies recover only the exact original operation binding without replay', async () => {
  const fixture = await engineFixture({ loseComputeReply: true });
  try {
    const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    await assert.rejects(reservation.start(), SandboxStartError);
    assert.equal(reservation.recoveryRecord.resources.find((resource) => resource.role === 'compute')?.identity.kind, 'creating');
    const result = await fixture.backend.reconcile(reservation.recoveryRecord);
    assert.equal(result.kind, 'matched');
    if (result.kind !== 'matched') throw new Error('Expected matched cleanup owner');
    assert.equal(result.owner.recoveryRecord.resources.find((resource) => resource.role === 'compute')?.identity.kind, 'identified');
    await result.owner.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size,
      computeCreates: fixture.effects.filter((effect) => effect.path === '/v1.52/containers/create').length }, { containers: 0, volumes: 0, computeCreates: 1 });
  } finally { await fixture.close(); }
});

test('missing entered create stays uncertain and planned resources grant no adoption authority', async () => {
  const fixture = await engineFixture({ loseComputeReply: true });
  try {
    const planned = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    assert.equal((await fixture.backend.reconcile(planned.recoveryRecord)).kind, 'absent');
    const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    await assert.rejects(reservation.start(), SandboxStartError);
    fixture.containers.clear();
    const result = await fixture.backend.reconcile(reservation.recoveryRecord);
    assert.equal(result.kind, 'uncertain');
    if (result.kind !== 'uncertain') throw new Error('Expected retained uncertain owner');
    await assert.rejects(result.owner.destroy(), SandboxCleanupError);
    assert.equal(fixture.volumes.size, 1);
    assert.equal(fixture.effects.filter((effect) => effect.method === 'DELETE').length, 0);
  } finally { await fixture.close(); }
});

test('stale planned recovery records conflict with present exact names without adoption or cleanup', async () => {
  const fixture = await engineFixture();
  let partiallyPlanned: SandboxRecoveryRecord | undefined;
  const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'persisted', async persist(record) {
    if (record.resources.some((resource) => resource.role === 'storage' && resource.identity.kind === 'identified')
      && record.resources.some((resource) => resource.role === 'compute' && resource.identity.kind === 'planned')) partiallyPlanned = record;
  } });
  const beforeStart = reservation.recoveryRecord;
  try {
    assert.equal((await fixture.backend.reconcile(beforeStart)).kind, 'absent');
    await reservation.start();
    assert.ok(partiallyPlanned);
    const effectsBeforeRecovery = fixture.effects.length;
    for (const stale of [beforeStart, partiallyPlanned]) {
      assert.equal((await fixture.backend.reconcile(stale)).kind, 'conflict');
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
        { containers: 2, volumes: 1, networks: 0 });
      assert.equal([...fixture.containers.values()].filter((container) => container.State.Running).length, 1);
    }
    const compute = [...fixture.containers.values()].find((container) => container.State.Running);
    assert.ok(compute);
    const labels = compute.Config.Labels;
    compute.Config.Labels = { 'foreign.owner': 'unrelated' };
    try { assert.equal((await fixture.backend.reconcile(beforeStart)).kind, 'conflict'); }
    finally { compute.Config.Labels = labels; }
    assert.equal(fixture.effects.length, effectsBeforeRecovery);
    await reservation.destroy();
    assert.equal((await fixture.backend.reconcile(beforeStart)).kind, 'absent');
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { await reservation.destroy(); await fixture.close(); }
});

test('recovery rejects changed record claims, configuration fingerprints and daemon authority without cleanup', async () => {
  const fixture = await engineFixture();
  try {
    const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    await reservation.start();
    const record = reservation.recoveryRecord;
    const before = fixture.effects.length;
    const changedPolicy = parseSandboxRecoveryRecord({ ...record, policyDigest: `sha256:${'2'.repeat(64)}` });
    assert.equal((await fixture.backend.reconcile(changedPolicy)).kind, 'conflict');
    const compute = [...fixture.containers.values()].find((container) => container.State.Running);
    assert.ok(compute);
    const originalMemory = compute.HostConfig.Memory;
    compute.HostConfig.Memory = 0;
    assert.equal((await fixture.backend.reconcile(record)).kind, 'conflict');
    compute.HostConfig.Memory = originalMemory;
    fixture.setDaemonId('daemon-unit-2');
    assert.equal((await fixture.backend.reconcile(record)).kind, 'conflict');
    await assert.rejects(reservation.stop(), SandboxCleanupError);
    assert.equal(fixture.effects.length, before);
    assert.equal(fixture.containers.size, 2);
    fixture.setDaemonId('daemon-unit-1');
    await reservation.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { await fixture.close(); }
});

test('known-ID cleanup leaves a reused original name untouched and retries partial resource deletion', async () => {
  const fixture = await engineFixture({ failDeleteVolumeOnce: true });
  try {
    const reservation = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    await reservation.start();
    const compute = [...fixture.containers.values()].find((container) => container.State.Running);
    assert.ok(compute);
    fixture.containers.delete(compute.Id);
    const replacementId = 'f'.repeat(64);
    fixture.containers.set(replacementId, { ...structuredClone(compute), Id: replacementId });
    await reservation.stop();
    assert.equal(fixture.containers.has(replacementId), true);
    await assert.rejects(reservation.destroy(), SandboxCleanupError);
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 1, volumes: 1 });
    await reservation.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 1, volumes: 0 });
    assert.equal(fixture.effects.some((effect) => effect.method === 'DELETE' && effect.path.includes(replacementId)), false);
  } finally { await fixture.close(); }
});
