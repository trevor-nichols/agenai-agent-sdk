import assert from 'node:assert/strict';
import test from 'node:test';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';
import type { ResourceInspection } from '../src/resources/inspect.js';
import type { DockerSandboxConfig } from '../src/policy/config.js';
import { desktopBridgeName, newRecoveryRecord, resourceLabels } from '../src/recovery/identity.js';
import { DesktopCoordinatorTopologyOwner } from '../src/network/desktop/coordinator/topologyOwner.js';
import type { DockerDesktopRouteAuthorityBinding } from '../src/network/routeAuthority.js';
import { parseDesktopHostObservation } from '../src/network/desktop/observation/host.js';
import { readDesktopEngineNetworks } from '../src/network/desktop/observation/engine.js';
import type { DesktopEngineNetwork } from '../src/network/desktop/observation/engine.js';
import { desktopHostDocument } from './fixtures/desktopObservation.js';
import { desktopRouteAuthorityOptions } from './fixtures/desktopRouteAuthority.js';
import { engineFixture, imageDigest, sandboxRequest } from './fixtures/engine.js';
import { coordinatorProjectionMember, projectionBaseEngine, projectionBaseVm, vmObservation } from './fixtures/desktopCoordinatorProjection.js';

// Independent Engine replies and normalized VM documents drive the production topology owner.
interface ObservedMember {
  record: SandboxRecoveryRecord;
  readonly geometry: ReturnType<typeof coordinatorProjectionMember>;
  observer: 'created' | 'running' | 'detached' | 'exited' | 'absent';
  network: DesktopEngineNetwork | undefined;
  endpoint: 'none' | 'attached' | 'settling' | 'retained';
  // Moby stores endpoint retirement in steps: listed as ep-<endpoint>, then unlisted, then its address released.
  brokerRetirement: 'none' | 'detached' | 'releasing';
  observerReads: number;
  bridgeRemnant: boolean;
}

function memberGraph(member: ObservedMember) {
  if (!member.network && !member.bridgeRemnant) return { interfaces: [], routes: [] };
  const source = member.endpoint === 'none' ? member.geometry.emptyVm : member.geometry.endpointVm;
  const bridgeIndex = member.geometry.owned.device.index;
  const interfaces = source.snapshot.interfaces.map((device) => device.index === bridgeIndex
    ? { ...device, name: desktopBridgeName(member.record) } : device);
  if (member.endpoint === 'none' || member.endpoint === 'attached') return { interfaces, routes: source.snapshot.routes };
  const terminal = member.endpoint === 'retained';
  const bridge = interfaces.find((device) => device.index === bridgeIndex); assert(bridge);
  return { interfaces: [{ ...bridge, flags: bridge.flags & ~(terminal ? 0x10040 : 0x10000), operationalState: terminal ? 2 : 6, carrier: 0 }],
    routes: source.snapshot.routes.filter((route) => route.interfaceIndex === bridgeIndex).map((route) => ({ ...route,
      flags: terminal && (route.family === 4 && (route.type === 1 || route.type === 3)
        || route.family === 6 && (route.type === 1 || route.type === 5)) ? 0x10 : route.flags })) };
}

