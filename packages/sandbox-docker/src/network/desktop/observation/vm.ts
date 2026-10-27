// ------------------------------------------------------------------------------------------------
//                vm.ts - Complete rtnetlink observations and exact VM topology identities
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { DESKTOP_VM_OBSERVATION_PROTOCOL } from '../protocol.js';
import { freezeObservation } from './data.js';
import type { AddressFamily } from '../../address.js';

const dump = z.string().max(1024 * 1024).regex(/^(?:[a-f0-9]{2})*$/u);
const schema = z.strictObject({ format: z.literal(DESKTOP_VM_OBSERVATION_PROTOCOL), byteOrder: z.literal('little'),
  kernel: z.string().regex(/^[a-zA-Z0-9._+-]{1,128}$/u), architecture: z.literal('aarch64'),
  networkNamespace: z.string().regex(/^net:\[[0-9]{1,20}\]$/u), links: dump, addresses: dump, routes: dump, complete: z.literal(true) });
type Attributes = ReadonlyMap<number, Readonly<{ bytes: Buffer; flags: number }>>;
export interface DesktopVmAddress {
  readonly family: AddressFamily; readonly address: string; readonly prefix: number; readonly scope: number; readonly flags: number;
  readonly peer: string | null; readonly broadcast: string | null; readonly anycast: string | null;
  readonly attributes: readonly string[];
}
export interface DesktopVmInterface {
  readonly index: number; readonly name: string; readonly flags: number; readonly kind: string | null;
  readonly macAddress: string | null; readonly masterIndex: number | null; readonly linkIndex: number | null;
  readonly networkNamespaceId: number | null; readonly operationalState: number | null; readonly carrier: number | null;
  readonly ipv6Flags: number | null;
  readonly tsoMaxSize: number | null;
  readonly attributes: readonly string[]; readonly addresses: readonly DesktopVmAddress[];
}
export interface DesktopVmRoute {
  readonly family: AddressFamily; readonly destination: string; readonly prefix: number;
  readonly source: string | null; readonly sourcePrefix: number; readonly interfaceIndex: number | null;
  readonly gateways: readonly string[];
  readonly nextHops: readonly Readonly<{ interfaceIndex: number; flags: number; hops: number; gateways: readonly string[] }>[];
  readonly table: number; readonly protocol: number; readonly scope: number; readonly type: number; readonly flags: number;
  readonly preferredSource: string | null; readonly priority: number | null; readonly attributes: readonly string[];
}
export interface DesktopVmSnapshot {
  readonly kernel: string; readonly architecture: 'aarch64'; readonly networkNamespace: string;
  readonly interfaces: readonly DesktopVmInterface[]; readonly routes: readonly DesktopVmRoute[];
}
export interface DesktopVmObservation {
  readonly snapshot: DesktopVmSnapshot;
  readonly excludedCidrs: readonly string[];
  readonly fingerprint: string;
}

