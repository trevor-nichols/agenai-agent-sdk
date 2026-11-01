import { SandboxOperationError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { ResourceInspection } from '../../../resources/inspect.js';
import { parseNumericAddress } from '../../address.js';
import { desktopBridgeName, resourceLabels } from '../../../recovery/identity.js';
import { identifyDesktopOwnedBridge } from '../topology.js';
import type { DesktopStartedTopologyReceipt } from '../topology.js';
import type { DesktopCompleteObservation } from '../observation/complete.js';
import type { DesktopEngineNetworkCensus } from '../observation/engine.js';
import type { DesktopBuiltinMembership, DesktopMemberProjection } from './projection.js';
import { captureDesktopRetainedTransition } from './projection.js';
import { releaseDesktopRetainedTransition } from './projection/retained.js';
import type { ResourceAction, ResourceRole } from './journal/schema.js';

function fail(message: string): never { throw new SandboxOperationError('driver_failure', message); }

function builtin(record: SandboxRecoveryRecord, role: 'route_observer' | 'compute' | 'filesystem', inspection: ResourceInspection | undefined,
  engine: DesktopEngineNetworkCensus, action: ResourceAction, previous: DesktopBuiltinMembership): DesktopBuiltinMembership {
  if (!inspection?.container) return Object.freeze({ kind: 'absent' });
  const container = inspection.container;
  const expected = role === 'route_observer' ? 'host' : 'none';
  const attachments = Object.entries(container.NetworkSettings.Networks);
  if (role === 'filesystem') {
    if (container.Config.NetworkDisabled !== true || attachments.length !== 0) fail('Desktop filesystem acquired an independent network attachment.');
    return Object.freeze({ kind: 'absent' });
  }
  const network = engine.networks.find((entry) => entry.Name === expected && entry.Driver === (expected === 'host' ? 'host' : 'null'));
  if (!network || attachments.length > 1 || attachments.some(([name, endpoint]) => name !== expected
    || endpoint.NetworkID !== network.Id && !(container.State.Status === 'created' && endpoint.NetworkID === ''
      && (endpoint.EndpointID === undefined || endpoint.EndpointID === '')))) {
    fail('Desktop producer container attachment differs from its exact builtin network.');
  }
  const present = Object.hasOwn(network.Containers, inspection.id) || !container.State.Running && previous.kind !== 'absent'
    && previous.id === inspection.id && Object.hasOwn(network.Containers, `ep-${previous.endpointId}`);
  if (present && (attachments.length !== 1 || attachments[0]?.[1].NetworkID !== network.Id)) {
    fail('Desktop Engine membership lacks its independently inspected container attachment.');
  }
  if (container.State.Running && (!present || attachments.length !== 1)) fail('Running Desktop producer lacks its exact builtin membership.');
  const resource = record.resources.find((entry) => entry.role === role);
  if (!resource) fail('Desktop producer lost its original role identity.');
  if (!present) return Object.freeze({ kind: 'absent' });
  const currentEndpointId = attachments[0]?.[1].EndpointID;
  const endpointId = currentEndpointId === '' && !container.State.Running && action === 'control_close'
    && previous.kind !== 'absent' && previous.id === inspection.id && previous.name === resource.name
    ? previous.endpointId : currentEndpointId;
  if (endpointId === undefined || !/^[a-f0-9]{64}$/u.test(endpointId)) fail('Desktop builtin membership lacks its original inspected endpoint identity.');
  return Object.freeze({ kind: 'present', id: inspection.id, name: resource.name, endpointId });
}

function brokerReceipt(inspection: ResourceInspection, networkId: string): DesktopStartedTopologyReceipt {
  const attachments = Object.values(inspection.container?.NetworkSettings.Networks ?? {});
  const endpoint = attachments[0];
  if (attachments.length !== 1 || !endpoint || endpoint.NetworkID !== networkId
    || !endpoint.EndpointID || !/^[a-f0-9]{64}$/u.test(endpoint.EndpointID)
    || !endpoint.MacAddress || !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(endpoint.MacAddress)
    || !endpoint.IPAddress || parseNumericAddress(endpoint.IPAddress)?.family !== 4
    || !endpoint.Gateway || parseNumericAddress(endpoint.Gateway)?.family !== 4 || endpoint.IPPrefixLen !== 28) {
    fail('Desktop broker lacks its exact reserved /28 container endpoint receipt.');
  }
  return { broker: { id: inspection.id, networkId, endpointId: endpoint.EndpointID, macAddress: endpoint.MacAddress,
    address: endpoint.IPAddress, prefixLength: endpoint.IPPrefixLen, gateway: endpoint.Gateway },
  members: { compute: { kind: 'absent' }, filesystem: { kind: 'absent' } } };
}

/** A producer whose control failed exits with it (StdinOnce); its exact removal settles later under cleanup. */
export function releaseDesktopMemberControls(projection: DesktopMemberProjection, released: ReadonlySet<ResourceRole>): DesktopMemberProjection {
  const { observer, bridge } = projection;
  const releasedObserver = released.has('route_observer') && observer.kind === 'present'
    ? Object.freeze({ ...observer, kind: 'releasing' as const }) : observer;
  const releasedBridge = released.has('egress_broker') && bridge.kind === 'active'
    ? { kind: 'removing_endpoint' as const, owned: bridge.owned, started: bridge.started, brokerName: bridge.brokerName,
      transition: releaseDesktopRetainedTransition(bridge.owned, bridge.graph) } : bridge;
  return releasedObserver === observer && releasedBridge === bridge ? projection
    : { ...projection, observer: releasedObserver, bridge: releasedBridge };
}

export function beginDesktopRemoval(projection: DesktopMemberProjection, role: ResourceRole, action: ResourceAction,
  observation: DesktopCompleteObservation | undefined): DesktopMemberProjection {
  if (action !== 'delete' && action !== 'control_close') return projection;
  const bridge = projection.bridge;
  if (role === 'egress_broker' && bridge.kind === 'active') {
    if (!observation) fail('Desktop broker removal requires its original complete observation.');
    return { ...projection, bridge: { kind: 'removing_endpoint', owned: bridge.owned, started: bridge.started,
      brokerName: bridge.brokerName, transition: captureDesktopRetainedTransition(bridge.owned, observation.vmAfter) } };
  }
  if (role === 'network' && bridge.kind !== 'absent' && bridge.kind !== 'removing_bridge') {
    if (bridge.kind !== 'empty' && bridge.kind !== 'retained') fail('Desktop bridge removal requires an exact empty graph.');
    return { ...projection, bridge: { kind: 'removing_bridge', owned: bridge.owned, state: bridge.kind === 'retained' ? bridge.state : null } };
  }
  return projection;
}

export function observeDesktopMemberEffect(projection: DesktopMemberProjection, record: SandboxRecoveryRecord, role: ResourceRole,
  action: ResourceAction, inspection: ResourceInspection | undefined, observation: Readonly<{
    engine: DesktopEngineNetworkCensus; complete?: DesktopCompleteObservation;
  }>): DesktopMemberProjection {
  if (role === 'route_observer') return { ...projection, observer: builtin(record, role, inspection, observation.engine, action, projection.observer) };
  if (role === 'compute' || role === 'filesystem') return { ...projection,
    none: { ...projection.none, [role]: builtin(record, role, inspection, observation.engine, action, projection.none[role]) } };
  if ((role === 'egress_relay' || role === 'export') && inspection?.container
    && Object.keys(inspection.container.NetworkSettings.Networks).length !== 0) fail('Desktop accessor or relay acquired an independent attachment.');
  if (role === 'network' && action === 'create') {
    const resource = record.resources.find((entry) => entry.role === 'network');
    if (!inspection || !resource || !observation.complete) fail('Desktop network acquisition requires its exact full observation.');
    const owned = identifyDesktopOwnedBridge({ networkId: inspection.id, name: resource.name,
      bridgeName: desktopBridgeName(record), labels: resourceLabels(record, 'network') }, observation.engine, observation.complete.vmAfter);
    return { ...projection, bridge: { kind: 'empty', owned } };
  }
  if (role === 'egress_broker' && (action === 'create' || action === 'start')) {
    if (!inspection?.container || projection.bridge.kind === 'absent') fail('Desktop broker requires its original bridge and exact container.');
    const bridge = projection.bridge;
    const networks = Object.entries(inspection.container.NetworkSettings.Networks);
    if (networks.length > 1 || networks.some(([name, attachment]) => name !== bridge.owned.receipt.name
      && name !== bridge.owned.receipt.networkId || attachment.NetworkID !== bridge.owned.receipt.networkId
      && !(inspection.container?.State.Status === 'created' && attachment.NetworkID === ''))) fail('Created Desktop broker acquired another network.');
    const network = observation.engine.networks.find((entry) => entry.Id === bridge.owned.receipt.networkId);
    if (action === 'create' && network && Object.keys(network.Containers).length === 0) return projection;
    const resource = record.resources.find((entry) => entry.role === 'egress_broker');
    if (!resource) fail('Desktop broker lost its original role name.');
    return { ...projection, bridge: { kind: 'starting_endpoint', owned: bridge.owned,
      started: brokerReceipt(inspection, bridge.owned.receipt.networkId), brokerName: resource.name } };
  }
  return projection;
}
