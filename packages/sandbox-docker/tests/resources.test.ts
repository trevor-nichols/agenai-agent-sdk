// ------------------------------------------------------------------------------------------------
//                resources.test.ts - Observable Docker ownership and recovery - Unix HTTP boundary
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDockerSandboxBackend } from '../src/index.js';
import { SandboxCleanupError, SandboxStartError, SandboxStateError, SandboxUnsupportedError, SandboxValidationError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { engineFixture, gate, imageDigest, sandboxRequest } from './fixtures/engine.js';
import { createDockerLinuxRouteAuthority } from '../src/node/index.js';
import { parseDockerConfig } from '../src/policy/config.js';
import type { DockerSandboxEgressOptions } from '../src/policy/config.js';
import { verifyEgressDeployment, verifyEgressImage } from '../src/policy/preflight.js';
import { DockerApi } from '../src/resources/api.js';
import { DockerEngine } from '../src/engine/client.js';
import { containerSchema, inspectResource, verifyNetworkMembership } from '../src/resources/inspect.js';
import { helperContainerBody, verifyHelperContainer } from '../src/policy/helperContainer.js';
import type { EgressHelperPlacement } from '../src/policy/helperContainer.js';
import { newRecoveryRecord, resourceName } from '../src/recovery/identity.js';

function egressConfiguration(): DockerSandboxEgressOptions {
  return { imageDigest: `sha256:${'6'.repeat(64)}`, protocol: 'agenai.sandbox.egress-connect.v1', user: { uid: 65534, gid: 65534 },
    broker: { resources: { cpus: 0.25, memoryBytes: 32 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2 },
    relay: { resources: { cpus: 0.1, memoryBytes: 16 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 },
    routeAuthority: createDockerLinuxRouteAuthority({ kind: 'local_linux_same_host', stability: 'caller_owned_quiescence',
      ipExecutable: { path: '/fixture/never-executed-ip', sha256: 'a'.repeat(64) }, pollIntervalMs: 100,
      commandTimeoutMs: 1000, maxOutputBytes: 65536 }), control: { heartbeatMs: 100, leaseTimeoutMs: 5000 } };
}

const restricted = () => sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] });
const networkFixtureProfile = process.platform === 'darwin' && process.arch === 'arm64' ? 'desktop-apple-virtualization-native-arm64' : 'linux-x64';

test('restricted reservations bind exact helper topology and reject changed configuration or older records before Engine access', async () => {
  const egress = egressConfiguration();
  const options = { endpoint: 'unix:///absent-egress-engine.sock', namespace: 'egress-binding', imageDigest,
    spillDirectory: '/absent-egress-spill', user: { uid: 65534, gid: 65534 }, egress };
  const backend = createDockerSandboxBackend(options);
  const record = backend.reserve(restricted(), { kind: 'in_process' }).recoveryRecord;
  assert.deepEqual(record.resources.map((resource) => resource.role),
    ['compute', 'storage', 'export', 'network', 'egress_socket', 'egress_broker', 'egress_relay']);
  for (const changed of [
    { ...egress, imageDigest: `sha256:${'7'.repeat(64)}` },
    { ...egress, user: { uid: 65533, gid: 65534 } },
    { ...egress, broker: { ...egress.broker, resources: { ...egress.broker.resources, cpus: 0.5 } } },
    { ...egress, relay: { ...egress.relay, temporaryBytes: 2 * 1024 ** 2 } },
    { ...egress, control: { ...egress.control, leaseTimeoutMs: 6000 } },
  ]) {
    const other = createDockerSandboxBackend({ ...options, egress: changed });
    assert.equal((await other.reconcile(record)).kind, 'conflict');
  }
  const missing = parseSandboxRecoveryRecord({ ...record, resources: record.resources.filter((resource) => resource.role !== 'egress_relay') });
  assert.equal((await backend.reconcile(missing)).kind, 'conflict');
  const extra = parseSandboxRecoveryRecord({ ...record, resources: [...record.resources,
    { role: 'filesystem', name: resourceName(record.namespace, record.operationId, 'filesystem'), identity: { kind: 'planned' } }] });
  assert.equal((await backend.reconcile(extra)).kind, 'conflict');
  await assert.rejects(Reflect.apply(backend.reconcile, backend, [{ ...record, format: 'agenai.sandbox-recovery.v2' }]), SandboxValidationError);
});

