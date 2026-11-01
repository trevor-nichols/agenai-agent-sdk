import { observationFingerprint } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.js';
import type { DesktopVmInterface, DesktopVmObservation, DesktopVmRoute } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.js';
import { desktopOwnedLinkLocalSettled, validateDesktopBridgeEvolution, validateDesktopOwnedVm } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.js';
import type { DesktopOwnedBridge } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.js';
import { nativeAddressNumber, prefixMask, formatNumericAddress } from '../../../../../../../packages/ai/sandbox-docker/src/network/address.js';

export interface DesktopRetainedTransition {
  readonly owned: DesktopOwnedBridge;
  readonly bridge: DesktopVmInterface;
  readonly retiredEndpointIndex: number;
  readonly routes: readonly DesktopVmRoute[];
}
export interface DesktopRetainedState {
  readonly bridge: DesktopVmInterface;
  readonly routes: readonly DesktopVmRoute[];
  readonly fingerprint: string;
}
const same = (left: unknown, right: unknown) => observationFingerprint(left) === observationFingerprint(right);
const requireFact = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

/** Research only: derive authority from the original, source-validated settled live graph. */
export function captureDesktopRetainedTransition(owned: DesktopOwnedBridge,
  settledWithEndpoint: DesktopVmObservation): DesktopRetainedTransition {
  const devices = validateDesktopOwnedVm(settledWithEndpoint, owned, true);
  validateDesktopBridgeEvolution(owned.device, devices[0], devices[1]);
  requireFact(desktopOwnedLinkLocalSettled(devices), 'Retained transition requires the original settled endpoint graph.');
  return Object.freeze({ owned, bridge: devices[0], retiredEndpointIndex: devices[1].index,
    routes: Object.freeze(settledWithEndpoint.snapshot.routes.filter((route) => route.interfaceIndex === devices[0].index)) });
}

function linkdownRoute(context: DesktopRetainedTransition, route: DesktopVmRoute): boolean {
  if (route.flags !== 0 || route.protocol !== 2 || route.source !== null || route.sourcePrefix !== 0
    || route.gateways.length || route.nextHops.length || route.interfaceIndex !== context.bridge.index) return false;
  if (route.family === 6) return route.scope === 0 && route.preferredSource === null && route.priority === 256
    && (route.table === 254 && route.type === 1 && route.prefix === 64 && route.destination === 'fe80:0:0:0:0:0:0:0'
      || route.table === 255 && route.type === 5 && route.prefix === 8 && route.destination === 'ff00:0:0:0:0:0:0:0');
  const [address, bits] = context.owned.subnet.split('/');
  const broadcast = formatNumericAddress(nativeAddressNumber(address, 4) | (0xffff_ffffn ^ prefixMask(4, Number(bits))), 4);
  return route.scope === 253 && route.preferredSource === context.owned.gateway && route.priority === null
    && (route.table === 254 && route.type === 1 && route.prefix === Number(bits) && route.destination === address
      || route.table === 255 && route.type === 3 && route.prefix === 32 && route.destination === broadcast);
}

/** No snapshot normalization: current raw decoded facts must match a finite original-owned alternative. */
export function validateDesktopRetainedTransition(context: DesktopRetainedTransition, current: DesktopVmObservation): Readonly<{
  kind: 'settling' | 'settled'; devices: readonly DesktopVmInterface[]; fingerprint: string;
}> {
  const device = current.snapshot.interfaces.find((candidate) => candidate.index === context.bridge.index);
  requireFact(device !== undefined, 'Original retained bridge index is absent or stale.');
  if (!device) throw new Error('Original retained bridge is absent.');
  requireFact(!current.snapshot.interfaces.some((candidate) => candidate.masterIndex === context.bridge.index
    || candidate.index === context.retiredEndpointIndex), 'Retained bridge still has an endpoint or its retired index was reused.');
  const intermediateFlags = context.bridge.flags & ~0x10000;
  const downFlags = context.bridge.flags & ~0x10040;
  requireFact(device.carrier === 0 && (device.flags === intermediateFlags && device.operationalState === 6
    || device.flags === downFlags && device.operationalState === 2), 'Retained bridge is outside its exact deactivation states.');
  requireFact(device.tsoMaxSize === context.bridge.tsoMaxSize || device.tsoMaxSize === context.owned.device.tsoMaxSize,
    'Retained bridge TSO is neither its original endpoint limit nor its original empty limit.');
  requireFact(same(device, { ...context.bridge, flags: device.flags, operationalState: device.operationalState,
    carrier: 0, tsoMaxSize: device.tsoMaxSize }), 'Retained bridge identity, addresses or other native facts changed.');
  const routes = current.snapshot.routes.filter((route) => route.interfaceIndex === context.bridge.index);
  requireFact(routes.length === context.routes.length, 'Retained bridge route census changed.');
  let completeLinkdown = true;
  for (const previous of context.routes) {
    const mayDown = linkdownRoute(context, previous);
    const exact = routes.filter((route) => same(route, previous) || mayDown && same(route, { ...previous, flags: 0x10 }));
    requireFact(exact.length === 1, 'Retained route exceeds its exact original kernel deactivation alternative.');
    if (mayDown && exact[0].flags !== 0x10) completeLinkdown = false;
  }
  const kind = device.flags === downFlags && device.operationalState === 2 && completeLinkdown ? 'settled' : 'settling';
  return Object.freeze({ kind, devices: Object.freeze([device]), fingerprint: observationFingerprint({ device, routes }) });
}

/** Caller owns the second matching settled observation/deadline before freezing this state. */
export function captureDesktopRetainedState(context: DesktopRetainedTransition, current: DesktopVmObservation): DesktopRetainedState {
  const result = validateDesktopRetainedTransition(context, current);
  requireFact(result.kind === 'settled', 'Retained bridge cannot freeze before terminal deactivation.');
  return Object.freeze({ bridge: result.devices[0],
    routes: Object.freeze(current.snapshot.routes.filter((route) => route.interfaceIndex === result.devices[0].index)), fingerprint: result.fingerprint });
}

export function validateDesktopRetainedState(state: DesktopRetainedState, current: DesktopVmObservation): readonly DesktopVmInterface[] {
  const device = current.snapshot.interfaces.find((candidate) => candidate.index === state.bridge.index);
  const routes = current.snapshot.routes.filter((route) => route.interfaceIndex === state.bridge.index);
  requireFact(device !== undefined && same(device, state.bridge) && same(routes, state.routes)
    && !current.snapshot.interfaces.some((candidate) => candidate.masterIndex === state.bridge.index), 'Fixed retained bridge authority changed.');
  // The removed endpoint is no longer owned: a later registered member may reuse its index.
  return Object.freeze([state.bridge]);
}
