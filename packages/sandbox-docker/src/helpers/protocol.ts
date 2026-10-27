// ------------------------------------------------------------------------------------------------
//                protocol.ts - Fixed helper image commands, configuration and bounded control frames
// ------------------------------------------------------------------------------------------------

import { deniedCoverage, validDestination, type HttpsDestination } from '../network/policy.js';

export const EGRESS_PROTOCOL = 'agenai.sandbox.egress-connect.v1';
export const EGRESS_ROOT = '/opt/agenai/egress';
export const EGRESS_SOCKET_DIRECTORY = '/run/agenai-egress';
export const EGRESS_SOCKET_PATH = `${EGRESS_SOCKET_DIRECTORY}/connect.sock`;
export const EGRESS_PROXY_URL = 'http://127.0.0.1:3128';
export const EGRESS_CONFIG_ENV = 'AGENAI_EGRESS_CONFIG';
export const HELPER_IMAGE_PROTOCOL_LABEL = 'ai.agen.sandbox.egress.protocol';
export const HELPER_IMAGE_SOURCE_LABEL = 'ai.agen.sandbox.egress.source';
export const HELPER_IMAGE_USER_LABEL = 'ai.agen.sandbox.egress.user';
export const HELPER_ENVIRONMENT = Object.freeze(['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp']);
export const CONTROL_FRAME_BYTES = 4096;
export type EgressHelperRole = 'broker' | 'relay';
export type EgressCloseReason = 'stop' | 'control_eof' | 'lease_expired' | 'invalid_control' | 'runtime_failure';
export type EgressHelperConfiguration =
  | Readonly<{ protocol: typeof EGRESS_PROTOCOL; role: 'broker'; destinations: readonly HttpsDestination[]; excludedCidrs: readonly string[]; leaseTimeoutMs: number }>
  | Readonly<{ protocol: typeof EGRESS_PROTOCOL; role: 'relay'; leaseTimeoutMs: number }>;
export type EgressControllerFrame =
  | Readonly<{ protocol: typeof EGRESS_PROTOCOL; kind: 'heartbeat'; sequence: number }>
  | Readonly<{ protocol: typeof EGRESS_PROTOCOL; kind: 'stop' }>;
export type EgressHelperFrame =
  | Readonly<{ protocol: typeof EGRESS_PROTOCOL; kind: 'ready'; role: EgressHelperRole }>
  | Readonly<{ protocol: typeof EGRESS_PROTOCOL; kind: 'heartbeat'; sequence: number }>
  | Readonly<{ protocol: typeof EGRESS_PROTOCOL; kind: 'closed'; reason: EgressCloseReason }>;

export function helperCommand(role: EgressHelperRole): readonly string[] {
  return Object.freeze(['--input-type=module', '--eval', `import { runEgressHelper } from "${EGRESS_ROOT}/helpers/entry.js"; await runEgressHelper("${role}");`]);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Expected a helper protocol object.');
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || key === '__proto__' || !property || !('value' in property) || !property.enumerable) throw new TypeError('Expected helper data fields.');
    result[key] = property.value;
  }
  return result;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) throw new TypeError('Unexpected helper protocol fields.');
}

export function parseEgressHelperConfiguration(input: unknown): EgressHelperConfiguration {
  const value = object(input);
  if (Buffer.byteLength(JSON.stringify(value)) > 65536 || value.protocol !== EGRESS_PROTOCOL
    || !Number.isSafeInteger(value.leaseTimeoutMs) || typeof value.leaseTimeoutMs !== 'number' || value.leaseTimeoutMs < 1 || value.leaseTimeoutMs > 2_147_483_647) throw new TypeError('Invalid helper configuration.');
  if (value.role === 'relay') {
    keys(value, ['protocol', 'role', 'leaseTimeoutMs']);
    return Object.freeze({ protocol: EGRESS_PROTOCOL, role: 'relay', leaseTimeoutMs: value.leaseTimeoutMs });
  }
  keys(value, ['protocol', 'role', 'destinations', 'excludedCidrs', 'leaseTimeoutMs']);
  if (value.role !== 'broker' || !Array.isArray(value.destinations) || value.destinations.length < 1 || value.destinations.length > 128
    || !value.destinations.every(validDestination) || !Array.isArray(value.excludedCidrs) || value.excludedCidrs.some((cidr) => typeof cidr !== 'string')) throw new TypeError('Invalid broker configuration.');
  const destinations = value.destinations.map((destination) => Object.freeze({ hostname: destination.hostname, port: destination.port }));
  if (new Set(destinations.map((destination) => `${destination.hostname}:${destination.port}`)).size !== destinations.length) throw new TypeError('Duplicate broker destination.');
  return Object.freeze({ protocol: EGRESS_PROTOCOL, role: 'broker', destinations: Object.freeze(destinations),
    excludedCidrs: deniedCoverage(value.excludedCidrs), leaseTimeoutMs: value.leaseTimeoutMs });
}

export function parseControllerFrame(input: unknown): EgressControllerFrame {
  const value = object(input);
  if (value.protocol !== EGRESS_PROTOCOL) throw new TypeError('Unexpected control protocol.');
  if (value.kind === 'stop') { keys(value, ['protocol', 'kind']); return { protocol: EGRESS_PROTOCOL, kind: 'stop' }; }
  keys(value, ['protocol', 'kind', 'sequence']);
  if (value.kind !== 'heartbeat' || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new TypeError('Invalid heartbeat sequence.');
  return { protocol: EGRESS_PROTOCOL, kind: 'heartbeat', sequence: value.sequence };
}

export function parseHelperFrame(input: unknown): EgressHelperFrame {
  const value = object(input);
  if (value.protocol !== EGRESS_PROTOCOL) throw new TypeError('Unexpected helper protocol.');
  if (value.kind === 'ready') {
    keys(value, ['protocol', 'kind', 'role']);
    if (value.role !== 'broker' && value.role !== 'relay') throw new TypeError('Invalid helper role.');
    return { protocol: EGRESS_PROTOCOL, kind: 'ready', role: value.role };
  }
  if (value.kind === 'closed') {
    keys(value, ['protocol', 'kind', 'reason']);
    if (value.reason !== 'stop' && value.reason !== 'control_eof' && value.reason !== 'lease_expired' && value.reason !== 'invalid_control' && value.reason !== 'runtime_failure') throw new TypeError('Invalid helper closure reason.');
    return { protocol: EGRESS_PROTOCOL, kind: 'closed', reason: value.reason };
  }
  const frame = parseControllerFrame(value);
  if (frame.kind !== 'heartbeat') throw new TypeError('Unexpected helper frame.');
  return frame;
}