test('nested egress input rejects non-data fields and cloned authority without invoking getters', () => {
  const egress = egressConfiguration();
  const options = { endpoint: 'unix:///absent-egress-engine.sock', namespace: 'egress-input', imageDigest,
    spillDirectory: '/absent-egress-spill', user: { uid: 65534, gid: 65534 }, egress };
  let getterReads = 0;
  const getter = { ...egress.broker.resources, get cpus() { getterReads += 1; return 0.5; } };
  const hidden = Object.defineProperty({ ...egress.relay }, 'hidden', { value: true });
  for (const invalid of [
    { ...egress, broker: { ...egress.broker, resources: getter } },
    { ...egress, relay: hidden },
    { ...egress, [Symbol('unsupported')]: true },
    { ...egress, routeAuthority: { ...egress.routeAuthority } },
    { ...egress, control: { heartbeatMs: 100, leaseTimeoutMs: 100 } },
    { ...egress, broker: { ...egress.broker, resources: { ...egress.broker.resources, cpus: 0.0000000001 } } },
  ]) assert.throws(() => Reflect.apply(createDockerSandboxBackend, undefined, [{ ...options, egress: invalid }]), SandboxValidationError);
  assert.equal(getterReads, 0);
});

test('prepared helper prerequisites reject before acquisition and cleanup does not require the failed image preflight', async () => {
  const egress = egressConfiguration();
  for (const mismatch of ['environment', 'user', 'protocol', 'architecture', 'image-user', 'entrypoint', 'command', 'working-directory'] as const) {
    const fixture = await engineFixture({ egress, async handleRequest({ path, response }) {
      if (path !== `/v1.52/images/${egress.imageDigest}/json`) return false;
      const value = { Id: egress.imageDigest, Os: 'linux', Architecture: 'amd64', Config: { Volumes: null,
        User: '65534:65534', Entrypoint: ['/usr/local/bin/node'], Cmd: ['--version'], WorkingDir: '/',
        Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp'], Labels: {
          'ai.agen.sandbox.egress.protocol': 'agenai.sandbox.egress-connect.v1',
          'ai.agen.sandbox.egress.user': '65534:65534', 'ai.agen.sandbox.egress.source': imageDigest } } };
      if (mismatch === 'environment') value.Config.Env.push('AMBIENT_BASE_IMAGE_ENV=unexpected');
      if (mismatch === 'user') value.Config.Labels['ai.agen.sandbox.egress.user'] = '0:0';
      if (mismatch === 'protocol') value.Config.Labels['ai.agen.sandbox.egress.protocol'] = 'different-protocol';
      if (mismatch === 'architecture') value.Architecture = 'arm64';
      if (mismatch === 'image-user') value.Config.User = '0:0';
      if (mismatch === 'entrypoint') value.Config.Entrypoint = ['/bin/sh'];
      if (mismatch === 'command') value.Config.Cmd = ['unexpected.js'];
      if (mismatch === 'working-directory') value.Config.WorkingDir = '/tmp';
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return true;
    } });
    try {
      const owner = fixture.backend.reserve(restricted(), { kind: 'in_process' });
      await assert.rejects(owner.start(), (error: unknown) => error instanceof SandboxStartError
        && error.cause instanceof SandboxUnsupportedError && /Prepared egress image/u.test(error.cause.message), mismatch);
      assert.deepEqual(fixture.effects, []);
      const imageRequests = fixture.requests.filter((request) => request.path.includes('/images/')).length;
      await owner.destroy();
      assert.equal(fixture.requests.filter((request) => request.path.includes('/images/')).length, imageRequests);
      assert.deepEqual(fixture.effects, []);
    } finally { await fixture.close(); }
  }
});

