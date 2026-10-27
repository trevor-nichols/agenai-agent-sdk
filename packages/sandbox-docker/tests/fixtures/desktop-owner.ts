// ------------------------------------------------------------------------------------------------
//                desktop-owner.ts - Public restricted ownership over actual Unix HTTP and framed peers
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { SandboxOperationError, SandboxStartError, parseSandboxRecoveryRecord, parseSandboxRequest } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '../../src/index.js';
import { desktopBridgeFixture, desktopHostDocument, desktopVmDocument, ipv6Route, netlinkAttribute } from './desktopObservation.js';
import { desktopResourcesFixture } from './desktopResources.js';
import { sandboxRequest } from './engine.js';
import { preparedNodeEnvironment } from './preparedNode.js';

const preparedRuntime = Object.freeze({ executable: process.execPath, platform: process.platform });
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });

function restrictedRequest(files = false) {
  const request = sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] });
  return parseSandboxRequest({ policy: { ...request.policy, files: { kind: files ? 'read_write' : 'disabled' },
    deadlines: { startupMs: 20_000, cleanupMs: 10_000 } } });
}

for (const profile of ['desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64'] as const) {
  test(`${profile} starts nine exact owned roles and cleanup/reconciliation survives unavailable host observation`, { timeout: 30_000 }, async () => {
    const environment = preparedNodeEnvironment(preparedRuntime);
    const fixture = await desktopResourcesFixture(profile);
    await fixture.enableObservation();
    const backend = createDockerSandboxBackend({ ...fixture.options(), filesystem: fixture.filesystem });
    const checkpoints: SandboxRecoveryRecord[] = [];
    const owner = backend.reserve(restrictedRequest(true), { kind: 'persisted', async persist(record) { checkpoints.push(record); } });
    try {
      const sandbox = await owner.start();
      assert.deepEqual(sandbox.effective.network, restrictedRequest(true).policy.network);
      assert.equal(owner.recoveryRecord.resources.length, 9);
      assert.equal(owner.recoveryRecord.resources.every(({ identity }) => identity.kind === 'identified'), true);
      assert.equal(checkpoints[0]?.resources.every(({ identity }) => identity.kind === 'planned'), true);
      const observer = [...fixture.containers.values()].find(({ Name }) => Name.endsWith('-route_observer'));
      assert(observer);
      assert.deepEqual({ user: observer.Config.User, network: observer.HostConfig.NetworkMode, pid: observer.HostConfig.PidMode,
        capabilities: observer.HostConfig.CapDrop, mounts: observer.Mounts, readonly: observer.HostConfig.ReadonlyRootfs,
        nnp: observer.HostConfig.SecurityOpt }, { user: '1000:1000', network: 'host', pid: '', capabilities: ['ALL'], mounts: [],
        readonly: true, nnp: ['no-new-privileges:true'] });
      assert.equal(fixture.effects[0]?.path, '/v1.52/containers/create');
      assert.equal(fixture.containers.get(observer.Id)?.Name, `/${owner.recoveryRecord.resources.find(({ role }) => role === 'route_observer')?.name}`);
      const creates = fixture.requests.filter(({ method, path }) => method === 'POST' && path === '/v1.52/containers/create');
      assert.equal(creates.length, 6);
      assert.equal(new URL(creates[0].target, 'http://fixture.invalid').searchParams.get('platform'), 'linux/arm64');
      const compute = [...fixture.containers.values()].find(({ Name }) => Name.endsWith('-compute'));
      assert(compute);
      const computeCreate = creates.find(({ target }) => new URL(target, 'http://fixture.invalid').searchParams.get('name') === compute.Name.slice(1));
      assert(computeCreate);
      assert.equal(new URL(computeCreate.target, 'http://fixture.invalid').searchParams.get('platform'),
        profile === 'desktop-apple-virtualization-native-arm64' ? 'linux/arm64' : 'linux/amd64');
      const calls = await fixture.observedHostCalls();
      assert.ok(calls.length >= 3);
      for (const call of calls) assert.deepEqual(call, { args: [], env: environment });
      await rm(fixture.descriptor.hostObserver.executable.path);
      const hostCallCount = calls.length;
      await sandbox.stop();
      assert.deepEqual([...fixture.containers.values()].map(({ Name }) => Name),
        [`/${owner.recoveryRecord.resources.find(({ role }) => role === 'export')?.name}`]);
      assert.equal(fixture.sockets.size, 0, JSON.stringify({ remaining: [...fixture.sockets].map(([id, socket]) => ({ id,
        role: owner.recoveryRecord.resources.find(({ identity }) => identity.kind === 'identified' && identity.id === id)?.role,
        destroyed: socket.destroyed, readableEnded: socket.readableEnded, writableEnded: socket.writableEnded,
        readable: socket.readable, writable: socket.writable,
      })) }));
      assert.equal(fixture.commands.filter(({ id, kind }) => id === observer.Id && kind === 'stop').length, 1);
      const recovery = await backend.reconcile(parseSandboxRecoveryRecord(owner.recoveryRecord));
      assert.equal(recovery.kind, 'matched');
      if (recovery.kind !== 'matched') throw new Error('Expected original stopped storage recovery.');
      await recovery.owner.destroy();
      await sandbox.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
        { containers: 0, volumes: 0, networks: 0 });
      assert.equal((await fixture.observedHostCalls()).length, hostCallCount);
      assert.equal((await backend.reconcile(owner.recoveryRecord)).kind, 'absent');
    } finally { await owner.destroy(); await fixture.close(); }
  });
}

