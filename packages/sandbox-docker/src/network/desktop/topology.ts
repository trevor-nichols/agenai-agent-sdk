// ------------------------------------------------------------------------------------------------
//                topology.ts - Finite owned bridge/endpoint transitions with unchanged external authority
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';
import { nativeAddressNumber as addressNumber, formatNumericAddress as addressString, prefixMask } from '../address.js';
import { observationFingerprint } from './observation/engine.js';
import type { DesktopEngineNetwork, DesktopEngineNetworkCensus } from './observation/engine.js';
import type { DesktopVmAddress, DesktopVmInterface, DesktopVmObservation, DesktopVmRoute } from './observation/vm.js';

export interface DesktopOwnedBridgeReceipt {
  readonly networkId: string; readonly name: string; readonly bridgeName: string; readonly labels: Readonly<Record<string, string>>;
}
type OwnedMember = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'present'; id: string }>;
export interface DesktopOwnedNoneMembers { readonly compute: OwnedMember; readonly filesystem: OwnedMember }
export interface DesktopStartedTopologyReceipt {
  readonly broker: Readonly<{ id: string; networkId: string; endpointId: string; macAddress: string;
    address: string; prefixLength: number; gateway: string }>;
  readonly members: DesktopOwnedNoneMembers;
}
export interface DesktopOwnedBridge {
  readonly receipt: DesktopOwnedBridgeReceipt;
  readonly network: DesktopEngineNetwork;
  readonly device: DesktopVmInterface;
  readonly subnet: string; readonly prefix: number; readonly gateway: string;
}
const absentMembers: DesktopOwnedNoneMembers = Object.freeze({ compute: Object.freeze({ kind: 'absent' }), filesystem: Object.freeze({ kind: 'absent' }) });
export const NO_DESKTOP_NONE_MEMBERS = absentMembers;

function requireFact(condition: unknown, message: string): void {
  if (!condition) throw new SandboxOperationError('driver_failure', message);
}
export function requireSameAuthority(actual: unknown, expected: unknown, message: string): void {
  requireFact(observationFingerprint(actual) === observationFingerprint(expected), message);
}
function ownedSubnetStatus(network: DesktopEngineNetwork, subnet: string) {
  const subnets = network.Status?.IPAM?.Subnets;
  const allocation = subnets?.[subnet];
  if (!subnets || Object.keys(subnets).length !== 1 || !allocation) {
    throw new SandboxOperationError('driver_failure', 'Owned bridge requires its exact subnet status.');
  }
  return allocation;
}
function networkIdentity(network: DesktopEngineNetwork, subnet: string) {
  const { Containers: _members, ...identity } = network;
  const { IPsInUse: _used, DynamicIPsAvailable: _available, ...allocation } = ownedSubnetStatus(network, subnet);
  return { ...identity, Status: { ...network.Status, IPAM: { ...network.Status?.IPAM, Subnets: { [subnet]: allocation } } } };
}

export function externalEngineAuthority(census: DesktopEngineNetworkCensus, observerId: string,
  members: DesktopOwnedNoneMembers, ownedNetworkId?: string): unknown {
  const noneIds = [members.compute, members.filesystem].flatMap((entry) => entry.kind === 'present' ? [entry.id] : []);
  let observerFound = false;
  const networks = census.networks.filter((network) => network.Id !== ownedNetworkId).map((network) => {
    const builtinHost = network.Driver === 'host' && network.Name === 'host';
    const builtinNone = network.Driver === 'null' && network.Name === 'none';
    const Containers = Object.fromEntries(Object.entries(network.Containers).filter(([id]) => {
      if (id === observerId) {
        requireFact(builtinHost && !observerFound, 'Owned route observer is not the exact host-network member.');
        observerFound = true; return false;
      }
      if (noneIds.includes(id)) { requireFact(builtinNone, 'Owned network-none producer acquired an external network.'); return false; }
      return true;
    }));
    return { ...network, Containers };
  });
  requireFact(observerFound, 'Owned route observer disappeared from the complete Engine census.');
  return { id: census.id, hostname: census.hostname, kernel: census.kernel, networks };
}

export function externalVmAuthority(observation: DesktopVmObservation, ownedIndexes: readonly number[]): unknown {
  return { ...observation.snapshot,
    interfaces: observation.snapshot.interfaces.filter((entry) => !ownedIndexes.includes(entry.index)),
    routes: observation.snapshot.routes.filter((entry) => entry.interfaceIndex === null || !ownedIndexes.includes(entry.interfaceIndex)) };
}

