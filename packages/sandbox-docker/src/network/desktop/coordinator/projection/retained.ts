import { SandboxOperationError } from '@agen-ai/sandbox';
import { nativeAddressNumber, prefixMask, formatNumericAddress } from '../../../address.js';
import { observationFingerprint } from '../../observation/engine.js';
import { freezeObservation } from '../../observation/data.js';
import type { DesktopVmInterface, DesktopVmObservation, DesktopVmRoute } from '../../observation/vm.js';
import { desktopOwnedLinkLocalSettled, requireSameAuthority, validateDesktopBridgeEvolution, validateDesktopOwnedVm } from '../../topology.js';
import type { DesktopOwnedBridge } from '../../topology.js';

export interface DesktopRetainedTransition {
  readonly owned: DesktopOwnedBridge;
  readonly bridge: DesktopVmInterface;
  readonly endpoint: DesktopVmInterface;
  readonly routes: readonly DesktopVmRoute[];
  readonly activeRoutes: readonly DesktopVmRoute[];
}
export interface DesktopRetainedState {
  readonly bridge: DesktopVmInterface;
  readonly routes: readonly DesktopVmRoute[];
  readonly fingerprint: string;
}

function requireFact(condition: unknown, message: string): void {
  if (!condition) throw new SandboxOperationError('driver_failure', message);
}
const same = (left: unknown, right: unknown) => observationFingerprint(left) === observationFingerprint(right);

export function captureDesktopRetainedTransition(owned: DesktopOwnedBridge, current: DesktopVmObservation): DesktopRetainedTransition {
  const devices = validateDesktopOwnedVm(current, owned, true);
  validateDesktopBridgeEvolution(owned.device, devices[0], devices[1]);
  requireFact(desktopOwnedLinkLocalSettled(devices), 'Desktop removal requires the original settled endpoint graph.');
  const result = { owned, bridge: devices[0], endpoint: devices[1],
    routes: Object.freeze(current.snapshot.routes.filter((route) => route.interfaceIndex === devices[0].index)),
    activeRoutes: Object.freeze(current.snapshot.routes.filter((route) => devices.some((device) => device.index === route.interfaceIndex))) };
  freezeObservation(result);
  return result;
}

/** A released endpoint may already be gone, so its removal context comes from the sealed active graph. */
export function releaseDesktopRetainedTransition(owned: DesktopOwnedBridge, graph: Readonly<{
  devices: readonly DesktopVmInterface[]; routes: readonly DesktopVmRoute[];
}>): DesktopRetainedTransition {
  const [bridge, endpoint] = graph.devices;
  requireFact(graph.devices.length === 2 && bridge?.index === owned.device.index && endpoint?.masterIndex === bridge.index,
    'Desktop endpoint release requires its sealed active graph.');
  const result = { owned, bridge, endpoint,
    routes: Object.freeze(graph.routes.filter((route) => route.interfaceIndex === bridge.index)), activeRoutes: graph.routes };
  freezeObservation(result);
  return result;
}

function linkdownRoute(context: DesktopRetainedTransition, route: DesktopVmRoute): boolean {
  if (route.flags !== 0 || route.protocol !== 2 || route.source !== null || route.sourcePrefix !== 0 || route.gateways.length
    || route.nextHops.length || route.interfaceIndex !== context.bridge.index
    && (route.family !== 6 || route.interfaceIndex !== context.endpoint.index)) return false;
  if (route.family === 6) return route.scope === 0 && route.preferredSource === null && route.priority === 256
    && (route.table === 254 && route.type === 1 && route.prefix === 64 && route.destination === 'fe80:0:0:0:0:0:0:0'
      || route.table === 255 && route.type === 5 && route.prefix === 8 && route.destination === 'ff00:0:0:0:0:0:0:0');
  const [address, bits] = context.owned.subnet.split('/');
  const broadcast = formatNumericAddress(nativeAddressNumber(address, 4) | (0xffff_ffffn ^ prefixMask(4, Number(bits))), 4);
  return route.scope === 253 && route.preferredSource === context.owned.gateway && route.priority === null
    && (route.table === 254 && route.type === 1 && route.prefix === Number(bits) && route.destination === address
      || route.table === 255 && route.type === 3 && route.prefix === 32 && route.destination === broadcast);
}