for (const scenario of ['mismatched bridge and sole endpoint TSO limits', 'changed external interface TSO limits',
  'unobserved local IPv6 address', 'wrong anycast destination', 'wrong anycast prefix', 'wrong anycast priority',
  'wrong anycast interface', 'anycast gateway', 'unexpected anycast route mark'] as const) {
  test(`acquisition rejects ${scenario} without starting a relay`, { timeout: 30_000 }, async () => {
    let mutationEntered = false;
    const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64', undefined, {}, (options) => {
      if (!options?.broker) return desktopVmDocument(options);
      mutationEntered = true;
      if (scenario === 'mismatched bridge and sole endpoint TSO limits') return desktopVmDocument({ ...options, bridgeTsoMaxSize: 524281 });
      if (scenario === 'changed external interface TSO limits') return desktopVmDocument({ ...options, externalTsoMaxSize: 65537 });
      const document = desktopVmDocument(options);
      const subnetRouter = Buffer.from('fe800000000000000000000000000000', 'hex');
      const otherAddress = Buffer.from('fe800000000000000000000000000001', 'hex');
      const invalid = ipv6Route(scenario === 'unobserved local IPv6 address' || scenario === 'wrong anycast destination' ? otherAddress : subnetRouter,
        scenario === 'wrong anycast prefix' ? 64 : 128, scenario === 'wrong anycast interface' ? 7 : desktopBridgeFixture.index, {
          ...(scenario === 'unobserved local IPv6 address' ? { type: 2 } : {}),
          ...(scenario === 'wrong anycast priority' ? { priority: 256 } : {}),
          ...(scenario === 'anycast gateway' ? { gateway: otherAddress } : {}),
          ...(scenario === 'unexpected anycast route mark' ? { extra: [netlinkAttribute(16, Buffer.from([1, 0, 0, 0]))] } : {}),
        });
      return { ...document, routes: Buffer.concat([Buffer.from(document.routes, 'hex'), invalid]).toString('hex') };
    });
    await fixture.enableObservation();
    const owner = fixture.backend().reserve(restrictedRequest(), { kind: 'in_process' });
    try {
      await assert.rejects(owner.start(), (error: unknown) => {
        assert(error instanceof SandboxStartError);
        assert(error.cause instanceof SandboxOperationError);
        assert.equal(error.cause.code, 'driver_failure');
        assert.match(error.cause.message, scenario === 'mismatched bridge and sole endpoint TSO limits' ? /Owned bridge TSO limit/u
          : scenario === 'changed external interface TSO limits' || scenario === 'wrong anycast interface' ? /External VM authority/u
            : /Owned native route/u);
        return true;
      });
      assert.equal(mutationEntered, true, 'The changed native endpoint observation must actually enter.');
      assert.equal(fixture.requests.some(({ method, path, target }) => method === 'POST' && path === '/v1.52/containers/create'
        && new URL(target, 'http://fixture.invalid').searchParams.get('name')?.endsWith('-egress_relay')), false);
      await owner.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
        { containers: 0, volumes: 0, networks: 0 });
      assert.equal(fixture.sockets.size, 0);
    } finally { await owner.destroy(); await fixture.close(); }
  });
}

