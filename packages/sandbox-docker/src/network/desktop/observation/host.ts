// ------------------------------------------------------------------------------------------------
//                host.ts - Complete Darwin host route, interface and proxy observation semantics
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { DESKTOP_HOST_OBSERVATION_PROTOCOL } from '../protocol.js';
import { nativeAddressNumber as addressNumber, formatNumericAddress as addressString, addressWidth, prefixMask } from '../../address.js';
import type { AddressFamily } from '../../address.js';
import { freezeObservation } from './data.js';

const integer = z.number().int().min(0).max(0xffff_ffff);
const interfaceIndex = integer.min(1).max(65535);
const family = z.union([z.literal(4), z.literal(6)]);
const numeric = z.string().max(45);
const peer = z.strictObject({ address: numeric, scopeId: integer }).nullable();
const gateway = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ip'), family, address: numeric, scopeId: integer }),
  z.strictObject({ kind: z.literal('link'), interfaceIndex }),
]).nullable();
const reasons = z.enum(['enabled_proxy', 'enabled_pac', 'enabled_discovery', 'unknown_key', 'invalid_value', 'unavailable', 'bounds']);
const schema = z.strictObject({
  format: z.literal(DESKTOP_HOST_OBSERVATION_PROTOCOL), complete: z.literal(true),
  host: z.strictObject({ kernel: z.string().regex(/^[A-Za-z0-9._-]{1,127}$/u), architecture: z.literal('arm64'),
    osBuild: z.string().regex(/^[A-Za-z0-9._-]{1,127}$/u),
    boot: z.strictObject({ seconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), microseconds: integer.max(999999) }) }),
  interfaces: z.array(z.strictObject({ index: interfaceIndex, name: z.string().regex(/^[A-Za-z0-9_.-]{1,15}$/u), flags: integer,
    addresses: z.array(z.strictObject({ family, address: numeric, netmask: numeric, scopeId: integer, flags: integer, peer, broadcast: peer })).max(4096) })).min(1).max(256),
  routes: z.array(z.strictObject({ family, destination: numeric, netmask: numeric, scopeId: integer, interfaceIndex,
    flags: integer, parentFlags: integer, gateway })).max(4096),
  proxy: z.strictObject({ status: z.enum(['safe', 'unsafe', 'unknown']), reasonCodes: z.array(reasons).max(7),
    scopes: integer.max(257), entries: integer.max(65536) }),
}) satisfies z.ZodType<DesktopHostObservationDocument>;

interface DesktopHostPeer { readonly address: string; readonly scopeId: number }
type DesktopHostGateway = Readonly<{ kind: 'ip'; family: AddressFamily; address: string; scopeId: number }>
  | Readonly<{ kind: 'link'; interfaceIndex: number }> | null;
type ProxyReason = 'enabled_proxy' | 'enabled_pac' | 'enabled_discovery' | 'unknown_key' | 'invalid_value' | 'unavailable' | 'bounds';
export interface DesktopHostObservationDocument {
  readonly format: 'agenai.desktop-host-network.v1';
  readonly complete: true;
  readonly host: Readonly<{ kernel: string; architecture: 'arm64'; osBuild: string;
    boot: Readonly<{ seconds: number; microseconds: number }> }>;
  readonly interfaces: readonly Readonly<{ index: number; name: string; flags: number;
    addresses: readonly Readonly<{ family: AddressFamily; address: string; netmask: string; scopeId: number; flags: number;
      peer: DesktopHostPeer | null; broadcast: DesktopHostPeer | null }>[] }>[];
  readonly routes: readonly Readonly<{ family: AddressFamily; destination: string; netmask: string; scopeId: number;
    interfaceIndex: number; flags: number; parentFlags: number; gateway: DesktopHostGateway }>[];
  readonly proxy: Readonly<{ status: 'safe' | 'unsafe' | 'unknown'; reasonCodes: readonly ProxyReason[]; scopes: number; entries: number }>;
}
export interface DesktopHostObservation {
  readonly snapshot: DesktopHostObservationDocument;
  readonly excludedCidrs: readonly string[];
  readonly fingerprint: string;
  readonly proxySafe: true;
}
export interface DesktopHostAuthorityObservation extends DesktopHostObservation {
  readonly executableIdentity: string;
}

interface Range { readonly family: AddressFamily; readonly address: bigint; readonly prefix: number; readonly mask: bigint }
type NumericGateway = Readonly<{ kind: 'link'; interfaceIndex: number }>
  | Readonly<{ kind: 'ip'; family: AddressFamily; address: bigint; scopeId: number }> | null;