async function lifecycleTopology() {
  const members: ObservedMember[] = [];
  const endpoint = (Name: string, EndpointID: string) => ({ Name, EndpointID, MacAddress: '', IPv4Address: '', IPv6Address: '' });
  const bridged = (member: ObservedMember, network: DesktopEngineNetwork): DesktopEngineNetwork => {
    const { brokerId, endpointNetwork, started } = member.geometry;
    const broker = { ...endpointNetwork.Containers[brokerId], Name: resource(member.record, 'egress_broker').name };
    if (member.brokerRetirement !== 'none') return { ...network, Status: endpointNetwork.Status,
      Containers: member.brokerRetirement === 'detached' ? { [`ep-${started.broker.endpointId}`]: broker } : {} };
    return member.endpoint !== 'attached' ? network : { ...network, Status: endpointNetwork.Status, Containers: { [brokerId]: broker } };
  };
  const observerEndpoint = (member: ObservedMember) => member.geometry.empty.observer.kind === 'present' ? member.geometry.empty.observer.endpointId : '';
  const networks = () => [
    { ...projectionBaseEngine.networks[0], Containers: Object.fromEntries(members.flatMap((member) => member.observer === 'running'
      || member.observer === 'detached' ? [[member.observer === 'running' ? member.geometry.observerId : `ep-${observerEndpoint(member)}`,
        endpoint(resource(member.record, 'route_observer').name, observerEndpoint(member))]] : [])) },
    projectionBaseEngine.networks[1], ...members.flatMap((member) => member.network ? [bridged(member, member.network)] : []),
  ];
  let drift = false;
  const vm = () => vmObservation({ ...projectionBaseVm.snapshot,
    interfaces: [...projectionBaseVm.snapshot.interfaces.map((device) => drift ? { ...device, name: `${device.name}-changed` } : device),
      ...members.flatMap((member) => memberGraph(member).interfaces)],
    routes: [...projectionBaseVm.snapshot.routes, ...members.flatMap((member) => memberGraph(member).routes)],
  });
  const fixture = await engineFixture({ kernelVersion: projectionBaseVm.snapshot.kernel, async handleRequest({ path, response }) {
    const current = networks();
    const body = path === '/v1.52/networks' ? current.map(({ Id }) => ({ Id }))
      : current.find((network) => path === `/v1.52/networks/${network.Id}`);
    if (body === undefined) return false;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); return true;
  } });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 1000);
  const host = { ...parseDesktopHostObservation(desktopHostDocument()), executableIdentity: 'original-prepared-host' };
  const descriptor = desktopRouteAuthorityOptions('desktop-apple-virtualization-native-arm64', fixture.endpoint);
  const binding: DockerDesktopRouteAuthorityBinding = { kind: 'local_docker_desktop',
    identity: { ...descriptor, engine: { ...descriptor.engine, id: 'daemon-unit-1' } },
    async observeHost(_signal, budget) { budget?.consume(Buffer.byteLength(JSON.stringify(host))); return host; },
    async observeEngineSocket() { return { path: fixture.endpoint.slice(7), device: '1', inode: '2', mode: '49663' }; },
  };
  const captureEngineBaseline = async () => ({ host, engine: await readDesktopEngineNetworks(api) });
  const manager = new DesktopCoordinatorTopologyOwner({ api, binding, initial: await captureEngineBaseline(),
    async assertEndpoint() {}, captureEngineBaseline });
  async function addMember(withNetwork = true) {
    const allocation = await manager.selectAllocation();
    const config: DockerSandboxConfig = { profile: 'desktop-apple-virtualization-native-arm64', endpoint: fixture.endpoint,
      namespace: 'topology-lifecycle', imageDigest, user: { uid: 1000, gid: 1000 }, spillDirectory: fixture.spillDirectory,
      datasets: [], egress: undefined, egressAuthority: undefined };
    const member: ObservedMember = { record: newRecoveryRecord(config,
      sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] })),
    geometry: coordinatorProjectionMember(allocation.slot), observer: 'absent',
    network: undefined, endpoint: 'none', brokerRetirement: 'none', observerReads: 0, bridgeRemnant: false };
    members.push(member);
    const memberId = member.record.operationId;
    manager.addMember({ memberId, config, record: () => member.record }, allocation);
    const inspection = () => observerInspection(member.record, member.geometry.observerId, member.observer,
      projectionBaseEngine.networks[0].Id, member.geometry.empty.observer.kind === 'present' ? member.geometry.empty.observer.endpointId : '');
    await manager.before(memberId, 'route_observer', 'create');
    member.record = { ...member.record, resources: member.record.resources.map((entry) => entry.role === 'route_observer'
      ? { ...entry, identity: { kind: 'identified', id: member.geometry.observerId, fingerprint: `sha256:${'a'.repeat(64)}` } } : entry) };
    member.observer = 'created';
    await manager.after(memberId, 'route_observer', 'create', inspection());
    manager.observer(memberId, member.geometry.observerId, { ready: Promise.resolve(), settled: Promise.resolve(),
      beginReadiness() {}, stopRenewal() {}, async close() { return { kind: 'confirmed_stop' }; },
      async observe() { member.observerReads += 1; return vm(); } });
    await manager.before(memberId, 'route_observer', 'start'); member.observer = 'running';
    await manager.after(memberId, 'route_observer', 'start', inspection());
    if (withNetwork) {
      await manager.before(memberId, 'network', 'create');
      member.network = { ...member.geometry.network, Name: resource(member.record, 'network').name,
        Options: { 'com.docker.network.bridge.name': desktopBridgeName(member.record) }, Labels: resourceLabels(member.record, 'network') };
      await manager.after(memberId, 'network', 'create', { id: member.network.Id, fingerprint: `sha256:${'b'.repeat(64)}` });
    }
    return { member, memberId, inspection,
      async startBroker() {
        await manager.before(memberId, 'egress_broker', 'create');
        await manager.after(memberId, 'egress_broker', 'create', brokerInspection(member, 'created'));
        await manager.before(memberId, 'egress_broker', 'start'); member.endpoint = 'attached';
        await manager.after(memberId, 'egress_broker', 'start', brokerInspection(member, 'running'));
      },
      async stop() {
        await manager.before(memberId, 'route_observer', 'control_close'); member.observer = 'exited';
        await manager.after(memberId, 'route_observer', 'control_close', inspection());
        await manager.before(memberId, 'route_observer', 'delete'); member.observer = 'absent';
        await manager.after(memberId, 'route_observer', 'delete', undefined);
        await manager.stopped(memberId);
      },
      async destroy() {
        if (member.network) {
          await manager.before(memberId, 'network', 'delete'); member.network = undefined;
          await manager.after(memberId, 'network', 'delete', undefined);
        }
        manager.retire(memberId);
      },
    };
  }
  return { manager, addMember, drift: () => { drift = true; }, close: () => fixture.close() };
}