// Linux br_port_carrier_check disables a port that loses carrier: IFLA_BRPORT_STATE becomes BR_STATE_DISABLED.
function disabledPort(attributes: readonly string[]): readonly string[] {
  return attributes.map((entry) => {
    if (!entry.startsWith('18:')) return entry;
    const separator = entry.indexOf(':', 3) + 1;
    const information = JSON.parse(entry.slice(separator)) as { slave: unknown };
    return Array.isArray(information.slave) ? entry.slice(0, separator) + JSON.stringify({ ...information,
      slave: information.slave.map((value: unknown) => typeof value === 'string' && value.startsWith('1:0:') ? '1:0:00' : value) }) : entry;
  });
}
// Carrier and LOWER_UP drop with the peer; RUNNING and the operational state follow when linkwatch runs, and only that
// change lets the bridge disable its port. Linux 6.9+ reports a veth port LOWERLAYERDOWN rather than DOWN when its own
// namespace holds a carrier-less device at its peer's index, as it does once moby returns the peer.
function deactivationStates(original: DesktopVmInterface, port: boolean): readonly DesktopVmInterface[] {
  const intermediate = { ...original, flags: original.flags & ~0x10000, carrier: 0 };
  const down = (port ? [2, 3] : [2]).map((operationalState) => ({ ...original, flags: original.flags & ~0x10040, operationalState, carrier: 0 }));
  return port ? [intermediate, ...down, ...down.map((state) => ({ ...state, attributes: disabledPort(state.attributes) }))] : [intermediate, ...down];
}
function deactivating(original: DesktopVmInterface, current: DesktopVmInterface, port: boolean): boolean {
  return [original, ...deactivationStates(original, port)].some((state) => same(current, state));
}

// Moby's RemoveInterface sets the broker's veth down, renames it and returns it to this namespace before deleting the pair.
function returnedPort(original: DesktopVmInterface, peer: DesktopVmInterface): DesktopVmInterface {
  const link = Buffer.alloc(4); link.writeUInt32LE(peer.index);
  return { ...original, linkIndex: peer.index, networkNamespaceId: null, attributes: original.attributes.filter((entry) => !entry.startsWith('37:'))
    .map((entry) => entry.startsWith('5:') ? `${entry.slice(0, entry.lastIndexOf(':') + 1)}${link.toString('hex')}` : entry).sort() };
}
// The returned peer is the endpoint's own veth end: it shares every attribute except its address, name and link, its qdisc,
// and the master, link namespace, bridge-port data and promiscuity and allmulti counts the bridge holds on its port.
const attributeType = (entry: string) => Number(entry.slice(0, entry.indexOf(':')));
const PEER_DISTINCT = [1, 3, 5, 6, 10, 18, 30, 37, 61];
const hex = (text: string) => Buffer.from(text).toString('hex');
const RETURNED_PEER_DISTINCT = [`6:0:${hex('noop\0')}`, `18:0:${JSON.stringify({ fixed: [`1:0:${hex('veth\0')}`], data: null, slave: null })}`,
  '30:0:00000000', '61:0:00000000'].sort();
const shared = (device: DesktopVmInterface) => device.attributes.filter((entry) => !PEER_DISTINCT.includes(attributeType(entry)));
function returnedPeer(endpoint: DesktopVmInterface, port: DesktopVmInterface, peer: DesktopVmInterface | undefined, brokerMac: string,
  routes: readonly DesktopVmRoute[]): boolean {
  return peer !== undefined && peer.index !== port.index && peer.kind === 'veth' && /^veth[a-f0-9]{7}$/u.test(peer.name)
    && peer.macAddress === brokerMac && peer.masterIndex === null && peer.linkIndex === port.index && peer.networkNamespaceId === null
    && peer.flags === (endpoint.flags & ~0x10041) && peer.operationalState === 2 && peer.carrier === 0 && peer.ipv6Flags === 0
    && peer.tsoMaxSize === endpoint.tsoMaxSize && same(shared(peer), shared(endpoint))
    && same(peer.attributes.filter((entry) => [6, 18, 30, 61].includes(attributeType(entry))).sort(), RETURNED_PEER_DISTINCT)
    && peer.addresses.length === 0
    && !routes.some((route) => route.interfaceIndex === peer.index || route.nextHops.some((hop) => hop.interfaceIndex === peer.index));
}
function deactivatedRoutes(context: DesktopRetainedTransition, previous: readonly DesktopVmRoute[], current: readonly DesktopVmRoute[]): boolean {
  const matches = (original: DesktopVmRoute, route: DesktopVmRoute) => same(route, original)
    || linkdownRoute(context, original) && same(route, { ...original, flags: 0x10 });
  return current.length === previous.length && previous.every((original) => current.filter((route) => matches(original, route)).length === 1)
    && current.every((route) => previous.filter((original) => matches(original, route)).length === 1);
}