function ipv4Network(cidr: string): { address: bigint; prefix: number } {
  const [address, prefix, extra] = cidr.split('/');
  requireFact(extra === undefined && prefix !== undefined && /^(?:[1-9]|[12][0-9]|30)$/u.test(prefix), 'Owned bridge requires a usable canonical IPv4 subnet.');
  const number = addressNumber(address, 4);
  const bits = Number(prefix);
  requireFact((number & prefixMask(4, bits)) === number, 'Owned bridge subnet contains host bits.');
  return { address: number, prefix: bits };
}
export function identifyDesktopOwnedBridge(receipt: DesktopOwnedBridgeReceipt,
  engine: DesktopEngineNetworkCensus, vm: DesktopVmObservation): DesktopOwnedBridge {
  const network = engine.networks.find((entry) => entry.Id === receipt.networkId);
  if (!network) throw new SandboxOperationError('driver_failure', 'Owned bridge is absent from the complete Engine census.');
  requireFact(network.Name === receipt.name && network.Driver === 'bridge' && network.Scope === 'local'
    && !network.Internal && !network.Attachable && !network.Ingress && !network.ConfigOnly && !network.EnableIPv6,
  'Owned bridge differs from its fixed Engine network policy.');
  requireSameAuthority(network.Labels, receipt.labels, 'Owned bridge labels differ from the original owner.');
  requireFact(network.Options['com.docker.network.bridge.name'] === receipt.bridgeName
    && /^[A-Za-z0-9_.-]{1,15}$/u.test(receipt.bridgeName)
    && Object.entries(network.Options).every(([key, value]) => key === 'com.docker.network.bridge.name'
      || key === 'com.docker.network.enable_ipv4' && value === 'true'), 'Owned bridge options differ from its explicit interface identity.');
  const allocation = network.IPAM.Config?.[0];
  if (!allocation?.Subnet || !allocation.Gateway) throw new SandboxOperationError('driver_failure', 'Owned bridge IPAM is incomplete.');
  requireFact(network.IPAM.Driver === 'default' && Object.keys(network.IPAM.Options ?? {}).length === 0
    && network.IPAM.Config?.length === 1 && !allocation.IPRange && Object.keys(allocation.AuxiliaryAddresses ?? {}).length === 0,
  'Owned bridge requires the fixed single-subnet IPAM profile.');
  const subnet = ipv4Network(allocation.Subnet);
  const gateway = addressNumber(allocation.Gateway, 4);
  requireFact((gateway & prefixMask(4, subnet.prefix)) === subnet.address && gateway !== subnet.address
    && gateway !== (subnet.address | (0xffff_ffffn ^ prefixMask(4, subnet.prefix))), 'Owned bridge gateway is outside its usable subnet.');
  const initialAllocation = ownedSubnetStatus(network, allocation.Subnet);
  // The fixed default IPv4 profile reserves its network, broadcast and gateway addresses.
  requireFact(initialAllocation.IPsInUse === 3 && initialAllocation.DynamicIPsAvailable === 2 ** (32 - subnet.prefix) - 3,
    'Owned bridge initial IPAM allocation accounting differs from its fixed reservations.');
  const device = vm.snapshot.interfaces.find((entry) => entry.name === receipt.bridgeName);
  if (!device) throw new SandboxOperationError('driver_failure', 'Owned bridge is absent from the complete VM observation.');
  requireFact(device.kind === 'bridge' && device.masterIndex === null && device.linkIndex === null
    && device.macAddress !== null && /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(device.macAddress), 'Native bridge identity is incomplete or contradictory.');
  return Object.freeze({ receipt, network, device, subnet: allocation.Subnet, prefix: subnet.prefix, gateway: allocation.Gateway });
}

