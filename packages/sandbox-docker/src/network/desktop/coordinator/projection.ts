import { SandboxOperationError } from '@agen-ai/sandbox';
import { observationFingerprint } from '../observation/engine.js';
import type { DesktopEngineNetworkCensus } from '../observation/engine.js';
import { freezeObservation } from '../observation/data.js';
import type { DesktopVmInterface, DesktopVmObservation, DesktopVmRoute } from '../observation/vm.js';
import { desktopOwnedLinkLocalSettled, externalVmAuthority, requireSameAuthority, validateDesktopBridgeEvolution,
  validateDesktopBrokerReceipt, validateDesktopOwnedVm, validateDesktopRetiringBroker } from '../topology.js';
import type { DesktopOwnedBridge, DesktopStartedTopologyReceipt } from '../topology.js';
import { requireDesktopAllocationReadback } from './allocation.js';
import type { DesktopAllocation } from './allocation.js';
import { validateDesktopRetainedState, validateDesktopRetainedTransition, validateDesktopRetiringEndpoint } from './projection/retained.js';
import type { DesktopRetainedState, DesktopRetainedTransition } from './projection/retained.js';

export { captureDesktopRetainedTransition, captureDesktopRetainedState } from './projection/retained.js';
export type { DesktopRetainedState, DesktopRetainedTransition } from './projection/retained.js';

/** A releasing producer lost its control and may leave its builtin network; while present it must stay exact. */
export type DesktopBuiltinMembership = Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'present' | 'releasing'; id: string; name: string; endpointId: string }>;

export interface DesktopOwnedVmGraph {
  readonly devices: readonly DesktopVmInterface[];
  readonly routes: readonly DesktopVmRoute[];
  readonly fingerprint: string;
}

interface EndpointProjection {
  readonly owned: DesktopOwnedBridge;
  readonly started: DesktopStartedTopologyReceipt;
  readonly brokerName: string;
}

export type DesktopBridgeProjection = Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'empty'; owned: DesktopOwnedBridge }>
  | (EndpointProjection & Readonly<{ kind: 'starting_endpoint' }>)
  | (EndpointProjection & Readonly<{ kind: 'active'; graph: DesktopOwnedVmGraph }>)
  | (EndpointProjection & Readonly<{ kind: 'removing_endpoint'; transition: DesktopRetainedTransition }>)
  | Readonly<{ kind: 'retained'; owned: DesktopOwnedBridge; state: DesktopRetainedState }>
  | Readonly<{ kind: 'removing_bridge'; owned: DesktopOwnedBridge; state: DesktopRetainedState | null }>;

export interface DesktopMemberProjection {
  readonly memberId: string;
  readonly allocation: DesktopAllocation;
  readonly observer: DesktopBuiltinMembership;
  readonly none: Readonly<{ compute: DesktopBuiltinMembership; filesystem: DesktopBuiltinMembership }>;
  readonly bridge: DesktopBridgeProjection;
}

export interface DesktopCompleteObservation {
  readonly engine: DesktopEngineNetworkCensus;
  readonly vm: DesktopVmObservation;
}
export interface DesktopExternalProjection {
  readonly engine: Omit<DesktopEngineNetworkCensus, 'excludedCidrs'>;
  readonly vm: ReturnType<typeof externalVmAuthority>;
}
export interface DesktopMemberGraphReceipt {
  readonly memberId: string;
  readonly kind: 'absent' | 'empty' | 'endpoint' | 'retained';
  readonly settled: boolean;
  readonly graph: DesktopOwnedVmGraph | null;
}

function requireFact(condition: unknown, message: string): void {
  if (!condition) throw new SandboxOperationError('driver_failure', message);
}

function validateMembers(members: readonly DesktopMemberProjection[]): void {
  requireFact(members.length <= 4 && new Set(members.map((member) => member.memberId)).size === members.length,
    'Desktop projections exceed membership capacity or alias a member.');
  const ids: string[] = [];
  const slots: number[] = [];
  for (const member of members) {
    slots.push(member.allocation.slot);
    for (const entry of [member.observer, member.none.compute, member.none.filesystem]) if (entry.kind !== 'absent') ids.push(entry.id);
    if (member.bridge.kind !== 'absent') {
      const { owned } = member.bridge;
      requireDesktopAllocationReadback(member.allocation, owned);
      ids.push(owned.receipt.networkId);
      if ('started' in member.bridge) ids.push(member.bridge.started.broker.id);
    }
  }
  requireFact(new Set(ids).size === ids.length && new Set(slots).size === slots.length,
    'Desktop projections alias an original resource or subnet slot.');
}

function emptyEngine(owned: DesktopOwnedBridge, engine: DesktopEngineNetworkCensus): void {
  const network = engine.networks.find((candidate) => candidate.Id === owned.receipt.networkId);
  requireFact(network !== undefined, 'Registered Desktop bridge is absent from the Engine.');
  requireSameAuthority(network, owned.network, 'Empty Desktop network differs from its original exact receipt.');
  requireFact(Object.keys(owned.network.Containers).length === 0, 'Empty Desktop bridge receipt contains an endpoint.');
}