for (const scenario of [
  'unexplained initial reservations', 'incorrect owned address count', 'incorrect owned availability', 'extra owned subnet',
  'changed unknown status field', 'changed unknown IPAM status field', 'changed unknown subnet status field',
  'changed external Engine status', 'unsafe owned counter',
] as const) {
  test(`Engine acquisition rejects ${scenario} before relay startup`, { timeout: 30_000 }, async () => {
    let mutationEntered = false;
    let brokerAppeared = false;
    const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64', undefined, {}, undefined, (inspection) => {
      const subnets = inspection.Status.IPAM.Subnets;
      const allocation = subnets?.[desktopBridgeFixture.subnet];
      if (allocation && subnets) {
        const broker = Object.keys(inspection.Containers).length === 1;
        brokerAppeared ||= broker;
        if (scenario === 'unexplained initial reservations') { allocation.IPsInUse += 1; allocation.DynamicIPsAvailable -= 1; mutationEntered = true; }
        else if (scenario === 'unsafe owned counter') { allocation.IPsInUse = Number.MAX_SAFE_INTEGER + 1; mutationEntered = true; }
        else if (scenario === 'changed unknown status field') { Reflect.set(inspection.Status, 'NativeRevision', broker ? 'changed' : 'original'); mutationEntered ||= broker; }
        else if (scenario === 'changed unknown IPAM status field') { Reflect.set(inspection.Status.IPAM, 'NativeRevision', broker ? 'changed' : 'original'); mutationEntered ||= broker; }
        else if (scenario === 'changed unknown subnet status field') { Reflect.set(allocation, 'NativeRevision', broker ? 'changed' : 'original'); mutationEntered ||= broker; }
        else if (broker) {
          if (scenario === 'incorrect owned address count') allocation.IPsInUse += 1;
          else if (scenario === 'incorrect owned availability') allocation.DynamicIPsAvailable += 1;
          else if (scenario === 'extra owned subnet') subnets['172.30.43.0/24'] = { IPsInUse: 3, DynamicIPsAvailable: 253 };
          mutationEntered ||= scenario !== 'changed external Engine status';
        }
      }
      if (scenario === 'changed external Engine status' && Reflect.get(inspection, 'Name') === 'host') {
        Reflect.set(inspection.Status, 'NativeRevision', brokerAppeared ? 'changed' : 'original');
        mutationEntered ||= brokerAppeared;
      }
      return inspection;
    });
    await fixture.enableObservation();
    const owner = fixture.backend().reserve(restrictedRequest(), { kind: 'in_process' });
    try {
      await assert.rejects(owner.start(), (error: unknown) => {
        assert(error instanceof SandboxStartError);
        assert(error.cause instanceof SandboxOperationError);
        assert.equal(error.cause.code, 'driver_failure');
        const message = scenario === 'unsafe owned counter' ? /invalid resource response/u
          : scenario === 'unexplained initial reservations' ? /initial IPAM allocation accounting/u
            : scenario === 'extra owned subnet' ? /exact subnet status/u
              : scenario === 'incorrect owned address count' || scenario === 'incorrect owned availability' ? /broker IPAM allocation accounting/u
                : scenario === 'changed external Engine status' ? /External Desktop Engine/u : /Owned network configuration/u;
        assert.match(error.cause.message, message);
        return true;
      });
      assert.equal(mutationEntered, true, 'The changed Engine observation must actually enter.');
      assert.equal(fixture.requests.some(({ method, path, target }) => method === 'POST' && path === '/v1.52/containers/create'
        && new URL(target, 'http://fixture.invalid').searchParams.get('name')?.endsWith('-egress_relay')), false);
      await owner.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
        { containers: 0, volumes: 0, networks: 0 });
      assert.equal(fixture.sockets.size, 0);
    } finally { await owner.destroy(); await fixture.close(); }
  });
}

for (const scenario of ['bridge and endpoint TSO', 'owned IPAM counters'] as const) {
  test(`sealed ${scenario} changes fence imports before source entry`, { timeout: 30_000 }, async () => {
    let changed = false;
    let mutationEntered = false;
    const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64', undefined, {}, (options) => {
      if (scenario !== 'bridge and endpoint TSO' || !changed || !options?.broker) return desktopVmDocument(options);
      mutationEntered = true;
      return desktopVmDocument({ ...options, bridgeTsoMaxSize: 524281, endpointTsoMaxSize: 524281 });
    }, (inspection) => {
      const allocation = inspection.Status.IPAM.Subnets?.[desktopBridgeFixture.subnet];
      if (scenario === 'owned IPAM counters' && changed && allocation) {
        mutationEntered = true;
        allocation.IPsInUse += 1; allocation.DynamicIPsAvailable -= 1;
      }
      return inspection;
    });
    await fixture.enableObservation();
    const owner = fixture.backend().reserve(restrictedRequest(), { kind: 'in_process' });
    try {
      const sandbox = await owner.start();
      changed = true;
      const uploaded = fixture.uploadedArchives.length;
      let sourceEntered = false;
      async function* source() { sourceEntered = true; yield { kind: 'directory' as const, path: 'never-entered' }; }
      await assert.rejects(async () => sandbox.importTree(source()));
      assert.equal(mutationEntered, true);
      assert.equal(sourceEntered, false);
      assert.equal(fixture.uploadedArchives.length, uploaded);
      await owner.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
        { containers: 0, volumes: 0, networks: 0 });
      assert.equal(fixture.sockets.size, 0);
    } finally { await owner.destroy(); await fixture.close(); }
  });
}