function validLinkLocal(entry: DesktopVmAddress): boolean {
  return entry.family === 6 && entry.prefix === 64 && entry.scope === 253 && entry.peer === null && entry.broadcast === null
    && entry.anycast === null && (entry.flags & ~0xc0) === 0 && (addressNumber(entry.address, 6) >> 118n) === 0x3fan;
}
function bridgeAddress(entry: DesktopVmAddress, owned: DesktopOwnedBridge): boolean {
  if (entry.family === 6) return validLinkLocal(entry);
  const subnet = ipv4Network(owned.subnet);
  const broadcast = addressString(subnet.address | (0xffff_ffffn ^ prefixMask(4, subnet.prefix)), 4);
  return entry.address === owned.gateway && entry.prefix === owned.prefix && entry.scope === 0 && entry.flags === 0x80
    && entry.peer === null && entry.anycast === null && (entry.broadcast === null || entry.broadcast === broadcast);
}
function ownedRoute(route: DesktopVmRoute, owned: DesktopOwnedBridge, device: DesktopVmInterface): boolean {
  if (route.source !== null || route.sourcePrefix !== 0 || route.gateways.length || route.nextHops.length || route.protocol !== 2) return false;
  if (route.family === 6) {
    if (route.flags !== 0 || route.preferredSource !== null || route.scope !== 0
      || !route.attributes.every((entry) => /^(?:1|4|6|15|20):0:/u.test(entry))) return false;
    const destination = addressNumber(route.destination, 6);
    if (route.type === 4) {
      // Kernel subnet-router anycast is the owned address's /64 prefix, installed as a local /128.
      return route.table === 255 && route.prefix === 128 && route.priority === 0 && destination === addressNumber('fe80::', 6)
        && device.addresses.some((entry) => validLinkLocal(entry) && (addressNumber(entry.address, 6) & prefixMask(6, entry.prefix)) === destination)
        && route.attributes.every((entry) => !entry.startsWith('20:') || entry === '20:0:00');
    }
    return (route.table === 254 && route.type === 1 && route.prefix === 64 && destination === addressNumber('fe80::', 6)
      || route.table === 255 && route.type === 2 && route.prefix === 128 && route.priority === 0
        && device.addresses.some((entry) => validLinkLocal(entry) && addressNumber(entry.address, 6) === destination)
      || route.table === 255 && route.type === 5 && route.prefix === 8 && destination === addressNumber('ff00::', 6))
      && (route.priority === null || route.priority === 0 || route.priority === 256);
  }
  if (device.index !== owned.device.index || (route.flags !== 0 && route.flags !== 0x10) || route.preferredSource !== owned.gateway
    || route.priority !== null || !route.attributes.every((entry) => /^(?:1|4|7|15):0:/u.test(entry))) return false;
  const subnet = ipv4Network(owned.subnet);
  const broadcast = addressString(subnet.address | (0xffff_ffffn ^ prefixMask(4, subnet.prefix)), 4);
  return route.table === 254 && route.type === 1 && route.scope === 253 && route.destination === addressString(subnet.address, 4) && route.prefix === owned.prefix
    || route.table === 255 && route.type === 2 && route.scope === 254 && route.destination === owned.gateway && route.prefix === 32
    || route.table === 255 && route.type === 3 && route.scope === 253 && route.destination === broadcast && route.prefix === 32;
}
export function validateDesktopOwnedVm(observation: DesktopVmObservation, owned: DesktopOwnedBridge, endpoint: boolean): readonly DesktopVmInterface[] {
  const device = observation.snapshot.interfaces.find((entry) => entry.index === owned.device.index);
  if (!device) throw new SandboxOperationError('driver_failure', 'Owned bridge interface disappeared.');
  const children = observation.snapshot.interfaces.filter((entry) => entry.masterIndex === device.index);
  requireFact(children.length === (endpoint ? 1 : 0), 'Owned bridge has an unexpected native endpoint census.');
  if (endpoint) {
    const child = children[0];
    requireFact(child.kind === 'veth' && child.linkIndex !== null && child.networkNamespaceId !== null
      && child.macAddress !== null && /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(child.macAddress), 'Owned endpoint native veth identity is incomplete.');
  }
  requireFact(device.addresses.filter((entry) => entry.family === 4).length === 1
    && device.addresses.every((entry) => bridgeAddress(entry, owned)), 'Owned bridge addresses differ from its exact IPAM or link-local projection.');
  for (const child of children) requireFact(child.addresses.every(validLinkLocal), 'Owned veth acquired an unexpected address.');
  const devices = [device, ...children];
  for (const route of observation.snapshot.routes) {
    const routeDevice = devices.find((entry) => entry.index === route.interfaceIndex);
    if (routeDevice) requireFact(ownedRoute(route, owned, routeDevice), 'Owned native route exceeds its exact IPAM/link-local projection.');
  }
  return devices;
}