function resource(record: SandboxRecoveryRecord, role: 'route_observer' | 'network' | 'egress_broker') {
  const found = record.resources.find((entry) => entry.role === role); assert(found); return found;
}

function brokerInspection(member: ObservedMember, state: 'created' | 'running'): ResourceInspection {
  const network = member.network; assert(network);
  const { broker } = member.geometry.started;
  return { id: broker.id, fingerprint: `sha256:${'c'.repeat(64)}`, container: {
    Id: broker.id, Name: `/${resource(member.record, 'egress_broker').name}`, Image: imageDigest,
    Config: { Labels: {}, Image: imageDigest, User: '65534:65534', WorkingDir: '/', Entrypoint: [], Cmd: [], Env: [], Tty: false, OpenStdin: true },
    HostConfig: { NetworkMode: network.Id }, Mounts: [], AppArmorProfile: '',
    State: { Running: state === 'running', Status: state }, NetworkSettings: { Networks: { [network.Name]: state === 'created'
      ? { NetworkID: '', EndpointID: '' }
      : { NetworkID: network.Id, EndpointID: broker.endpointId, MacAddress: broker.macAddress, IPAddress: broker.address,
        IPPrefixLen: broker.prefixLength, Gateway: broker.gateway } }, Ports: {} },
  } };
}

function observerInspection(record: SandboxRecoveryRecord, id: string, state: ObservedMember['observer'],
  networkId: string, endpointId: string): ResourceInspection {
  return { id, fingerprint: `sha256:${'a'.repeat(64)}`, container: {
    Id: id, Name: `/${resource(record, 'route_observer').name}`, Image: imageDigest,
    Config: { Labels: {}, Image: imageDigest, User: '1000:1000', WorkingDir: '/', Entrypoint: [], Cmd: [], Env: [], Tty: false, OpenStdin: true },
    HostConfig: { NetworkMode: 'host' }, Mounts: [], AppArmorProfile: '',
    State: { Running: state === 'running', Status: state === 'detached' ? 'exited' : state }, NetworkSettings: { Networks: {
      host: { NetworkID: state === 'created' ? '' : networkId, EndpointID: state === 'running' ? endpointId : '' },
    }, Ports: {} },
  } };
}

test('normal final-observer retirement seals two full observations and preserves the retained allocation on re-entry', async () => {
  const fixture = await lifecycleTopology();
  try {
    const first = await fixture.addMember();
    const reads = first.member.observerReads;
    await fixture.manager.before(first.memberId, 'route_observer', 'control_close');
    assert(first.member.observerReads - reads >= 4, 'Final retirement must bracket retained facts twice before control close.');
    first.member.observer = 'detached';
    const exited = setTimeout(() => { first.member.observer = 'exited'; }, 300);
    try {
      await fixture.manager.after(first.memberId, 'route_observer', 'control_close', first.inspection());
    } finally { clearTimeout(exited); }
    assert.equal(first.member.observer, 'exited', 'An observer still listed by its detached endpoint has not left the host network.');
    await fixture.manager.before(first.memberId, 'route_observer', 'delete'); first.member.observer = 'absent';
    await fixture.manager.after(first.memberId, 'route_observer', 'delete', undefined);
    await fixture.manager.stopped(first.memberId);
    assert.equal(fixture.manager.observationKind, 'quiescent');
    const second = await fixture.addMember();
    assert.equal(second.member.geometry.slot, 1, 'Retained bridges keep their original slot.');
    assert.equal(fixture.manager.observationKind, 'full');
  } finally { await fixture.close(); }
});

