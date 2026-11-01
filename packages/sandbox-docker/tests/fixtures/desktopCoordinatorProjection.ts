import { observationFingerprint } from '../../src/network/desktop/observation/engine.js';
import type { DesktopEngineNetwork, DesktopEngineNetworkCensus } from '../../src/network/desktop/observation/engine.js';
import { parseDesktopVmObservation } from '../../src/network/desktop/observation/vm.js';
import type { DesktopVmInterface, DesktopVmObservation, DesktopVmSnapshot } from '../../src/network/desktop/observation/vm.js';
import { identifyDesktopOwnedBridge } from '../../src/network/desktop/topology.js';
import type { DesktopStartedTopologyReceipt } from '../../src/network/desktop/topology.js';
import { captureDesktopActiveGraph } from '../../src/network/desktop/coordinator/projection.js';
import type { DesktopMemberProjection } from '../../src/network/desktop/coordinator/projection.js';
import { desktopVmDocument } from './desktopObservation.js';

const id = (number: number) => number.toString(16).padStart(64, '0');
const builtin = (number: number, name: string, driver: string): DesktopEngineNetwork => ({
  Id: id(number), Name: name, Created: '2026-10-29T00:00:00Z', Driver: driver, Scope: 'local',
  Internal: false, Attachable: false, Ingress: false, EnableIPv6: false, ConfigOnly: false,
  IPAM: { Driver: 'default', Options: null, Config: null }, Options: {}, Labels: {}, Containers: {},
});
export const projectionBaseVm = parseDesktopVmObservation(desktopVmDocument());
export const projectionBaseEngine: DesktopEngineNetworkCensus = {
  id: 'synthetic-engine', hostname: 'synthetic-vm', kernel: projectionBaseVm.snapshot.kernel,
  networks: [builtin(1, 'host', 'host'), builtin(2, 'none', 'null')], excludedCidrs: [],
};
export const projectionBaseline = {
  engine: { id: projectionBaseEngine.id, hostname: projectionBaseEngine.hostname, kernel: projectionBaseEngine.kernel,
    networks: projectionBaseEngine.networks }, vm: projectionBaseVm.snapshot,
};
export function vmObservation(snapshot: DesktopVmSnapshot): DesktopVmObservation {
  return { snapshot, excludedCidrs: [], fingerprint: observationFingerprint(snapshot) };
}