function validateBridgeEngine(bridge: DesktopBridgeProjection, engine: DesktopEngineNetworkCensus): void {
  if (bridge.kind === 'absent') return;
  if (bridge.kind === 'removing_bridge') {
    if (engine.networks.some((candidate) => candidate.Id === bridge.owned.receipt.networkId)) emptyEngine(bridge.owned, engine);
    return;
  }
  if (bridge.kind === 'empty' || bridge.kind === 'retained') { emptyEngine(bridge.owned, engine); return; }
  if (bridge.kind === 'removing_endpoint') { validateDesktopRetiringBroker(bridge.owned, engine, bridge.started, bridge.brokerName); return; }
  const network = engine.networks.find((candidate) => candidate.Id === bridge.owned.receipt.networkId);
  requireFact(network !== undefined, 'Registered Desktop endpoint network disappeared.');
  if (!network) throw new SandboxOperationError('driver_failure', 'Registered Desktop network is absent.');
  if (Object.keys(network.Containers).length === 0 && bridge.kind !== 'active') { emptyEngine(bridge.owned, engine); return; }
  validateDesktopBrokerReceipt(bridge.owned, engine, bridge.started);
  requireFact(network.Containers[bridge.started.broker.id]?.Name === bridge.brokerName, 'Desktop broker endpoint name differs from its original resource.');
}

export function projectDesktopEngineExternal(engine: DesktopEngineNetworkCensus, members: readonly DesktopMemberProjection[]): Omit<DesktopEngineNetworkCensus, 'excludedCidrs'> {
  validateMembers(members);
  const builtins = members.flatMap((member) => [
    { membership: member.observer, network: 'host', driver: 'host' },
    { membership: member.none.compute, network: 'none', driver: 'null' },
    { membership: member.none.filesystem, network: 'none', driver: 'null' },
  ]).flatMap((entry) => entry.membership.kind !== 'absent' ? [{ ...entry, membership: entry.membership }] : []);
  for (const member of members) validateBridgeEngine(member.bridge, engine);
  const ownedNetworks = new Set(members.flatMap((member) => member.bridge.kind === 'absent' ? [] : [member.bridge.owned.receipt.networkId]));
  const seen = new Set<string>();
  const networks = engine.networks.filter((network) => !ownedNetworks.has(network.Id)).map((network) => {
    const Containers = Object.fromEntries(Object.entries(network.Containers).filter(([id, endpoint]) => {
      const owned = builtins.find((entry) => entry.membership.id === id || id === `ep-${entry.membership.endpointId}`);
      if (!owned) return true;
      requireFact(!seen.has(owned.membership.id) && network.Name === owned.network && network.Driver === owned.driver
        && network.Scope === 'local' && network.IPAM.Config === null && endpoint.Name === owned.membership.name
        && /^[a-f0-9]{64}$/u.test(owned.membership.endpointId) && endpoint.EndpointID === owned.membership.endpointId
        && endpoint.MacAddress === '' && endpoint.IPv4Address === '' && endpoint.IPv6Address === '',
      'Desktop producer differs from its exact builtin-network membership.');
      seen.add(owned.membership.id); return false;
    }));
    return { ...network, Containers };
  });
  requireFact(builtins.every((entry) => entry.membership.kind === 'releasing' || seen.has(entry.membership.id)),
    'A registered Desktop producer disappeared or acquired another network.');
  const result = { id: engine.id, hostname: engine.hostname, kernel: engine.kernel, networks };
  freezeObservation(result);
  return result;
}

function vmGraph(current: DesktopVmObservation, devices: readonly DesktopVmInterface[]): DesktopOwnedVmGraph {
  const routes = current.snapshot.routes.filter((route) => devices.some((device) => device.index === route.interfaceIndex));
  const graph = { devices: [...devices], routes };
  freezeObservation(graph);
  return Object.freeze({ ...graph, fingerprint: observationFingerprint(graph) });
}

export function captureDesktopActiveGraph(owned: DesktopOwnedBridge, current: DesktopVmObservation): DesktopOwnedVmGraph {
  const devices = validateDesktopOwnedVm(current, owned, true);
  validateDesktopBridgeEvolution(owned.device, devices[0], devices[1]);
  requireFact(desktopOwnedLinkLocalSettled(devices), 'Desktop active authority requires settled link-local addresses.');
  return vmGraph(current, devices);
}