test('observed same-host comparison supplements the route assertion without running the observer or allocating resources', async () => {
  const egress = egressConfiguration();
  const fixture = await engineFixture({ egress });
  try {
    const config = parseDockerConfig({ endpoint: fixture.endpoint, namespace: 'unit-tests', imageDigest,
      spillDirectory: fixture.spillDirectory, user: { uid: 65534, gid: 65534 }, egress });
    const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 1000);
    await verifyEgressImage(api, config);
    await verifyEgressDeployment(api, config, { hostname: 'route-unit-host', kernel: 'unit-kernel', excludedCidrs: [] });
    for (const census of [
      { hostname: 'another-host', kernel: 'unit-kernel', excludedCidrs: [] },
      { hostname: 'route-unit-host', kernel: 'another-kernel', excludedCidrs: [] },
    ]) await assert.rejects(verifyEgressDeployment(api, config, census), SandboxUnsupportedError);
    assert.deepEqual(fixture.effects, []);
  } finally { await fixture.close(); }
});

test('helper request/readback binds separate images, private socket authority and mutable network membership independently', async () => {
  const egress = egressConfiguration();
  const fixture = await engineFixture({ egress });
  try {
    const config = parseDockerConfig({ endpoint: fixture.endpoint, namespace: 'unit-tests', imageDigest,
      spillDirectory: fixture.spillDirectory, user: { uid: 65534, gid: 65534 }, egress });
    assert(config.egress);
    const record = newRecoveryRecord(config, restricted());
    const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 1000);
    const networkId = 'b'.repeat(64);
    const computeId = 'c'.repeat(64);
    fixture.networks.set(networkId, { Id: networkId, Name: 'controlled-helper-network', Containers: {} });
    const placements: EgressHelperPlacement[] = [
      { role: 'egress_broker', networkId, configuration: { protocol: 'agenai.sandbox.egress-connect.v1', role: 'broker',
        destinations: [{ hostname: 'api.example.com', port: 443 }], excludedCidrs: ['10.0.0.0/8'], leaseTimeoutMs: 5000 } },
      { role: 'egress_relay', computeId, configuration: { protocol: 'agenai.sandbox.egress-connect.v1', role: 'relay', leaseTimeoutMs: 5000 } },
    ];
    for (const placement of placements) {
      const resource = record.resources.find((entry) => entry.role === placement.role);
      assert(resource);
      const body = helperContainerBody(config, record, 'owned-private-socket', placement);
      const response = await api.request('POST', `/v1.52/containers/create?name=${resource.name}`, {
        body: Buffer.from(JSON.stringify(body)), contentType: 'application/json' });
      const value: unknown = JSON.parse(Buffer.from(response.body).toString());
      assert(value !== null && typeof value === 'object');
      const id = Reflect.get(value, 'Id'); assert.equal(typeof id, 'string');
      if (typeof id !== 'string') throw new Error('Expected fixture container ID');
      const created = await inspectResource(api, config, record, resource, id);
      assert(created?.container);
      verifyHelperContainer(created.container, config, 'owned-private-socket', placement, false);
      const omittedReadOnly = containerSchema.parse(structuredClone(created.container));
      assert(Array.isArray(omittedReadOnly.HostConfig.Mounts));
      const requestedMount: unknown = omittedReadOnly.HostConfig.Mounts[0];
      assert(requestedMount !== null && typeof requestedMount === 'object');
      Reflect.deleteProperty(requestedMount, 'ReadOnly');
      if (placement.role === 'egress_broker') {
        verifyHelperContainer(omittedReadOnly, config, 'owned-private-socket', placement, false);
      } else {
        assert.throws(() => verifyHelperContainer(omittedReadOnly, config, 'owned-private-socket', placement, false), SandboxUnsupportedError);
      }
      const changedAccess = containerSchema.parse(structuredClone(created.container));
      changedAccess.Mounts[0].RW = !changedAccess.Mounts[0].RW;
      assert.throws(() => verifyHelperContainer(changedAccess, config, 'owned-private-socket', placement, false), SandboxUnsupportedError);
      const omittedNetworkFlag = containerSchema.parse(structuredClone(created.container));
      Reflect.deleteProperty(omittedNetworkFlag.Config, 'NetworkDisabled');
      verifyHelperContainer(omittedNetworkFlag, config, 'owned-private-socket', placement, false);
      for (const invalid of [true, null, 'false']) {
        omittedNetworkFlag.Config.NetworkDisabled = invalid;
        assert.throws(() => verifyHelperContainer(omittedNetworkFlag, config, 'owned-private-socket', placement, false), SandboxUnsupportedError);
      }
      assert.equal(created.container.Image, egress.imageDigest);
      assert.equal(created.container.Config.OpenStdin, true);
      assert.equal(created.container.HostConfig.PidMode, '');
      assert.equal(created.container.Mounts[0].RW, placement.role === 'egress_broker');
      assert.deepEqual(created.container.Mounts.map((mount) => mount.Destination), ['/run/agenai-egress']);
      await api.request('POST', `/v1.52/containers/${id}/start`);
      const running = await inspectResource(api, config, record, resource, id);
      assert(running?.container);
      verifyHelperContainer(running.container, config, 'owned-private-socket', placement, true);
      const changed = containerSchema.parse(structuredClone(running.container));
      changed.HostConfig.PidMode = `container:${computeId}`;
      assert.throws(() => verifyHelperContainer(changed, config, 'owned-private-socket', placement, true), SandboxUnsupportedError);
      const mismatched = { ...config, egress: { ...config.egress, imageDigest } };
      await assert.rejects(inspectResource(api, mismatched, record, resource, id), SandboxStateError);
      if (placement.role === 'egress_broker') {
        await verifyNetworkMembership(api, networkId, [id]);
        const network = fixture.networks.get(networkId); assert(network);
        network.Containers = { [id]: { Name: resource.name }, ['d'.repeat(64)]: { Name: 'foreign-container' } };
        await assert.rejects(verifyNetworkMembership(api, networkId, [id]), SandboxStateError);
        // Runtime membership changes do not change immutable container identity or strand cleanup.
        const fingerprinted = parseSandboxRecoveryRecord({ ...record, authority: { kind: 'verified', backendIdentity: 'daemon-unit-1' },
          phase: 'running', resources: record.resources.map((entry) => entry.role === resource.role
            ? { ...entry, identity: { kind: 'identified', id, fingerprint: running.fingerprint } } : entry) });
        const known = fingerprinted.resources.find((entry) => entry.role === resource.role); assert(known);
        assert.equal((await inspectResource(api, config, fingerprinted, known, id))?.fingerprint, running.fingerprint);
      }
      await api.request('DELETE', `/v1.52/containers/${id}?force=true`);
    }
    assert.equal(fixture.containers.size, 0);
  } finally { await fixture.close(); }
});

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