export function validateDesktopBrokerReceipt(owned: DesktopOwnedBridge, engine: DesktopEngineNetworkCensus, receipt: DesktopStartedTopologyReceipt): void {
  const network = engine.networks.find((entry) => entry.Id === owned.receipt.networkId);
  if (!network) throw new SandboxOperationError('driver_failure', 'Owned broker network disappeared.');
  const ids = Object.keys(network.Containers);
  const actual = network.Containers[receipt.broker.id];
  requireFact(ids.length === 1 && actual !== undefined && receipt.broker.networkId === network.Id,
    'Owned broker is not the sole exact Engine endpoint.');
  if (!actual) throw new SandboxOperationError('driver_failure', 'Owned broker endpoint is absent.');
  requireFact(actual.EndpointID === receipt.broker.endpointId && actual.MacAddress === receipt.broker.macAddress
    && actual.IPv4Address === `${receipt.broker.address}/${receipt.broker.prefixLength}` && actual.IPv6Address === ''
    && receipt.broker.prefixLength === owned.prefix && receipt.broker.gateway === owned.gateway,
  'Owned broker endpoint differs from its independently read-back container attachment.');
  const subnet = ipv4Network(owned.subnet);
  const address = addressNumber(receipt.broker.address, 4);
  requireFact((address & prefixMask(4, subnet.prefix)) === subnet.address && receipt.broker.address !== owned.gateway
    && address !== subnet.address && address !== (subnet.address | (0xffff_ffffn ^ prefixMask(4, subnet.prefix))), 'Owned broker address is outside its usable subnet.');
  const initialAllocation = ownedSubnetStatus(owned.network, owned.subnet);
  const allocation = ownedSubnetStatus(network, owned.subnet);
  requireFact(allocation.IPsInUse === initialAllocation.IPsInUse + 1
    && allocation.DynamicIPsAvailable === initialAllocation.DynamicIPsAvailable - 1,
    'Owned broker IPAM allocation accounting differs from its sole IPv4 endpoint.');
  requireSameAuthority(networkIdentity(network, owned.subnet), networkIdentity(owned.network, owned.subnet),
    'Owned network configuration changed before broker sealing.');
}

function positiveU32(value: number | null): boolean {
  return value !== null && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}

export function validateDesktopBridgeEvolution(before: DesktopVmInterface, after: DesktopVmInterface,
  soleEndpoint: DesktopVmInterface): void {
  // Linux br_add_if derives this limit as min(UINT_MAX, each port's TSO_MAX_SIZE).
  requireFact(soleEndpoint.kind === 'veth' && soleEndpoint.masterIndex === after.index
    && positiveU32(before.tsoMaxSize) && positiveU32(after.tsoMaxSize) && positiveU32(soleEndpoint.tsoMaxSize)
    && after.tsoMaxSize === soleEndpoint.tsoMaxSize, 'Owned bridge TSO limit differs from its sole native endpoint.');
  requireSameAuthority({ ...after, flags: undefined, operationalState: undefined, carrier: undefined, ipv6Flags: undefined, addresses: undefined, tsoMaxSize: undefined },
    { ...before, flags: undefined, operationalState: undefined, carrier: undefined, ipv6Flags: undefined, addresses: undefined, tsoMaxSize: undefined },
    'Owned bridge stable native identity or configuration changed during endpoint acquisition.');
  requireFact(((before.flags ^ after.flags) & ~0x10040) === 0 && (after.flags & 1) !== 0,
    'Owned bridge flags changed outside its carrier/running transition.');
  requireFact(after.operationalState === 6 && after.carrier === 1
    && (after.ipv6Flags === before.ipv6Flags || (after.ipv6Flags !== null && before.ipv6Flags !== null
      && ((before.ipv6Flags ^ after.ipv6Flags) & ~0x80000000) === 0)), 'Owned bridge did not reach its known carrier/IPv6 readiness state.');
}

function eui64(mac: string): string {
  const bytes = Buffer.from(mac.split(':').map((part) => Number.parseInt(part, 16)));
  bytes[0] ^= 2;
  const host = Buffer.concat([bytes.subarray(0, 3), Buffer.from([0xff, 0xfe]), bytes.subarray(3)]);
  return addressString(addressNumber('fe80::', 6) | host.readBigUInt64BE(), 6);
}
export function desktopOwnedLinkLocalSettled(devices: readonly DesktopVmInterface[]): boolean {
  const bridge = devices[0];
  if (!bridge?.macAddress) return false;
  const bridgeAddresses = bridge.addresses.filter((entry) => entry.family === 6);
  return bridgeAddresses.length === 1 && bridgeAddresses[0].address === eui64(bridge.macAddress)
    && devices.every((device) => device.addresses.every((entry) => entry.family !== 6 || (entry.flags & 0x40) === 0));
}