test('sealed host drift fences an import before its source enters and whole-owner cleanup converges', { timeout: 30_000 }, async () => {
  const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64');
  await fixture.enableObservation();
  const owner = fixture.backend().reserve(restrictedRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    const changed = desktopHostDocument(); changed.host.boot.seconds += 1;
    await writeFile(fixture.hostDocumentPath, JSON.stringify(changed));
    const uploaded = fixture.uploadedArchives.length;
    let sourceEntered = false;
    async function* source() { sourceEntered = true; yield { kind: 'directory' as const, path: 'never-entered' }; }
    await assert.rejects(sandbox.importTree(source()));
    assert.equal(sourceEntered, false);
    assert.equal(fixture.uploadedArchives.length, uploaded);
    await owner.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
      { containers: 0, volumes: 0, networks: 0 });
    assert.equal(fixture.sockets.size, 0);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('lost VM observer control preserves the primary failure while original exact cleanup joins and removes every producer', { timeout: 30_000 }, async () => {
  const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64');
  await fixture.enableObservation();
  const owner = fixture.backend().reserve(restrictedRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    const observer = owner.recoveryRecord.resources.find(({ role }) => role === 'route_observer');
    assert(observer?.identity.kind === 'identified');
    const socket = fixture.sockets.get(observer.identity.id); assert(socket);
    socket.destroy();
    await assert.rejects(async () => sandbox.importTree([]));
    await owner.stop();
    assert.notEqual(sandbox.state.kind, 'ready');
    await assert.rejects(async () => sandbox.importTree([]));
    await owner.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
      { containers: 0, volumes: 0, networks: 0 });
    assert.equal(fixture.sockets.size, 0);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('unknown observer create acknowledgement retains its exact original cleanup identity without re-create or start', { timeout: 20_000 }, async () => {
  const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64', undefined, { loseContainerReplyForRole: 'route_observer' });
  await fixture.enableObservation();
  const backend = fixture.backend();
  const owner = backend.reserve(restrictedRequest(), { kind: 'in_process' });
  try {
    await assert.rejects(owner.start(), SandboxStartError);
    const original = parseSandboxRecoveryRecord(owner.recoveryRecord);
    assert.equal(original.resources.find(({ role }) => role === 'route_observer')?.identity.kind, 'creating');
    assert.equal(fixture.containers.size, 1);
    assert.equal(fixture.volumes.size, 0);
    await rm(fixture.descriptor.hostObserver.executable.path);
    const recovery = await backend.reconcile(original);
    assert.equal(recovery.kind, 'matched');
    if (recovery.kind !== 'matched') throw new Error('Expected exact observer adoption for cleanup only.');
    const observer = recovery.owner.recoveryRecord.resources.find(({ role }) => role === 'route_observer');
    assert(observer?.identity.kind === 'identified');
    assert.equal(observer.identity.id, [...fixture.containers.keys()][0]);
    await recovery.owner.destroy();
    assert.deepEqual(owner.recoveryRecord, original);
    assert.equal(fixture.effects.filter(({ method, path }) => method === 'POST' && path === '/v1.52/containers/create').length, 1);
    assert.equal(fixture.effects.some(({ path }) => path.endsWith('/start')), false);
    assert.equal(fixture.containers.size, 0);
    assert.equal(fixture.volumes.size, 0);
  } finally { await fixture.close(); }
});

test('unacknowledged observer cleanup rejects changed ownership or host authority before destructive requests', { timeout: 20_000 }, async () => {
  const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64', undefined, { loseContainerReplyForRole: 'route_observer' });
  await fixture.enableObservation();
  const backend = fixture.backend();
  const owner = backend.reserve(restrictedRequest(), { kind: 'in_process' });
  try {
    await assert.rejects(owner.start(), SandboxStartError);
    const original = parseSandboxRecoveryRecord(owner.recoveryRecord);
    const container = [...fixture.containers.values()][0]; assert(container);
    const labels = container.Config.Labels;
    assert(labels && typeof labels === 'object');
    const recordLabel = Reflect.get(labels, 'ai.agen.sandbox.record');
    const before = fixture.effects.length;
    Reflect.set(labels, 'ai.agen.sandbox.record', 'different-original-owner');
    assert.equal((await backend.reconcile(original)).kind, 'conflict');
    Reflect.set(labels, 'ai.agen.sandbox.record', recordLabel);
    container.HostConfig.PidMode = 'host';
    assert.equal((await backend.reconcile(original)).kind, 'conflict');
    assert.equal(fixture.effects.length, before);
    assert.equal(fixture.containers.size, 1);
    container.HostConfig.PidMode = '';
    const matched = await backend.reconcile(original);
    assert.equal(matched.kind, 'matched');
    if (matched.kind !== 'matched') throw new Error('Expected original observer after exact authority restoration.');
    await matched.owner.destroy();
    assert.equal(fixture.containers.size, 0);
  } finally { await fixture.close(); }
});
