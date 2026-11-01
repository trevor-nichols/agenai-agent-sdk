import { observationFingerprint } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.js';
import type { DesktopEngineNetworkCensus } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.js';
import type { DesktopVmInterface, DesktopVmObservation, DesktopVmRoute } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.js';
import { externalVmAuthority, requireSameAuthority, validateDesktopBridgeEvolution,
  validateDesktopBrokerReceipt, validateDesktopOwnedVm } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.js';
import type { DesktopOwnedBridge, DesktopStartedTopologyReceipt } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.js';

export interface CompleteObservation { readonly engine: DesktopEngineNetworkCensus; readonly vm: DesktopVmObservation }
export interface MemberProjection {
  readonly observerId: string | null;
  readonly noneIds: readonly string[];
  readonly bridge: Readonly<{ owned: DesktopOwnedBridge; phase: 'empty' }>
    | Readonly<{ owned: DesktopOwnedBridge; phase: 'endpoint'; started: DesktopStartedTopologyReceipt;
      sealed: Readonly<{ devices: readonly DesktopVmInterface[]; routes: readonly DesktopVmRoute[] }> }> | null;
}

/** Validate every admitted identity before removing it from the unchanged external comparison. */
export function projectExternal(observation: CompleteObservation, members: readonly MemberProjection[]): unknown {
  const observerIds = members.flatMap((member) => member.observerId === null ? [] : [member.observerId]);
  const noneIds = members.flatMap((member) => member.noneIds);
  const ownedNetworks = members.flatMap((member) => member.bridge === null ? [] : [member.bridge.owned.receipt.networkId]);
  const claimedIds = [...observerIds, ...noneIds, ...ownedNetworks];
  if (new Set(claimedIds).size !== claimedIds.length) throw new Error('Member projections alias an owned identity.');
  const seen = new Set<string>();
  const indexes: number[] = [];
  for (const member of members) {
    if (member.bridge === null) continue;
    const { owned, phase } = member.bridge;
    const actual = observation.engine.networks.find((network) => network.Id === owned.receipt.networkId);
    if (!actual) throw new Error('Registered member network is absent.');
    const devices = validateDesktopOwnedVm(observation.vm, owned, phase === 'endpoint');
    if (phase === 'endpoint') {
      validateDesktopBridgeEvolution(owned.device, devices[0], devices[1]);
      validateDesktopBrokerReceipt(owned, observation.engine, member.bridge.started);
      requireSameAuthority({ devices, routes: observation.vm.snapshot.routes.filter((route) => devices.some((device) => device.index === route.interfaceIndex)) },
        member.bridge.sealed, 'Sealed member VM identity changed.');
    } else {
      requireSameAuthority(actual, owned.network, 'Retained or empty network changed.');
      requireSameAuthority(devices[0], owned.device, 'Retained or empty bridge changed.');
    }
    indexes.push(...devices.map((device) => device.index));
  }
  if (new Set(indexes).size !== indexes.length) throw new Error('Member projections alias a VM interface.');
  const networks = observation.engine.networks.filter((network) => !ownedNetworks.includes(network.Id)).map((network) => {
    const Containers = Object.fromEntries(Object.entries(network.Containers).filter(([id, endpoint]) => {
      if (!observerIds.includes(id) && !noneIds.includes(id)) return true;
      if (seen.has(id)) throw new Error('Registered member occurs twice.');
      const host = observerIds.includes(id);
      if (network.Name !== (host ? 'host' : 'none') || network.Driver !== (host ? 'host' : 'null')
        || endpoint.EndpointID !== '' || endpoint.MacAddress !== '' || endpoint.IPv4Address !== '' || endpoint.IPv6Address !== '') {
        throw new Error('Registered producer is not its exact builtin-network projection.');
      }
      seen.add(id); return false;
    }));
    return { ...network, Containers };
  });
  if (seen.size !== observerIds.length + noneIds.length) throw new Error('Registered producer disappeared.');
  return { engine: { id: observation.engine.id, hostname: observation.engine.hostname, kernel: observation.engine.kernel, networks },
    vm: externalVmAuthority(observation.vm, indexes) };
}

export function requireRegisteredTransition(observation: CompleteObservation, externalBaseline: unknown,
  alternatives: readonly (readonly MemberProjection[])[]): number {
  for (let index = 0; index < alternatives.length; index += 1) {
    try {
      const projected = projectExternal(observation, alternatives[index]);
      if (observationFingerprint(projected) === observationFingerprint(externalBaseline)) return index;
    } catch { /* A finite alternative may not be the observed phase; none widens the baseline. */ }
  }
  throw new Error('Observation is outside every exact registered transition projection.');
}
