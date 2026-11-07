import assert from 'node:assert/strict';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { DockerEngine } from '../../src/engine/client.js';
import { DockerApi } from '../../src/resources/api.js';
import type { ResourceInspection } from '../../src/resources/inspect.js';
import type { DockerSandboxConfig } from '../../src/policy/config.js';
import { desktopBridgeName, newRecoveryRecord, resourceLabels } from '../../src/recovery/identity.js';
import { DesktopCoordinatorTopologyOwner } from '../../src/network/desktop/coordinator/topologyOwner.js';
import type { DockerDesktopRouteAuthorityBinding } from '../../src/network/routeAuthority.js';
import { parseDesktopHostObservation } from '../../src/network/desktop/observation/host.js';
import { readDesktopEngineIdentity, readDesktopEngineNetworks } from '../../src/network/desktop/observation/engine.js';
import type { DesktopEngineNetwork } from '../../src/network/desktop/observation/engine.js';
import { desktopHostDocument } from './desktopObservation.js';
import { desktopRouteAuthorityOptions } from './desktopRouteAuthority.js';
import { engineFixture, imageDigest, sandboxRequest } from './engine.js';
import { coordinatorProjectionMember, projectionBaseEngine, projectionBaseVm, vmObservation } from './desktopCoordinatorProjection.js';

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

function bridgeNetwork(id: string, name: string, subnet: string, options: Record<string, string>): DesktopEngineNetwork {
  return { Id: id, Name: name, Created: '2026-11-06T00:00:00Z', Driver: 'bridge', Scope: 'local', Internal: false, Attachable: false,
    Ingress: false, EnableIPv6: false, ConfigOnly: false, IPAM: { Driver: 'default', Options: null, Config: [{ Subnet: subnet }] },
    Options: options, Labels: {}, Containers: {} };
}

/** Moby recreates its default bridge with a new identity each time the daemon starts. */
export function defaultBridge(boot: number): DesktopEngineNetwork {
  return bridgeNetwork(boot.toString(16).padStart(64, 'd'), 'bridge', '172.17.0.0/16',
    { 'com.docker.network.bridge.default_bridge': 'true', 'com.docker.network.bridge.name': 'docker0' });
}

// Native wake-settle-r1: after a boot, Desktop's eth0 link-local address stays tentative until duplicate address detection
// completes, and gains its local route at that moment.
function desktopLinkLocal(tentative: boolean) {
  const address = 'fe80:0:0:0:90c6:71ff:feec:297a';
  return {
    address: { family: 6 as const, address, prefix: 64, scope: 253, flags: tentative ? 0xc0 : 0x80, peer: null, broadcast: null, anycast: null,
      attributes: [`8:0:${tentative ? 'c0' : '80'}000000`] },
    routes: tentative ? [] : [{ family: 6 as const, destination: address, prefix: 128, source: null, sourcePrefix: 0, interfaceIndex: 7,
      gateways: [], nextHops: [], table: 255, protocol: 2, scope: 0, type: 2, flags: 0, preferredSource: null, priority: 0, attributes: [] }],
  };
}

export async function lifecycleTopology(options: Readonly<{ stoppedVm?: boolean; tentativeReadsAfterWake?: number }> = {}) {
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
  let boot = 0;
  let foreignSubnet: string | undefined;
  const liveNetworks = () => [
    { ...projectionBaseEngine.networks[0], Containers: Object.fromEntries(members.flatMap((member) => member.observer === 'running'
      || member.observer === 'detached' ? [[member.observer === 'running' ? member.geometry.observerId : `ep-${observerEndpoint(member)}`,
        endpoint(resource(member.record, 'route_observer').name, observerEndpoint(member))]] : [])) },
    projectionBaseEngine.networks[1], defaultBridge(boot),
    ...foreignSubnet ? [bridgeNetwork('e'.repeat(64), 'foreign', foreignSubnet, {})] : [],
    ...members.flatMap((member) => member.network ? [bridged(member, member.network)] : []),
  ];
  // While Resource Saver has stopped the VM, Desktop answers reads from the census taken when it stopped.
  let stoppedCensus = options.stoppedVm ? liveNetworks() : undefined;
  let tentativeReads = 0;
  const wakeVm = () => { if (stoppedCensus) { stoppedCensus = undefined; boot += 1; tentativeReads = options.tentativeReadsAfterWake ?? 0; } };
  let drift = false;
  const vm = () => {
    const linkLocal = options.tentativeReadsAfterWake === undefined ? undefined : desktopLinkLocal(tentativeReads > 0);
    tentativeReads = Math.max(0, tentativeReads - 1);
    return vmObservation({ ...projectionBaseVm.snapshot,
      interfaces: [...projectionBaseVm.snapshot.interfaces.map((device) => {
        const named = drift ? { ...device, name: `${device.name}-changed` } : device;
        return linkLocal ? { ...named, addresses: [...named.addresses, linkLocal.address] } : named;
      }), ...members.flatMap((member) => memberGraph(member).interfaces)],
      routes: [...projectionBaseVm.snapshot.routes, ...linkLocal?.routes ?? [], ...members.flatMap((member) => memberGraph(member).routes)],
    });
  };
  let replacedIdentity: Readonly<{ Name?: string; KernelVersion?: string }> | undefined;
  const fixture = await engineFixture({ kernelVersion: projectionBaseVm.snapshot.kernel, async handleRequest({ path, response }) {
    const current = stoppedCensus ?? liveNetworks();
    const body = path === '/info' && replacedIdentity
      ? { ID: 'daemon-unit-1', Name: 'route-unit-host', KernelVersion: projectionBaseVm.snapshot.kernel, ...replacedIdentity }
      : path === '/v1.52/networks' ? current.map(({ Id }) => ({ Id }))
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
    async assertEndpoint() {}, captureEngineBaseline, captureEngineAuthority: async () => ({ host, engine: await readDesktopEngineIdentity(api) }) });
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
    member.observer = 'created'; wakeVm();
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
  return { manager, addMember, close: () => fixture.close(),
    drift: () => { drift = true; },
    addForeignNetwork: (subnet = '172.18.0.0/16') => { foreignSubnet = subnet; },
    stopVm: () => { stoppedCensus = liveNetworks(); },
    replaceEngineIdentity: (identity: Readonly<{ Name?: string; KernelVersion?: string }>) => { replacedIdentity = identity; },
  };
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
