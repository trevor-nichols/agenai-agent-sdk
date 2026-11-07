import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';
import type { ResourceInspection } from '../src/resources/inspect.js';
import type { DockerSandboxConfig } from '../src/policy/config.js';
import { newRecoveryRecord } from '../src/recovery/identity.js';
import { DesktopCoordinatorTopologyOwner } from '../src/network/desktop/coordinator/topologyOwner.js';
import { observeDesktopMemberEffect, releaseDesktopMemberControls } from '../src/network/desktop/coordinator/topologyMember.js';
import { projectDesktopEngineExternal } from '../src/network/desktop/coordinator/projection.js';
import type { DockerDesktopRouteAuthorityBinding } from '../src/network/routeAuthority.js';
import { parseDesktopHostObservation } from '../src/network/desktop/observation/host.js';
import { parseDesktopVmObservation } from '../src/network/desktop/observation/vm.js';
import { readDesktopEngineIdentity, readDesktopEngineNetworks } from '../src/network/desktop/observation/engine.js';
import { desktopHostDocument, desktopVmDocument, netlinkAttribute, netlinkRecord } from './fixtures/desktopObservation.js';
import { desktopRouteAuthorityOptions } from './fixtures/desktopRouteAuthority.js';
import { engineFixture, imageDigest, sandboxRequest } from './fixtures/engine.js';
import { coordinatorProjectionMember, projectionBaseEngine } from './fixtures/desktopCoordinatorProjection.js';

function memberSource(endpoint: string, spillDirectory: string) {
  const config: DockerSandboxConfig = { profile: 'desktop-apple-virtualization-native-arm64', endpoint,
    namespace: 'topology-tests', imageDigest, user: { uid: 1000, gid: 1000 }, spillDirectory,
    datasets: [], egress: undefined, egressAuthority: undefined };
  const request = sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] });
  return { config, record: newRecoveryRecord(config, request) };
}