function memberGraph(member: DesktopMemberProjection, current: DesktopVmObservation): DesktopMemberGraphReceipt {
  const bridge = member.bridge;
  if (bridge.kind === 'absent') return Object.freeze({ memberId: member.memberId, kind: 'absent', settled: true, graph: null });
  if (bridge.kind === 'removing_bridge' && !current.snapshot.interfaces.some((device) => device.index === bridge.owned.device.index)) {
    return Object.freeze({ memberId: member.memberId, kind: 'absent', settled: true, graph: null });
  }
  let devices: readonly DesktopVmInterface[];
  let kind: DesktopMemberGraphReceipt['kind'];
  let settled = true;
  if (bridge.kind === 'retained') {
    devices = validateDesktopRetainedState(bridge.state, current); kind = 'retained';
  } else if (bridge.kind === 'removing_bridge' && bridge.state !== null) {
    devices = validateDesktopRetainedState(bridge.state, current); kind = 'retained'; settled = false;
  } else if (bridge.kind === 'removing_endpoint' && !current.snapshot.interfaces.some((device) => device.masterIndex === bridge.owned.device.index)) {
    const retained = validateDesktopRetainedTransition(bridge.transition, current);
    devices = retained.devices; kind = 'retained'; settled = retained.kind === 'settled';
  } else if (bridge.kind === 'removing_endpoint') {
    devices = validateDesktopRetiringEndpoint(bridge.transition, current, bridge.started.broker.macAddress); kind = 'endpoint'; settled = false;
  } else if (bridge.kind === 'empty' || bridge.kind === 'removing_bridge' || bridge.kind === 'starting_endpoint'
    && !current.snapshot.interfaces.some((device) => device.masterIndex === bridge.owned.device.index)) {
    devices = validateDesktopOwnedVm(current, bridge.owned, false);
    requireSameAuthority(devices[0], bridge.owned.device, 'Empty Desktop bridge identity changed.');
    kind = 'empty'; settled = bridge.kind === 'empty';
  } else {
    devices = validateDesktopOwnedVm(current, bridge.owned, true);
    validateDesktopBridgeEvolution(bridge.owned.device, devices[0], devices[1]);
    kind = 'endpoint'; settled = desktopOwnedLinkLocalSettled(devices);
    const graph = vmGraph(current, devices);
    if (bridge.kind === 'active') requireSameAuthority(graph, bridge.graph, 'Sealed Desktop member VM graph changed.');
  }
  return Object.freeze({ memberId: member.memberId, kind, settled, graph: vmGraph(current, devices) });
}

export function projectDesktopExternal(observation: DesktopCompleteObservation, members: readonly DesktopMemberProjection[]): Readonly<{
  external: DesktopExternalProjection;
  members: readonly DesktopMemberGraphReceipt[];
}> {
  const engine = projectDesktopEngineExternal(observation.engine, members);
  requireFact(observation.engine.kernel === observation.vm.snapshot.kernel, 'Desktop Engine and VM kernels differ.');
  const receipts = members.map((member) => {
    const receipt = memberGraph(member, observation.vm);
    const bridge = member.bridge;
    if (bridge.kind === 'removing_bridge') return Object.freeze({ ...receipt,
      settled: receipt.settled && !observation.engine.networks.some((network) => network.Id === bridge.owned.receipt.networkId) });
    if (bridge.kind === 'removing_endpoint') return Object.freeze({ ...receipt, settled: receipt.settled
      && validateDesktopRetiringBroker(bridge.owned, observation.engine, bridge.started, bridge.brokerName) });
    if (bridge.kind !== 'starting_endpoint') return receipt;
    const network = observation.engine.networks.find((candidate) => candidate.Id === bridge.owned.receipt.networkId);
    return Object.freeze({ ...receipt, settled: receipt.settled && network !== undefined && Object.keys(network.Containers).length === 1 });
  });
  const indexes = receipts.flatMap((receipt) => receipt.graph?.devices.map((device) => device.index) ?? []);
  requireFact(new Set(indexes).size === indexes.length, 'Desktop member projections alias a VM interface.');
  const external = { engine, vm: externalVmAuthority(observation.vm, indexes) };
  freezeObservation(external);
  return Object.freeze({ external, members: Object.freeze(receipts) });
}

export function validateDesktopProjectionCandidate(observation: Readonly<{
  engine: DesktopEngineNetworkCensus; vmBefore: DesktopVmObservation; vmAfter: DesktopVmObservation;
}>, members: readonly DesktopMemberProjection[], baseline: DesktopExternalProjection) {
  const before = projectDesktopExternal({ engine: observation.engine, vm: observation.vmBefore }, members);
  const after = projectDesktopExternal({ engine: observation.engine, vm: observation.vmAfter }, members);
  requireSameAuthority(before.external, baseline, 'External Desktop topology changed before the complete observation.');
  requireSameAuthority(after.external, baseline, 'External Desktop topology changed during the complete observation.');
  for (let index = 0; index < members.length; index += 1) {
    const kind = members[index].bridge.kind;
    requireFact(!(kind === 'starting_endpoint' && before.members[index].kind === 'endpoint' && after.members[index].kind === 'empty')
      && !(kind === 'removing_endpoint' && before.members[index].kind === 'retained' && after.members[index].kind === 'endpoint'),
    'Desktop endpoint transition moved backwards within one observation.');
  }
  const unsettled = Object.freeze(members.flatMap((member, index) => before.members[index].settled && after.members[index].settled
    && before.members[index].graph?.fingerprint === after.members[index].graph?.fingerprint ? [] : [member.memberId]));
  return Object.freeze({ external: after.external, members: after.members, settled: unsettled.length === 0, unsettled });
}