// Synthetic member identities around decoded native-wire fixtures; no native qualification receipt.
export function coordinatorProjectionMember(slot: number) {
  const bridgeName = `member${slot}`;
  const subnet = `10.240.0.${slot * 16}/28`; const gateway = `10.240.0.${slot * 16 + 1}`;
  const observerId = id(100 + slot); const computeId = id(200 + slot); const brokerId = id(300 + slot);
  const networkId = id(400 + slot); const endpointId = id(500 + slot);
  const labels = { 'ai.agen.synthetic.owner': `member-${slot}` };
  const translate = (endpoint: boolean, returnedPeer?: number) => {
    const original = parseDesktopVmObservation(desktopVmDocument({ bridgeName, broker: endpoint, ...(returnedPeer ? { returnedPeer } : {}) }));
    const replace = (address: string) => address.replace('172.30.42.255', `10.240.0.${slot * 16 + 15}`)
      .replace('172.30.42.1', gateway).replace('172.30.42.0', subnet.split('/')[0]);
    const sameNamespaceLink = (device: DesktopVmInterface) => {
      if (device.networkNamespaceId !== null || device.linkIndex === null) return {};
      const link = Buffer.alloc(4); link.writeUInt32LE(device.linkIndex + slot * 10);
      return { linkIndex: device.linkIndex + slot * 10,
        attributes: device.attributes.map((entry) => entry.startsWith('5:') ? `5:0:${link.toString('hex')}` : entry).sort() };
    };
    return vmObservation({ ...original.snapshot,
      interfaces: original.snapshot.interfaces.filter((device) => device.index !== 7).map((device) => ({ ...device, ...sameNamespaceLink(device),
        index: device.index + slot * 10, masterIndex: device.masterIndex === null ? null : device.masterIndex + slot * 10,
        addresses: device.addresses.map((address) => ({ ...address, address: replace(address.address),
          prefix: address.family === 4 ? 28 : address.prefix, broadcast: address.broadcast === null ? null : replace(address.broadcast) })) })),
      routes: original.snapshot.routes.filter((route) => route.interfaceIndex !== 7).map((route) => ({ ...route,
        interfaceIndex: route.interfaceIndex === null ? null : route.interfaceIndex + slot * 10,
        destination: replace(route.destination), prefix: route.family === 4 && route.prefix === 24 ? 28 : route.prefix,
        preferredSource: route.preferredSource === null ? null : replace(route.preferredSource) })) });
  };
  const emptyVm = translate(false); const endpointVm = translate(true); const returnedVm = translate(true, 12);
  const network: DesktopEngineNetwork = { ...builtin(400 + slot, `network-${slot}`, 'bridge'), Labels: labels,
    Options: { 'com.docker.network.bridge.name': bridgeName },
    IPAM: { Driver: 'default', Options: null, Config: [{ Subnet: subnet, Gateway: gateway }] },
    Status: { IPAM: { Subnets: { [subnet]: { IPsInUse: 3, DynamicIPsAvailable: 13 } } } } };
  const owned = identifyDesktopOwnedBridge({ networkId, name: network.Name, bridgeName, labels },
    { ...projectionBaseEngine, networks: [network] }, emptyVm);
  const started: DesktopStartedTopologyReceipt = { broker: { id: brokerId, networkId, endpointId,
    macAddress: '02:42:ac:1e:2a:02', address: `10.240.0.${slot * 16 + 2}`, prefixLength: 28, gateway },
  members: { compute: { kind: 'present', id: computeId }, filesystem: { kind: 'absent' } } };
  const allocation = { slot, subnet, gateway };
  const base = { memberId: `member-${slot}`, allocation, observer: { kind: 'present' as const, id: observerId, name: `observer-${slot}`, endpointId: id(600 + slot) },
    none: { compute: { kind: 'absent' as const }, filesystem: { kind: 'absent' as const } } };
  const empty: DesktopMemberProjection = { ...base, bridge: { kind: 'empty', owned } };
  const starting: DesktopMemberProjection = { ...base, bridge: { kind: 'starting_endpoint', owned, started, brokerName: `broker-${slot}` } };
  const active: DesktopMemberProjection = { ...base,
    none: { ...base.none, compute: { kind: 'present', id: computeId, name: `compute-${slot}`, endpointId: id(700 + slot) } },
    bridge: { kind: 'active', owned, started, brokerName: `broker-${slot}`, graph: captureDesktopActiveGraph(owned, endpointVm) } };
  const endpointNetwork: DesktopEngineNetwork = { ...network,
    Containers: { [brokerId]: { Name: `broker-${slot}`, EndpointID: endpointId, MacAddress: started.broker.macAddress,
      IPv4Address: `${started.broker.address}/28`, IPv6Address: '' } },
    Status: { IPAM: { Subnets: { [subnet]: { IPsInUse: 4, DynamicIPsAvailable: 12 } } } } };
  return { slot, observerId, computeId, brokerId, network, endpointNetwork, owned, started, empty, starting, active, emptyVm, endpointVm, returnedVm };
}

export function composeProjection(members: readonly Readonly<{
  fixture: ReturnType<typeof coordinatorProjectionMember>; projection: DesktopMemberProjection; vm: DesktopVmObservation; endpoint: boolean;
}>[]) {
  const endpoint = (Name: string, EndpointID: string) => ({ Name, EndpointID, MacAddress: '', IPv4Address: '', IPv6Address: '' });
  const host = { ...projectionBaseEngine.networks[0], Containers: Object.fromEntries(members.flatMap(({ projection }) =>
    projection.observer.kind === 'present' ? [[projection.observer.id, endpoint(projection.observer.name, projection.observer.endpointId)]] : [])) };
  const none = { ...projectionBaseEngine.networks[1], Containers: Object.fromEntries(members.flatMap(({ projection }) =>
    [projection.none.compute, projection.none.filesystem].flatMap((membership) => membership.kind === 'present'
      ? [[membership.id, endpoint(membership.name, membership.endpointId)]] : []))) };
  return { engine: { ...projectionBaseEngine, networks: [host, none,
    ...members.map(({ fixture, endpoint: active }) => active ? fixture.endpointNetwork : fixture.network)] },
  vm: vmObservation({ ...projectionBaseVm.snapshot,
    interfaces: [...projectionBaseVm.snapshot.interfaces, ...members.flatMap(({ vm }) => vm.snapshot.interfaces)],
    routes: [...projectionBaseVm.snapshot.routes, ...members.flatMap(({ vm }) => vm.snapshot.routes)] }) };
}