test('observer bootstrap retains its original allocation and refuses a newly decoded VM collision before bridge dispatch', async () => {
  let networks = projectionBaseEngine.networks;
  const kernel = '6.12.54-linuxkit';
  const fixture = await engineFixture({ kernelVersion: kernel, async handleRequest({ path, response }) {
    const network = networks.find((entry) => path === `/v1.52/networks/${entry.Id}`);
    const body = path === '/v1.52/networks' ? networks.map(({ Id }) => ({ Id })) : network;
    if (body === undefined) return false;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); return true;
  } });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 1000);
  const host = { ...parseDesktopHostObservation(desktopHostDocument()), executableIdentity: 'original-prepared-host' };
  const binding: DockerDesktopRouteAuthorityBinding = { kind: 'local_docker_desktop',
    identity: { ...desktopRouteAuthorityOptions('desktop-apple-virtualization-native-arm64', fixture.endpoint),
      engine: { endpoint: fixture.endpoint, id: 'daemon-unit-1' } },
    async observeHost(_signal, budget) { budget?.consume(Buffer.byteLength(JSON.stringify(host))); return host; },
    async observeEngineSocket() { return { path: fixture.endpoint.slice(7), device: '1', inode: '2', mode: '49663' }; },
  };
  const source = memberSource(fixture.endpoint, fixture.spillDirectory);
  const config = source.config;
  let record = source.record;
  const captureEngineBaseline = async () => ({ host, engine: await readDesktopEngineNetworks(api) });
  const manager = new DesktopCoordinatorTopologyOwner({ api, binding, initial: await captureEngineBaseline(),
    async assertEndpoint() {}, captureEngineBaseline, captureEngineAuthority: async () => ({ host, engine: await readDesktopEngineIdentity(api) }) });
  try {
    const allocation = await manager.selectAllocation();
    assert.deepEqual(allocation, { slot: 0, subnet: '10.240.0.0/28', gateway: '10.240.0.1' });
    manager.addMember({ memberId: record.operationId, config, record: () => record }, allocation);
    const role = record.resources.find((resource) => resource.role === 'route_observer');
    assert(role);
    const id = 'a'.repeat(64);
    const inspection: ResourceInspection = { id, fingerprint: `sha256:${'b'.repeat(64)}`, container: {
      Id: id, Name: `/${role.name}`, Image: imageDigest,
      Config: { Labels: {}, Image: imageDigest, User: '1000:1000', WorkingDir: '/', Entrypoint: [], Cmd: [], Env: [], Tty: false, OpenStdin: true },
      HostConfig: { NetworkMode: 'host' }, Mounts: [], AppArmorProfile: '',
      NetworkSettings: { Networks: { host: { NetworkID: '', EndpointID: '', MacAddress: '', IPAddress: '', IPPrefixLen: 0, Gateway: '' } },
        Ports: {} }, State: { Running: false, Status: 'created' },
    } };
    await manager.before(record.operationId, 'route_observer', 'create');
    record = { ...record, phase: 'starting', authority: { kind: 'verified', backendIdentity: 'daemon-unit-1' },
      resources: record.resources.map((resource) => resource.role === 'route_observer'
        ? { ...resource, identity: { kind: 'identified', id, fingerprint: inspection.fingerprint } } : resource) };
    await manager.after(record.operationId, 'route_observer', 'create', inspection);
    const document = desktopVmDocument();
    const collision = netlinkRecord(20, Buffer.from([2, 28, 0x80, 0, 7, 0, 0, 0]),
      [netlinkAttribute(1, Buffer.from([10, 240, 0, 1]))]);
    const vm = parseDesktopVmObservation({ ...document, addresses: collision.toString('hex') });
    let observed = 0;
    manager.observer(record.operationId, id, { ready: Promise.resolve(), settled: Promise.resolve(), beginReadiness() {}, stopRenewal() {},
      async observe(_signal, budget) { observed += 1; budget?.consume(Buffer.byteLength(JSON.stringify(document))); return vm; },
      async close() { return { kind: 'confirmed_stop' }; } });
    await manager.before(record.operationId, 'route_observer', 'start');
    networks = networks.map((network) => network.Name === 'host' ? { ...network, Containers: {
      [id]: { Name: role.name, EndpointID: 'e'.repeat(64), MacAddress: '', IPv4Address: '', IPv6Address: '' },
    } } : network);
    assert(inspection.container);
    const running: ResourceInspection = { ...inspection, container: { ...inspection.container,
      State: { Running: true, Status: 'running' }, NetworkSettings: {
        Networks: { host: { NetworkID: projectionBaseEngine.networks[0].Id, EndpointID: 'e'.repeat(64) } }, Ports: {},
      } } };
    const settled = await manager.after(record.operationId, 'route_observer', 'start', running);
    assert.equal(settled.projection?.kind === 'registered' && settled.projection.facts.observerId, id);
    assert.equal(manager.observationKind, 'full');
    assert.equal(manager.currentBasis(20, `sha256:${'c'.repeat(64)}`)?.atSequence, 20);
    await assert.rejects(manager.before(record.operationId, 'network', 'create'), /reservation collides with decoded current topology/u);
    assert(observed >= 4, 'The current VM bracket must enter again before network dispatch.');
    assert.equal(fixture.effects.length, 0);
    assert.deepEqual(allocation, { slot: 0, subnet: '10.240.0.0/28', gateway: '10.240.0.1' });
  } finally { await fixture.close(); }
});