const align = (value: number) => (value + 3) & ~3;
function familyNumber(value: number): AddressFamily {
  if (value === 2) return 4;
  if (value === 10) return 6;
  throw new TypeError('Unsupported native address family.');
}
function requireFact(condition: unknown, message: string): void { if (!condition) throw new TypeError(message); }
function address(bytes: Buffer, family: AddressFamily): string {
  requireFact(bytes.length === (family === 4 ? 4 : 16), 'Invalid netlink address width.');
  return family === 4 ? [...bytes].join('.') : Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(':');
}
function attributes(bytes: Buffer, start: number, paddingType?: number): Attributes {
  const values = new Map<number, { bytes: Buffer; flags: number }>();
  let offset = start;
  while (offset < bytes.length) {
    requireFact(bytes.length - offset >= 4, 'Truncated netlink attribute.');
    const length = bytes.readUInt16LE(offset);
    const rawType = bytes.readUInt16LE(offset + 2);
    const type = rawType & 0x3fff;
    requireFact(length >= 4 && offset + align(length) <= bytes.length, 'Invalid netlink attribute length.');
    if (type === paddingType) {
      requireFact(length === 4 && rawType === paddingType, 'Invalid netlink alignment padding.');
      offset += align(length); continue;
    }
    requireFact(!values.has(type), 'Duplicate netlink attribute.');
    values.set(type, { bytes: bytes.subarray(offset + 4, offset + length), flags: rawType & 0xc000 });
    offset += align(length);
  }
  return values;
}
function integerAttribute(values: Attributes, key: number, fallback: number | null = null): number | null {
  const value = values.get(key);
  if (!value) return fallback;
  requireFact(value.flags === 0 && value.bytes.length === 4, 'Invalid netlink integer attribute.');
  return value.bytes.readUInt32LE(0);
}
function byteAttribute(values: Attributes, key: number): number | null {
  const value = values.get(key);
  if (!value) return null;
  requireFact(value.flags === 0 && value.bytes.length === 1, 'Invalid netlink byte attribute.');
  return value.bytes[0];
}
function addressAttribute(values: Attributes, key: number, family: AddressFamily): string | null {
  const value = values.get(key);
  if (!value) return null;
  requireFact(value.flags === 0, 'Invalid netlink address flags.');
  return address(value.bytes, family);
}
function textAttribute(values: Attributes, key: number, maximum: number): string | null {
  const value = values.get(key);
  if (!value) return null;
  requireFact(value.flags === 0 && value.bytes.length > 1 && value.bytes.length <= maximum + 1 && value.bytes.at(-1) === 0,
    'Invalid terminated netlink text.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(value.bytes.subarray(0, -1));
  requireFact(/^[^\u0000-\u0020\u007f/]+$/u.test(text), 'Invalid netlink identity text.');
  return text;
}
function identityAttributes(values: Attributes, omitted: readonly number[]): readonly string[] {
  return [...values].filter(([key]) => !omitted.includes(key)).sort(([left], [right]) => left - right)
    .map(([key, value]) => `${key}:${value.flags}:${value.bytes.toString('hex')}`);
}
function normalizedLinkAttributes(values: Attributes): readonly string[] {
  const result = [...identityAttributes(values, [7, 16, 18, 23, 26, 33, 35, 47, 48, 59])];
  const linkInfo = values.get(18);
  if (linkInfo) {
    const information = attributes(linkInfo.bytes, 0);
    const kind = textAttribute(information, 1, 31);
    const slaveKind = textAttribute(information, 4, 31);
    const fixed = identityAttributes(information, [2, 5]);
    const data = information.get(2);
    const slave = information.get(5);
    // Linux v6.12 if_link.h: BR timers16–19/FDB count48; BRPORT timers21–23/counts38,41.
    const normalData = data && kind === 'bridge' ? identityAttributes(attributes(data.bytes, 0, 40), [16, 17, 18, 19, 48]) : data?.bytes.toString('hex');
    const normalSlave = slave && slaveKind === 'bridge' ? identityAttributes(attributes(slave.bytes, 0, 26), [21, 22, 23, 38, 41]) : slave?.bytes.toString('hex');
    result.push(`18:${linkInfo.flags}:${JSON.stringify({ fixed, data: normalData ?? null, slave: normalSlave ?? null })}`);
  }
  const addressFamilies = values.get(26);
  if (addressFamilies) {
    const families = attributes(addressFamilies.bytes, 0);
    const fixed = [...identityAttributes(families, [10])];
    const ipv6 = families.get(10);
    if (ipv6) {
      const facts = attributes(ipv6.bytes, 0);
      const cache = facts.get(5);
      if (cache) requireFact(cache.bytes.length === 16 && cache.flags === 0, 'Invalid IPv6 interface cache information.');
      // Keep configuration, token, generator and RA MTU; omit packet counters/cache clock values.
      fixed.push(`10:${ipv6.flags}:${JSON.stringify({ facts: identityAttributes(facts, [1, 3, 5, 6]),
        maximumReassembly: cache?.bytes.readUInt32LE(0) ?? null })}`);
    }
    result.push(`26:${addressFamilies.flags}:${JSON.stringify(fixed.sort())}`);
  }
  return result.sort();
}
function ipv6InterfaceFlags(values: Attributes): number | null {
  const families = values.get(26);
  const ipv6 = families && attributes(families.bytes, 0).get(10);
  return ipv6 ? integerAttribute(attributes(ipv6.bytes, 0), 1) : null;
}
function records(hex: string, type: number, headerBytes: number) {
  const bytes = Buffer.from(hex, 'hex');
  const result: { body: Buffer; attributes: Attributes }[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    requireFact(bytes.length - offset >= 16, 'Truncated netlink record.');
    const length = bytes.readUInt32LE(offset);
    requireFact(length >= 16 + headerBytes && offset + align(length) <= bytes.length, 'Invalid netlink record length.');
    requireFact(bytes.readUInt16LE(offset + 4) === type, 'Unexpected netlink record kind.');
    requireFact((bytes.readUInt16LE(offset + 6) & 0x12) === 2, 'Non-multipart or interrupted netlink record.');
    const body = bytes.subarray(offset + 16, offset + length);
    result.push({ body, attributes: attributes(body, headerBytes) });
    requireFact(result.length <= 8192, 'Too many netlink records.');
    offset += align(length);
  }
  return result;
}
function routeGateways(values: Attributes, family: AddressFamily): string[] {
  const result: string[] = [];
  const gateway = addressAttribute(values, 5, family);
  if (gateway) result.push(gateway);
  const via = values.get(18);
  if (via) {
    requireFact(via.flags === 0 && via.bytes.length >= 2, 'Invalid route via address.');
    result.push(address(via.bytes.subarray(2), familyNumber(via.bytes.readUInt16LE(0))));
  }
  requireFact(!(gateway && via), 'Ambiguous route gateway.');
  return result;
}

export function parseDesktopVmObservation(input: unknown): DesktopVmObservation {
  const value = schema.parse(input);
  const interfaces = records(value.links, 16, 16).map(({ body, attributes: values }) => {
    const index = body.readInt32LE(4);
    const name = textAttribute(values, 3, 15);
    if (index <= 0 || name === null) throw new TypeError('Missing native interface identity.');
    const linkInfo = values.get(18);
    if (linkInfo) requireFact(linkInfo.flags === 0 || linkInfo.flags === 0x8000, 'Invalid nested link information.');
    const mac = values.get(1);
    if (mac) requireFact(mac.flags === 0 && mac.bytes.length <= 32, 'Invalid native link address.');
    const addresses: DesktopVmAddress[] = [];
    return { index, name, flags: body.readUInt32LE(8), kind: linkInfo ? textAttribute(attributes(linkInfo.bytes, 0), 1, 31) : null,
      macAddress: mac ? [...mac.bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(':') : null,
      masterIndex: integerAttribute(values, 10), linkIndex: integerAttribute(values, 5),
      networkNamespaceId: integerAttribute(values, 37), operationalState: byteAttribute(values, 16), carrier: byteAttribute(values, 33),
      ipv6Flags: ipv6InterfaceFlags(values),
      tsoMaxSize: integerAttribute(values, 59),
      // Statistics and carrier transition counts are telemetry, not interface authority.
      attributes: normalizedLinkAttributes(values), addresses };
  }).sort((left, right) => left.index - right.index);
  requireFact(interfaces.length > 0 && interfaces.length <= 256, 'Invalid bounded interface census.');
  const byIndex = new Map(interfaces.map((entry) => [entry.index, entry]));
  requireFact(byIndex.size === interfaces.length && new Set(interfaces.map((entry) => entry.name)).size === interfaces.length,
    'Duplicate VM interface identity.');
  for (const device of interfaces) if (device.masterIndex !== null) requireFact(byIndex.has(device.masterIndex), 'Link master interface is missing.');
  const excludedCidrs: string[] = [];
  for (const { body, attributes: values } of records(value.addresses, 20, 8)) {
    const family = familyNumber(body[0]);
    const prefix = body[1];
    requireFact(prefix <= (family === 4 ? 32 : 128), 'Invalid address prefix.');
    const target = byIndex.get(body.readUInt32LE(4));
    if (!target) throw new TypeError('Address references a missing interface.');
    for (const key of values.keys()) requireFact(key >= 1 && key <= 11, 'Unknown interface address attribute.');
    const native = addressAttribute(values, 1, family);
    const local = addressAttribute(values, 2, family) ?? native;
    if (local === null) throw new TypeError('Address is missing its numeric value.');
    const peer = native && native !== local ? native : null;
    const broadcast = addressAttribute(values, 4, family);
    const anycast = addressAttribute(values, 5, family);
    const flags = integerAttribute(values, 8, body[2]);
    if (flags === null) throw new TypeError('Missing address flags.');
    target.addresses.push({ family, address: local, prefix, scope: body[3], flags, peer, broadcast, anycast,
      attributes: identityAttributes(values, [6]) });
    requireFact(target.addresses.length <= 256, 'Too many interface addresses.');
    excludedCidrs.push(`${local}/${prefix}`);
    for (const address of [peer, broadcast, anycast]) if (address) excludedCidrs.push(`${address}/${family === 4 ? 32 : 128}`);
  }
  const routes: DesktopVmRoute[] = records(value.routes, 24, 12).map(({ body, attributes: values }) => {
    const family = familyNumber(body[0]);
    const prefix = body[1]; const sourcePrefix = body[2]; const bits = family === 4 ? 32 : 128;
    requireFact(prefix <= bits && sourcePrefix <= bits, 'Invalid route prefix.');
    const interfaceIndex = integerAttribute(values, 4);
    if (interfaceIndex !== null) requireFact(byIndex.has(interfaceIndex), 'Route references a missing interface.');
    const supported = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 15, 16, 18, 20, 23, 25, 26];
    for (const key of values.keys()) requireFact(supported.includes(key), `Unsupported route attribute ${key}.`);
    const destination = addressAttribute(values, 1, family) ?? (family === 4 ? '0.0.0.0' : '0:0:0:0:0:0:0:0');
    requireFact(prefix === 0 || values.has(1), 'Nondefault route is missing its destination.');
    if (prefix > 0) excludedCidrs.push(`${destination}/${prefix}`);
    const preferredSource = addressAttribute(values, 7, family);
    if (preferredSource) excludedCidrs.push(`${preferredSource}/${bits}`);
    const source = addressAttribute(values, 2, family);
    requireFact(sourcePrefix === 0 || source !== null, 'Source-selected route is incomplete.');
    const gateways = routeGateways(values, family);
    const nextHops: { interfaceIndex: number; flags: number; hops: number; gateways: string[] }[] = [];
    const multiple = values.get(9);
    if (multiple) {
      requireFact(multiple.flags === 0, 'Invalid multipath flags.');
      let offset = 0;
      while (offset < multiple.bytes.length) {
        const data = multiple.bytes.subarray(offset);
        requireFact(data.length >= 8, 'Truncated next hop.');
        const length = data.readUInt16LE(0);
        requireFact(length >= 8 && align(length) <= data.length, 'Invalid next hop size.');
        const index = data.readInt32LE(4);
        requireFact(byIndex.has(index), 'Next hop interface is missing.');
        const nested = attributes(data.subarray(0, length), 8);
        for (const key of nested.keys()) requireFact(key === 5 || key === 18, 'Unsupported multipath attribute.');
        const observed = routeGateways(nested, family); gateways.push(...observed);
        nextHops.push({ interfaceIndex: index, flags: data[2], hops: data[3], gateways: observed });
        requireFact(nextHops.length <= 256, 'Too many next hops.'); offset += align(length);
      }
    }
    for (const gateway of gateways) excludedCidrs.push(`${gateway}/${gateway.includes(':') ? 128 : 32}`);
    const table = integerAttribute(values, 15, body[4]);
    if (table === null) throw new TypeError('Missing route table.');
    return { family, destination, prefix, source, sourcePrefix, interfaceIndex, gateways, nextHops, table,
      protocol: body[5], scope: body[6], type: body[7], flags: body.readUInt32LE(8), preferredSource,
      priority: integerAttribute(values, 6), attributes: identityAttributes(values, [12]) };
  });
  requireFact(routes.length <= 4096 && excludedCidrs.length <= 4096, 'VM observation exceeds its semantic bounds.');
  for (const device of interfaces) device.addresses.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  routes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const snapshot: DesktopVmSnapshot = { kernel: value.kernel, architecture: value.architecture, networkNamespace: value.networkNamespace, interfaces, routes };
  freezeObservation(snapshot);
  return Object.freeze({ snapshot, excludedCidrs: Object.freeze(excludedCidrs),
    fingerprint: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') });
}