interface Route {
  readonly family: AddressFamily; readonly destination: bigint; readonly mask: bigint; readonly prefix: number;
  readonly scopeId: number; readonly interfaceIndex: number; readonly flags: number; readonly parentFlags: number;
  readonly gateway: NumericGateway;
}
const routeFlags = { host: 0x4, wasCloned: 0x20000, protocolCloning: 0x10000, local: 0x200000, scoped: 0x1000000 };

function requireFact(condition: unknown, message: string): void { if (!condition) throw new TypeError(message); }

function maskPrefix(value: string, ipFamily: AddressFamily) {
  const mask = addressNumber(value, ipFamily);
  let zeroSeen = false;
  let prefix = 0;
  for (let bit = addressWidth(ipFamily) - 1; bit >= 0; bit--) {
    if ((mask & (1n << BigInt(bit))) === 0n) zeroSeen = true;
    else { requireFact(!zeroSeen, 'Noncontiguous observation netmask.'); prefix++; }
  }
  return { mask, prefix };
}

function addressWithZone(value: string, ipFamily: AddressFamily, scopeId: number): bigint {
  const number = addressNumber(value, ipFamily);
  if (ipFamily === 4) requireFact(scopeId === 0, 'IPv4 cannot have an interface zone.');
  else {
    const linkLocal = (number >> 118n) === 0x3fan;
    const multicastScope = (number >> 120n) === 255n ? Number((number >> 112n) & 15n) : 0;
    if (linkLocal || multicastScope === 1 || multicastScope === 2) {
      requireFact(((number >> 96n) & 65535n) === 0n, 'Embedded IPv6 scope must be extracted before the JSON boundary.');
      requireFact(scopeId > 0, 'Scoped address requires an explicit interface zone.');
    } else requireFact(scopeId === 0, 'Global IPv6 addresses cannot carry a zone.');
  }
  return number;
}

function scoped(value: string, ipFamily: AddressFamily, scopeId: number, index: number): bigint {
  const number = addressWithZone(value, ipFamily, scopeId);
  if (scopeId) requireFact(scopeId === index, 'Scoped address does not identify its interface.');
  return number;
}

function routeAddress(value: string, ipFamily: AddressFamily, scopeId: number, indexes: ReadonlySet<number>): bigint {
  const number = addressWithZone(value, ipFamily, scopeId);
  if (scopeId) requireFact(indexes.has(scopeId), 'Route address zone references an unobserved host interface.');
  return number;
}

function sameGateway(left: NumericGateway, right: NumericGateway): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === 'link') return right.kind === 'link' && left.interfaceIndex === right.interfaceIndex;
  return right.kind === 'ip' && left.family === right.family && left.address === right.address && left.scopeId === right.scopeId;
}

function redundantClone(route: Route, routes: readonly Route[]): boolean {
  if (!(route.flags & routeFlags.wasCloned) || !(route.parentFlags & routeFlags.protocolCloning) || (route.flags & routeFlags.local)) return false;
  return routes.some((parent) => parent !== route && parent.family === route.family && parent.prefix < route.prefix
    && parent.interfaceIndex === route.interfaceIndex && parent.scopeId === route.scopeId
    && (route.destination & parent.mask) === parent.destination && sameGateway(route.gateway, parent.gateway));
}

