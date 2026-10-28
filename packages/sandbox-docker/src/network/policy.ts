// ------------------------------------------------------------------------------------------------
//                policy.ts - Canonical IP ranges and closed destination admission
// ------------------------------------------------------------------------------------------------

import { formatNumericAddress, parseNumericAddress, prefixMask } from './address.js';

export interface HttpsDestination { readonly hostname: string; readonly port: number }
interface Range { readonly family: 4 | 6; readonly prefix: number; readonly address: bigint }

export const SPECIAL_CIDRS = Object.freeze([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  '::/3', '4000::/2', '8000::/1', '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20',
]);

function parseRange(cidr: string): Range {
  const [address, rawPrefix, extra] = cidr.split('/');
  const parsed = parseNumericAddress(address);
  if (parsed === undefined || extra !== undefined || rawPrefix === undefined
    || !/^(0|[1-9][0-9]*)$/u.test(rawPrefix)) throw new TypeError('Invalid egress exclusion CIDR.');
  const prefix = Number(rawPrefix);
  if (prefix < 0 || prefix > (parsed.family === 4 ? 32 : 128)) throw new TypeError('Invalid egress exclusion prefix.');
  return { family: parsed.family, prefix, address: parsed.value & prefixMask(parsed.family, prefix) };
}

function contains(outer: Range, inner: Range): boolean {
  return outer.family === inner.family && outer.prefix <= inner.prefix && (inner.address & prefixMask(outer.family, outer.prefix)) === outer.address;
}

function formatRange(range: Range): string {
  return `${formatNumericAddress(range.address, range.family)}/${range.prefix}`;
}

/** Compare effective forbidden coverage; repeated private Docker bridges add no authority. */
export function deniedCoverage(cidrs: readonly string[]): readonly string[] {
  if (cidrs.length > 4096) throw new TypeError('Too many observed route exclusions.');
  const sorted = [...SPECIAL_CIDRS, ...cidrs].map(parseRange).sort((left, right) => left.family - right.family || left.prefix - right.prefix
    || (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
  const result: Range[] = [];
  for (const range of sorted) if (!result.some((existing) => contains(existing, range))) result.push(range);
  return Object.freeze(result.map(formatRange).sort());
}

export function addressAdmission(exclusions: readonly string[]): (address: string) => boolean {
  const ranges = deniedCoverage(exclusions).map(parseRange);
  return (address) => {
    const parsed = parseNumericAddress(address);
    if (parsed === undefined) return false;
    const candidate: Range = { family: parsed.family, prefix: parsed.family === 4 ? 32 : 128, address: parsed.value };
    return !ranges.some((range) => contains(range, candidate));
  };
}

function canonicalHostname(hostname: string): boolean {
  const labels = hostname.split('.');
  return hostname.length <= 253 && labels.length >= 2 && labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label) && !label.startsWith('xn--')) && /[a-z]/u.test(labels.at(-1) ?? '');
}

export function parseConnect(header: string, destinations: readonly HttpsDestination[]): HttpsDestination {
  if (Buffer.byteLength(header) > 8192 || /[^\x20-\x7e\r\n]/u.test(header) || !header.endsWith('\r\n\r\n')) throw new TypeError('Invalid CONNECT header.');
  const lines = header.slice(0, -4).split('\r\n');
  const request = /^CONNECT ([a-z0-9.-]+):([1-9][0-9]{0,4}) HTTP\/1\.[01]$/u.exec(lines.shift() ?? '');
  if (!request || !canonicalHostname(request[1])) throw new TypeError('Invalid CONNECT authority.');
  const endpoint = { hostname: request[1], port: Number(request[2]) };
  if (endpoint.port > 65535 || !destinations.some((allowed) => allowed.hostname === endpoint.hostname && allowed.port === endpoint.port)) throw new TypeError('CONNECT destination is not admitted.');
  const fields = new Set<string>();
  for (const line of lines) {
    const field = /^(Host|Connection|Proxy-Connection): ([\x20-\x7e]+)$/iu.exec(line);
    if (!field || fields.has(field[1].toLowerCase())) throw new TypeError('Unexpected CONNECT header.');
    fields.add(field[1].toLowerCase());
    // Node's fetch (undici) takes Host from URL.host, which omits the default HTTPS port; the request line alone selects the destination.
    const host = field[2] === `${endpoint.hostname}:${endpoint.port}` || (endpoint.port === 443 && field[2] === endpoint.hostname);
    if (field[1].toLowerCase() === 'host' ? !host : !/^(close|keep-alive)$/iu.test(field[2])) throw new TypeError('Invalid CONNECT header value.');
  }
  if (!fields.has('host')) throw new TypeError('CONNECT requires an exact Host header.');
  return endpoint;
}

export function validDestination(value: unknown): value is HttpsDestination {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && 'hostname' in value && typeof value.hostname === 'string' && canonicalHostname(value.hostname)
    && 'port' in value && typeof value.port === 'number' && Number.isSafeInteger(value.port) && value.port >= 1 && value.port <= 65535;
}
