import { parseDesktopVmObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.js';
import type { DesktopVmObservation, DesktopVmSnapshot } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.js';
import type { DesktopEngineNetwork, DesktopEngineNetworkCensus } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.js';
import { observationFingerprint } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.js';
import { identifyDesktopOwnedBridge, validateDesktopOwnedVm } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.js';
import { desktopVmDocument } from '../../../../../../../packages/ai/sandbox-docker/tests/fixtures/desktopObservation.js';
import { deniedCoverage } from '../../../../../../../packages/ai/sandbox-docker/src/network/policy.js';
import type { CompleteObservation, MemberProjection } from './projection.js';

// Synthetic identities and composed source-test observations; never native experiment receipts.
const id = (number: number) => number.toString(16).padStart(64, '0');
const builtin = (number: number, name: string, driver: string): DesktopEngineNetwork => ({
  Id: id(number), Name: name, Created: '2026-10-29T00:00:00Z', Driver: driver, Scope: 'local',
  Internal: false, Attachable: false, Ingress: false, EnableIPv6: false, ConfigOnly: false,
  IPAM: { Driver: 'default', Options: null, Config: null }, Options: {}, Labels: {}, Containers: {},
});
const baseVm = parseDesktopVmObservation(desktopVmDocument());

function observation(networks: readonly DesktopEngineNetwork[], snapshot: DesktopVmSnapshot): CompleteObservation {
  const engine: DesktopEngineNetworkCensus = { id: 'synthetic-engine', hostname: 'synthetic-vm', kernel: snapshot.kernel,
    networks, excludedCidrs: deniedCoverage(networks.flatMap((network) => (network.IPAM.Config ?? []).flatMap((config) => config.Subnet ?? []))) };
  return { engine, vm: { snapshot, excludedCidrs: [], fingerprint: observationFingerprint(snapshot) } };
}

export const baseline = observation([builtin(1, 'host', 'host'), builtin(2, 'none', 'null')], baseVm.snapshot);

export function memberFixture(index: number) {
  const bridgeName = `research${index}`;
  const subnet = `172.30.${42 + index}.0/24`; const gateway = `172.30.${42 + index}.1`;
  const labels = { 'ai.agen.sandbox.owner': `synthetic-${index}` };
  const observerId = id(100 + index); const computeId = id(200 + index); const brokerId = id(300 + index);
  const networkId = id(400 + index); const endpointId = id(500 + index);
  const translate = (endpoint: boolean): DesktopVmObservation => {
    const original = parseDesktopVmObservation(desktopVmDocument({ bridgeName, broker: endpoint }));
    const interfaces = original.snapshot.interfaces.filter((device) => device.index !== 7).map((device) => ({ ...device,
      index: device.index + index * 10, masterIndex: device.masterIndex === null ? null : device.masterIndex + index * 10,
      addresses: device.addresses.map((address) => ({ ...address,
        address: address.address.replace('172.30.42.', `172.30.${42 + index}.`),
        broadcast: address.broadcast?.replace('172.30.42.', `172.30.${42 + index}.`) ?? null })) }));
    const routes = original.snapshot.routes.filter((route) => route.interfaceIndex !== 7).map((route) => ({ ...route,
      interfaceIndex: route.interfaceIndex === null ? null : route.interfaceIndex + index * 10,
      destination: route.destination.replace('172.30.42.', `172.30.${42 + index}.`),
      preferredSource: route.preferredSource?.replace('172.30.42.', `172.30.${42 + index}.`) ?? null }));
    const snapshot = { ...original.snapshot, interfaces, routes };
    return { snapshot, excludedCidrs: [], fingerprint: observationFingerprint(snapshot) };
  };
  const emptyVm = translate(false); const endpointVm = translate(true);
  const network: DesktopEngineNetwork = { ...builtin(400 + index, `member-${index}`, 'bridge'), Labels: labels,
    Options: { 'com.docker.network.bridge.name': bridgeName },
    IPAM: { Driver: 'default', Options: null, Config: [{ Subnet: subnet, Gateway: gateway }] },
    Status: { IPAM: { Subnets: { [subnet]: { IPsInUse: 3, DynamicIPsAvailable: 253 } } } } };
  const owned = identifyDesktopOwnedBridge({ networkId, name: network.Name, bridgeName, labels },
    observation([network], emptyVm.snapshot).engine, emptyVm);
  const started = { broker: { id: brokerId, networkId, endpointId, macAddress: '02:42:ac:1e:2a:02',
    address: `172.30.${42 + index}.2`, prefixLength: 24, gateway },
    members: { compute: { kind: 'present' as const, id: computeId }, filesystem: { kind: 'absent' as const } } };
  const devices = validateDesktopOwnedVm(endpointVm, owned, true);
  const empty: MemberProjection = { observerId, noneIds: [], bridge: { phase: 'empty', owned } };
  const active: MemberProjection = { observerId, noneIds: [computeId], bridge: { phase: 'endpoint', owned, started,
    sealed: { devices, routes: endpointVm.snapshot.routes } } };
  const retained: MemberProjection = { observerId: null, noneIds: [], bridge: { phase: 'empty', owned } };
  return { observerId, computeId, empty, active, retained, emptyVm, endpointVm, network,
    endpointNetwork: { ...network, Containers: { [brokerId]: { Name: `broker-${index}`, EndpointID: endpointId,
      MacAddress: started.broker.macAddress, IPv4Address: `${started.broker.address}/24`, IPv6Address: '' } },
    Status: { IPAM: { Subnets: { [subnet]: { IPsInUse: 4, DynamicIPsAvailable: 252 } } } } } };
}

export function compose(members: readonly Readonly<{ fixture: ReturnType<typeof memberFixture>; phase: 'empty' | 'active' | 'retained' }>[]): CompleteObservation {
  const endpoint = (name: string) => ({ Name: name, EndpointID: '', MacAddress: '', IPv4Address: '', IPv6Address: '' });
  const host = { ...baseline.engine.networks[0], Containers: Object.fromEntries(members.filter((member) => member.phase !== 'retained')
    .map(({ fixture }) => [fixture.observerId, endpoint('observer')])) };
  const none = { ...baseline.engine.networks[1], Containers: Object.fromEntries(members.filter((member) => member.phase === 'active')
    .map(({ fixture }) => [fixture.computeId, endpoint('compute')])) };
  const snapshot = { ...baseVm.snapshot,
    interfaces: [...baseVm.snapshot.interfaces, ...members.flatMap(({ fixture, phase }) => (phase === 'active' ? fixture.endpointVm : fixture.emptyVm).snapshot.interfaces)],
    routes: [...baseVm.snapshot.routes, ...members.flatMap(({ fixture, phase }) => (phase === 'active' ? fixture.endpointVm : fixture.emptyVm).snapshot.routes)] };
  return observation([host, none, ...members.map(({ fixture, phase }) => phase === 'active' ? fixture.endpointNetwork : fixture.network)], snapshot);
}