export function parseDesktopHostObservation(input: unknown): DesktopHostObservation {
  const value = schema.parse(input);
  requireFact(Buffer.byteLength(JSON.stringify(value)) <= 4 * 1024 ** 2, 'Host observation exceeds the byte bound.');
  const indexes = new Set<number>();
  const names = new Set<string>();
  const ranges: Range[] = [];
  let addressCount = 0;
  const add = (ipFamily: AddressFamily, ip: bigint, prefix: number, mask = prefixMask(ipFamily, prefix)) => {
    ranges.push({ family: ipFamily, address: ip & mask, mask, prefix });
  };
  const interfaceFacts = value.interfaces.map((device) => {
    requireFact(!indexes.has(device.index) && !names.has(device.name), 'Duplicate host interface identity.');
    indexes.add(device.index); names.add(device.name);
    const addresses = device.addresses.map((entry) => {
      requireFact(++addressCount <= 4096, 'Host address observation exceeds its total entry bound.');
      const ip = scoped(entry.address, entry.family, entry.scopeId, device.index);
      const mask = maskPrefix(entry.netmask, entry.family);
      const remote = entry.peer && scoped(entry.peer.address, entry.family, entry.peer.scopeId, device.index);
      const broadcast = entry.broadcast && scoped(entry.broadcast.address, entry.family, entry.broadcast.scopeId, device.index);
      requireFact(!(entry.peer && entry.broadcast), 'Address cannot have both a P2P peer and broadcast.');
      if (entry.peer) requireFact(device.flags & 0x10, 'P2P peer requires an IFF_POINTOPOINT interface.');
      if (entry.broadcast) requireFact(device.flags & 0x2, 'Broadcast requires an IFF_BROADCAST interface.');
      add(entry.family, ip, mask.prefix, mask.mask);
      if (remote !== null) add(entry.family, remote, addressWidth(entry.family));
      if (broadcast !== null) add(entry.family, broadcast, addressWidth(entry.family));
      return { family: entry.family, address: addressString(ip, entry.family), prefix: mask.prefix, scopeId: entry.scopeId,
        flags: entry.flags, peer: remote === null ? null : addressString(remote, entry.family),
        broadcast: broadcast === null ? null : addressString(broadcast, entry.family) };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { index: device.index, name: device.name, flags: device.flags, addresses };
  }).sort((left, right) => left.index - right.index);
  const routes: Route[] = value.routes.map((entry) => {
    requireFact(((entry.flags | entry.parentFlags) & 0x8008_0000) === 0, 'Unknown Darwin route flag.');
    requireFact(indexes.has(entry.interfaceIndex), 'Route references an unobserved host interface.');
    const destination = routeAddress(entry.destination, entry.family, entry.scopeId, indexes);
    const mask = maskPrefix(entry.netmask, entry.family);
    requireFact((destination & mask.mask) === destination, 'Route destination has unmasked host bits.');
    if (entry.flags & routeFlags.host) requireFact(mask.prefix === addressWidth(entry.family), 'RTF_HOST route requires a complete host netmask.');
    let observedGateway: NumericGateway = null;
    if (entry.gateway?.kind === 'ip') {
      requireFact(entry.gateway.family === entry.family, 'Gateway has a different address family.');
      observedGateway = { ...entry.gateway, address: routeAddress(entry.gateway.address, entry.family, entry.gateway.scopeId, indexes) };
    } else if (entry.gateway?.kind === 'link') {
      requireFact(indexes.has(entry.gateway.interfaceIndex), 'Link gateway references an unobserved host interface.');
      observedGateway = entry.gateway;
    } else requireFact(!(entry.flags & 0x2), 'Gateway route omits its gateway.');
    return { ...entry, destination, mask: mask.mask, prefix: mask.prefix, gateway: observedGateway };
  });
  for (const route of routes) {
    if (route.prefix > 0 && !redundantClone(route, routes)) add(route.family, route.destination, route.prefix, route.mask);
    if (route.gateway?.kind === 'ip') add(route.gateway.family, route.gateway.address, addressWidth(route.gateway.family));
  }
  requireFact(new Set(value.proxy.reasonCodes).size === value.proxy.reasonCodes.length, 'Duplicate proxy reason code.');
  requireFact(value.proxy.status === 'safe' && value.proxy.reasonCodes.length === 0 && value.proxy.scopes > 0,
    'Host proxy authority is unsafe, unknown or incomplete.');
  const ordered = ranges.sort((left, right) => left.family - right.family || left.prefix - right.prefix
    || (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
  const normalized: Range[] = [];
  for (const range of ordered) if (!normalized.some((parent) => parent.family === range.family && parent.prefix <= range.prefix
    && (range.address & parent.mask) === parent.address)) normalized.push(range);
  const excludedCidrs = normalized.map((range) => `${addressString(range.address, range.family)}/${range.prefix}`).sort();
  const defaults = routes.filter((route) => route.prefix === 0).map((route) => ({ family: route.family, interfaceIndex: route.interfaceIndex,
    scopeId: route.scopeId, scoped: !!(route.flags & routeFlags.scoped), gateway: route.gateway?.kind === 'ip'
      ? { ...route.gateway, address: addressString(route.gateway.address, route.gateway.family) } : route.gateway }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const fingerprint = createHash('sha256').update(JSON.stringify({ host: value.host, interfaces: interfaceFacts, excludedCidrs, defaults, proxy: value.proxy })).digest('hex');
  freezeObservation(value);
  return Object.freeze({ snapshot: value, excludedCidrs: Object.freeze(excludedCidrs), fingerprint, proxySafe: true });
}