test('builtin stage receipts bind the independently inspected endpoint and retain only that original identity during close', () => {
  const fixture = coordinatorProjectionMember(0);
  const { record } = memberSource('unix:///absent-engine.sock', '/absent-spill');
  const resource = record.resources.find((entry) => entry.role === 'route_observer'); assert(resource);
  const absent = { ...fixture.empty, observer: { kind: 'absent' as const }, bridge: { kind: 'absent' as const } };
  const endpointId = 'e'.repeat(64);
  const inspection: ResourceInspection = { id: fixture.observerId, fingerprint: `sha256:${'b'.repeat(64)}`, container: {
    Id: fixture.observerId, Name: `/${resource.name}`, Image: imageDigest,
    Config: { Labels: {}, Image: imageDigest, User: '1000:1000', WorkingDir: '/', Entrypoint: [], Cmd: [], Env: [], Tty: false, OpenStdin: true },
    HostConfig: { NetworkMode: 'host' }, Mounts: [], AppArmorProfile: '',
    State: { Running: false, Status: 'created' }, NetworkSettings: { Networks: { host: { NetworkID: '', EndpointID: '' } }, Ports: {} },
  } };
  const created = observeDesktopMemberEffect(absent, record, 'route_observer', 'create', inspection, { engine: projectionBaseEngine });
  assert.deepEqual(created.observer, { kind: 'absent' });
  const host = { ...projectionBaseEngine.networks[0], Containers: { [fixture.observerId]: {
    Name: resource.name, EndpointID: endpointId, MacAddress: '', IPv4Address: '', IPv6Address: '',
  } } };
  const engine = { ...projectionBaseEngine, networks: [host, projectionBaseEngine.networks[1]] };
  assert(inspection.container);
  const runningContainer = { ...inspection.container, State: { Running: true, Status: 'running' },
    NetworkSettings: { Networks: { host: { NetworkID: host.Id, EndpointID: endpointId } }, Ports: {} } };
  const running: ResourceInspection = { ...inspection, container: runningContainer };
  const active = observeDesktopMemberEffect(created, record, 'route_observer', 'start', running, { engine });
  assert.deepEqual(active.observer, { kind: 'present', id: fixture.observerId, name: resource.name, endpointId });
  assert.deepEqual(projectDesktopEngineExternal(engine, [active]), {
    id: engine.id, hostname: engine.hostname, kernel: engine.kernel, networks: projectionBaseEngine.networks,
  });
  const substituted = { ...engine, networks: [{ ...host, Containers: { [fixture.observerId]: {
    ...host.Containers[fixture.observerId], EndpointID: 'f'.repeat(64),
  } } }, projectionBaseEngine.networks[1]] };
  assert.throws(() => projectDesktopEngineExternal(substituted, [active]), /exact builtin-network membership/u);
  assert.throws(() => observeDesktopMemberEffect(created, record, 'route_observer', 'create', inspection, { engine }),
    /independently inspected container attachment/u);
  const missingContainer = { ...runningContainer,
    NetworkSettings: { Networks: { host: { NetworkID: host.Id, EndpointID: '' } }, Ports: {} } };
  const missingEndpoint: ResourceInspection = { ...running, container: missingContainer };
  assert.throws(() => observeDesktopMemberEffect(created, record, 'route_observer', 'start', missingEndpoint, { engine }), /original inspected endpoint identity/u);
  const exited: ResourceInspection = { ...missingEndpoint, container: { ...missingContainer, State: { Running: false, Status: 'exited' } } };
  const closing = observeDesktopMemberEffect(active, record, 'route_observer', 'control_close', exited, { engine });
  assert.deepEqual(closing.observer, active.observer);
  assert.deepEqual(projectDesktopEngineExternal(engine, [closing]), projectDesktopEngineExternal(engine, [active]));
  assert.throws(() => projectDesktopEngineExternal(substituted, [closing]), /exact builtin-network membership/u);
  const retired = observeDesktopMemberEffect(closing, record, 'route_observer', 'control_close', exited, { engine: projectionBaseEngine });
  assert.deepEqual(retired.observer, { kind: 'absent' });
  const releasing = releaseDesktopMemberControls(active, new Set(['route_observer']));
  assert.equal(releasing.observer.kind, 'releasing');
  assert.deepEqual(projectDesktopEngineExternal(engine, [releasing]), projectDesktopEngineExternal(engine, [active]));
  assert.deepEqual(projectDesktopEngineExternal(projectionBaseEngine, [releasing]).networks, projectionBaseEngine.networks);
  assert.throws(() => projectDesktopEngineExternal(projectionBaseEngine, [active]), /registered Desktop producer disappeared/u);
  assert.throws(() => projectDesktopEngineExternal(substituted, [releasing]), /exact builtin-network membership/u);
});