test('owned outbound bridge is explicit and destroyed independently from retained files', async (t) => {
  const optionProfiles: readonly Readonly<Record<string, string>>[] = [{}, { 'com.docker.network.enable_ipv4': 'true' }];
  for (const networkOptions of optionProfiles) await t.test(JSON.stringify(networkOptions), async () => {
    const fixture = await engineFixture({ profile: networkFixtureProfile, networkOptions });
    try {
      const reservation = fixture.backend.reserve(sandboxRequest('outbound'), { kind: 'in_process' });
      const sandbox = await reservation.start();
      const networkId = [...fixture.networks.keys()][0];
      assert.equal([...fixture.containers.values()].find((container) => container.State.Running)?.HostConfig.NetworkMode, networkId);
      assert.equal(sandbox.effective.network.kind, 'outbound');
      assert.equal(fixture.backend.support.networkAllowlist, false);
      await sandbox.stop();
      assert.equal(fixture.networks.has(networkId), true);
      const record = reservation.recoveryRecord;
      const recovered = await fixture.backend.reconcile(record);
      assert.equal(recovered.kind, 'matched');
      if (recovered.kind !== 'matched') throw new Error('Expected exact outbound network recovery.');
      assert.deepEqual(recovered.owner.recoveryRecord, record, 'Recovery must preserve the original exact resource fingerprints.');
      const network = fixture.networks.get(networkId); assert(network);
      network.Options = Object.keys(networkOptions).length === 0 ? { 'com.docker.network.enable_ipv4': 'true' } : {};
      assert.equal((await fixture.backend.reconcile(record)).kind, 'conflict', 'Changing between two admitted option maps must still change resource identity.');
      await assert.rejects(reservation.destroy(), SandboxCleanupError);
      assert.equal(fixture.networks.has(networkId), true, 'A fingerprint mismatch must retain the exact network.');
      network.Options = networkOptions;
      await recovered.owner.destroy();
      await reservation.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size }, { containers: 0, volumes: 0, networks: 0 });
    } finally { await fixture.close(); }
  });
});