/** An exited broker's veth can lose carrier and return its peer before Engine deletes it; only those finite facts may change. */
export function validateDesktopRetiringEndpoint(context: DesktopRetainedTransition, current: DesktopVmObservation,
  brokerMac: string): readonly DesktopVmInterface[] {
  const bridge = current.snapshot.interfaces.find((candidate) => candidate.index === context.bridge.index);
  const ports = current.snapshot.interfaces.filter((candidate) => candidate.masterIndex === context.bridge.index);
  const port = ports.length === 1 ? ports[0] : undefined;
  const peer = port?.networkNamespaceId === null ? current.snapshot.interfaces.find((candidate) => candidate.index === port.linkIndex) : undefined;
  const routes = current.snapshot.routes.filter((route) => route.interfaceIndex === context.bridge.index || route.interfaceIndex === context.endpoint.index);
  requireFact(bridge !== undefined && port !== undefined && deactivating(context.bridge, bridge, false)
    && (peer === undefined ? deactivating(context.endpoint, port, true)
      : returnedPeer(context.endpoint, port, peer, brokerMac, current.snapshot.routes)
        && deactivationStates(returnedPort(context.endpoint, peer), true).some((state) => same(port, state)))
    && deactivatedRoutes(context, context.activeRoutes, routes),
  'Retiring Desktop endpoint changed before its exact removal.');
  if (!bridge || !port) throw new SandboxOperationError('driver_failure', 'Retiring Desktop bridge is absent.');
  return Object.freeze(peer ? [bridge, port, peer] : [bridge, port]);
}

export function validateDesktopRetainedTransition(context: DesktopRetainedTransition, current: DesktopVmObservation): Readonly<{
  kind: 'settling' | 'settled'; devices: readonly DesktopVmInterface[]; fingerprint: string;
}> {
  const device = current.snapshot.interfaces.find((candidate) => candidate.index === context.bridge.index);
  if (!device) throw new SandboxOperationError('driver_failure', 'Original retained Desktop bridge is absent.');
  requireFact(!current.snapshot.interfaces.some((candidate) => candidate.masterIndex === context.bridge.index
    || candidate.index === context.endpoint.index), 'Retiring Desktop endpoint remains or its index was reused.');
  const intermediateFlags = context.bridge.flags & ~0x10000;
  const downFlags = context.bridge.flags & ~0x10040;
  requireFact(device.carrier === 0 && (device.flags === intermediateFlags && device.operationalState === 6
    || device.flags === downFlags && device.operationalState === 2), 'Desktop bridge exceeds its finite deactivation states.');
  requireFact(device.tsoMaxSize === context.bridge.tsoMaxSize || device.tsoMaxSize === context.owned.device.tsoMaxSize,
    'Retained Desktop bridge TSO differs from both original limits.');
  requireSameAuthority(device, { ...context.bridge, flags: device.flags, operationalState: device.operationalState,
    carrier: 0, tsoMaxSize: device.tsoMaxSize }, 'Retained Desktop bridge identity or addresses changed.');
  const routes = current.snapshot.routes.filter((route) => route.interfaceIndex === context.bridge.index);
  requireFact(routes.length === context.routes.length, 'Retained Desktop bridge route census changed.');
  requireFact(deactivatedRoutes(context, context.routes, routes), 'Retained Desktop route exceeds its original deactivation alternatives.');
  const completeLinkdown = context.routes.every((previous) => !linkdownRoute(context, previous)
    || routes.some((route) => same(route, { ...previous, flags: 0x10 })));
  return Object.freeze({ kind: device.flags === downFlags && device.operationalState === 2 && completeLinkdown ? 'settled' : 'settling',
    devices: Object.freeze([device]), fingerprint: observationFingerprint({ device, routes }) });
}

export function captureDesktopRetainedState(context: DesktopRetainedTransition, current: DesktopVmObservation): DesktopRetainedState {
  const result = validateDesktopRetainedTransition(context, current);
  requireFact(result.kind === 'settled', 'Retained Desktop authority cannot freeze before terminal deactivation.');
  const state = { bridge: result.devices[0],
    routes: Object.freeze(current.snapshot.routes.filter((route) => route.interfaceIndex === result.devices[0].index)), fingerprint: result.fingerprint };
  freezeObservation(state);
  return state;
}

export function validateDesktopRetainedState(state: DesktopRetainedState, current: DesktopVmObservation): readonly DesktopVmInterface[] {
  const device = current.snapshot.interfaces.find((candidate) => candidate.index === state.bridge.index);
  const routes = current.snapshot.routes.filter((route) => route.interfaceIndex === state.bridge.index);
  requireFact(device !== undefined && same(device, state.bridge) && same(routes, state.routes)
    && !current.snapshot.interfaces.some((candidate) => candidate.masterIndex === state.bridge.index), 'Fixed retained Desktop bridge authority changed.');
  if (!device) throw new SandboxOperationError('driver_failure', 'Fixed retained Desktop bridge is absent.');
  return Object.freeze([device]);
}