for (const drift of ['external', 'removed_bridge'] as const) test(`a quiescent bridge deletion cannot conceal ${drift} VM drift on re-entry`, async () => {
  const fixture = await lifecycleTopology();
  try {
    const first = await fixture.addMember(); await first.stop();
    await first.destroy();
    assert.equal(fixture.manager.observationKind, 'quiescent');
    if (drift === 'external') fixture.drift();
    else first.member.bridgeRemnant = true;
    await assert.rejects(fixture.addMember(false), /External Desktop topology changed/u);
  } finally { await fixture.close(); }
});

for (const order of [[0, 1], [1, 0]] as const) test(`retiring member ${order[0]} preserves the independent peer observation path`, async () => {
  const fixture = await lifecycleTopology();
  try {
    const members = [await fixture.addMember(), await fixture.addMember()];
    const retiring = members[order[0]]; const survivor = members[order[1]];
    await retiring.stop(); await retiring.destroy();
    assert.equal(fixture.manager.observationKind, 'full');
    const reads = survivor.member.observerReads;
    await fixture.manager.assertCurrent();
    assert(survivor.member.observerReads > reads);
    assert.equal(survivor.member.observer, 'running');
    assert(survivor.member.network);
    await survivor.stop();
  } finally { await fixture.close(); }
});

test('a control-failed observer may leave its builtin network while peer producers stay exact', { timeout: 20_000 }, async () => {
  const fixture = await lifecycleTopology();
  try {
    const target = await fixture.addMember(); const peer = await fixture.addMember();
    assert.equal(fixture.manager.releaseControl(target.memberId, 'route_observer'), true);
    await fixture.manager.assertCurrent();
    for (const observer of ['detached', 'exited'] as const) {
      target.member.observer = observer;
      await fixture.manager.assertCurrent();
    }
    peer.member.observer = 'exited';
    await assert.rejects(fixture.manager.assertCurrent(), /registered Desktop producer disappeared/u);
    peer.member.observer = 'running';
    await fixture.manager.before(target.memberId, 'route_observer', 'delete'); target.member.observer = 'absent';
    const removed = await fixture.manager.after(target.memberId, 'route_observer', 'delete', undefined);
    assert(removed.projection?.kind === 'registered');
    assert.equal(removed.projection.facts.observerId, null);
    await fixture.manager.stopped(target.memberId);
    await target.destroy();
    await fixture.manager.assertCurrent();
    await peer.stop();
  } finally { await fixture.close(); }
});

test('a control-failed broker may retire its endpoint without fencing while peer topology stays exact', { timeout: 20_000 }, async () => {
  const fixture = await lifecycleTopology();
  try {
    const target = await fixture.addMember(); const peer = await fixture.addMember();
    await target.startBroker();
    await fixture.manager.assertCurrent();
    assert.equal(fixture.manager.releaseControl(target.memberId, 'egress_broker'), true);
    await fixture.manager.assertCurrent();
    await fixture.manager.before(target.memberId, 'egress_relay', 'delete');
    await fixture.manager.after(target.memberId, 'egress_relay', 'delete', undefined);
    for (const [endpoint, retirement] of [['attached', 'detached'], ['attached', 'releasing'], ['settling', 'releasing'],
      ['retained', 'releasing']] as const) {
      target.member.endpoint = endpoint; target.member.brokerRetirement = retirement;
      await fixture.manager.assertCurrent();
    }
    peer.member.observer = 'exited';
    await assert.rejects(fixture.manager.assertCurrent(), /registered Desktop producer disappeared/u);
    peer.member.observer = 'running';
    await fixture.manager.before(target.memberId, 'egress_broker', 'delete');
    const released = setTimeout(() => { target.member.brokerRetirement = 'none'; }, 300);
    let removed: Awaited<ReturnType<typeof fixture.manager.after>>;
    try {
      removed = await fixture.manager.after(target.memberId, 'egress_broker', 'delete', undefined);
    } finally { clearTimeout(released); }
    assert.equal(target.member.brokerRetirement, 'none', 'A bridge whose broker address is still held is not retained.');
    assert(removed.projection?.kind === 'registered');
    assert.equal(removed.projection.facts.broker, null);
    await target.stop(); await target.destroy();
    await fixture.manager.assertCurrent();
    await peer.stop();
  } finally { await fixture.close(); }
});