test('outbound network admission rejects other option values and keys before compute and retains retry ownership', async (t) => {
  const invalidOptions: readonly Readonly<Record<string, string>>[] = [
    { 'com.docker.network.enable_ipv4': 'false' },
    { 'com.docker.network.enable_ipv4': 'TRUE' },
    { 'com.docker.network.enable_ipv6': 'false' },
    { 'com.docker.network.bridge.enable_icc': 'false' },
    { 'com.docker.network.enable_ipv4': 'true', 'unrecognized.option': 'true' },
  ];
  for (const networkOptions of invalidOptions) await t.test(JSON.stringify(networkOptions), async () => {
    const fixture = await engineFixture({ profile: networkFixtureProfile, networkOptions });
    try {
      const reservation = fixture.backend.reserve(sandboxRequest('outbound'), { kind: 'in_process' });
      await assert.rejects(reservation.start(), (error: unknown) => error instanceof SandboxStartError
        && error.cause instanceof SandboxStateError && /owned outbound bridge profile/u.test(error.cause.message));
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
        { containers: 0, volumes: 1, networks: 1 });
      await assert.rejects(reservation.destroy(), SandboxCleanupError);
      assert.equal(fixture.networks.size, 1);
      assert.equal(fixture.effects.some((effect) => effect.method === 'DELETE' && effect.path.includes('/networks/')), false);
      const network = [...fixture.networks.values()][0]; assert(network);
      network.Options = {};
      await reservation.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
        { containers: 0, volumes: 0, networks: 0 });
    } finally { await fixture.close(); }
  });
});

test('a fresh cleanup owner advances an original creating network record with the exact IPv4 default', async () => {
  const fixture = await engineFixture({ profile: networkFixtureProfile, networkOptions: { 'com.docker.network.enable_ipv4': 'true' } });
  let creating: SandboxRecoveryRecord | undefined;
  try {
    const reservation = fixture.backend.reserve(sandboxRequest('outbound'), { kind: 'persisted', async persist(record) {
      const identity = record.resources.find((resource) => resource.role === 'network')?.identity.kind;
      if (identity === 'creating') creating = record;
      if (identity === 'identified') throw new Error('Network identity checkpoint unavailable.');
    } });
    await assert.rejects(reservation.start(), SandboxStartError);
    assert(creating);
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
      { containers: 0, volumes: 1, networks: 1 });
    const backend = createDockerSandboxBackend({ endpoint: fixture.endpoint, namespace: 'unit-tests', imageDigest, profile: networkFixtureProfile,
      spillDirectory: fixture.spillDirectory, user: { uid: 65534, gid: 65534 } });
    const recovered = await backend.reconcile(creating);
    assert.equal(recovered.kind, 'matched');
    if (recovered.kind !== 'matched') throw new Error('Expected cleanup-only recovery of the original creating network.');
    const network = recovered.owner.recoveryRecord.resources.find((resource) => resource.role === 'network');
    assert.equal(network?.identity.kind, 'identified');
    assert.equal(creating.resources.find((resource) => resource.role === 'network')?.identity.kind, 'creating');
    await recovered.owner.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
      { containers: 0, volumes: 0, networks: 0 });
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
