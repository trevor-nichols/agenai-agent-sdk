export const DESKTOP_HOST_OBSERVATION_PROTOCOL = 'agenai.desktop-host-network.v1';
export const DESKTOP_VM_OBSERVATION_PROTOCOL = 'agenai.desktop-vm-network.v1';
export const DESKTOP_VM_CONTROLLER_PROTOCOL = 'agenai.sandbox.desktop-route-observer.v1';
export const DESKTOP_VM_EXECUTABLE = '/usr/local/bin/agenai-sandbox-desktop-route';
export const DESKTOP_VM_ROOT = '/opt/agenai/desktop-route';
export const DESKTOP_VM_CONFIG_ENV = 'AGENAI_DESKTOP_ROUTE_CONFIG';
export const DESKTOP_VM_IMAGE_PROTOCOL_LABEL = 'ai.agen.sandbox.desktop-route.protocol';
export const DESKTOP_VM_IMAGE_OBSERVATION_LABEL = 'ai.agen.sandbox.desktop-route.observation';
export const DESKTOP_VM_IMAGE_SOURCE_LABEL = 'ai.agen.sandbox.desktop-route.source';
export const DESKTOP_VM_IMAGE_USER_LABEL = 'ai.agen.sandbox.desktop-route.user';
export const DESKTOP_VM_ENVIRONMENT = Object.freeze(['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp']);
export const DESKTOP_VM_CONTROL_FRAME_BYTES = 4096;

export interface DesktopVmObserverConfiguration {
  readonly protocol: typeof DESKTOP_VM_CONTROLLER_PROTOCOL;
  readonly heartbeatMs: number;
  readonly leaseTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly maxOutputBytes: number;
}

export type DesktopVmObserverCommand = Readonly<{
  protocol: typeof DESKTOP_VM_CONTROLLER_PROTOCOL;
  kind: 'heartbeat' | 'observe' | 'stop';
  sequence: number;
}>;

export type DesktopVmObserverCloseReason = 'stop' | 'control_eof' | 'lease_expired' | 'invalid_control' | 'observation_failure' | 'output_failure';
export type DesktopVmObserverFrame =
  | Readonly<{ protocol: typeof DESKTOP_VM_CONTROLLER_PROTOCOL; kind: 'ready'; observationProtocol: typeof DESKTOP_VM_OBSERVATION_PROTOCOL }>
  | Readonly<{ protocol: typeof DESKTOP_VM_CONTROLLER_PROTOCOL; kind: 'heartbeat'; sequence: number }>
  | Readonly<{ protocol: typeof DESKTOP_VM_CONTROLLER_PROTOCOL; kind: 'observation'; sequence: number; document: Readonly<Record<string, unknown>> }>
  | Readonly<{ protocol: typeof DESKTOP_VM_CONTROLLER_PROTOCOL; kind: 'closed'; reason: DesktopVmObserverCloseReason }>;

export function desktopVmObserverCommand(): readonly string[] {
  return Object.freeze(['--input-type=module', '--eval',
    `import { runDesktopVmRouteObserverHelper } from "${DESKTOP_VM_ROOT}/network/desktop/entry.js"; await runDesktopVmRouteObserverHelper();`]);
}

function record(input: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Expected a Desktop observer data object.');
  const names = Reflect.ownKeys(input);
  if (names.length !== expected.length) throw new TypeError('Unexpected Desktop observer fields.');
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(input, name);
    if (typeof name !== 'string' || !expected.includes(name) || !property?.enumerable || !('value' in property)) throw new TypeError('Expected closed Desktop observer data fields.');
    result[name] = property.value;
  }
  return result;
}

function integer(input: unknown, minimum: number, maximum: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) throw new TypeError('Invalid Desktop observer integer.');
  return input;
}

export function parseDesktopVmObserverConfiguration(input: unknown): DesktopVmObserverConfiguration {
  const value = record(input, ['protocol', 'heartbeatMs', 'leaseTimeoutMs', 'commandTimeoutMs', 'maxOutputBytes']);
  if (value.protocol !== DESKTOP_VM_CONTROLLER_PROTOCOL) throw new TypeError('Unexpected Desktop observer protocol.');
  const heartbeatMs = integer(value.heartbeatMs, 1, 5000);
  const commandTimeoutMs = integer(value.commandTimeoutMs, 1, 30000);
  const leaseTimeoutMs = integer(value.leaseTimeoutMs, 100, 120000);
  if (leaseTimeoutMs < commandTimeoutMs + 2 * heartbeatMs) throw new TypeError('Desktop observer lease cannot contain a complete observation.');
  return Object.freeze({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, heartbeatMs, leaseTimeoutMs, commandTimeoutMs,
    maxOutputBytes: integer(value.maxOutputBytes, 1024, 4194304) });
}

export function parseDesktopVmObserverCommand(input: unknown): DesktopVmObserverCommand {
  const value = record(input, ['protocol', 'kind', 'sequence']);
  if (value.protocol !== DESKTOP_VM_CONTROLLER_PROTOCOL || (value.kind !== 'heartbeat' && value.kind !== 'observe' && value.kind !== 'stop')) throw new TypeError('Unsupported Desktop observer command.');
  return Object.freeze({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: value.kind,
    sequence: integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) });
}

export function parseDesktopVmObserverFrame(input: unknown): DesktopVmObserverFrame {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Expected a Desktop observer frame.');
  const kind = Object.getOwnPropertyDescriptor(input, 'kind');
  if (!kind || !('value' in kind)) throw new TypeError('Missing Desktop observer response kind.');
  if (kind.value === 'ready') {
    const value = record(input, ['protocol', 'kind', 'observationProtocol']);
    if (value.protocol !== DESKTOP_VM_CONTROLLER_PROTOCOL || value.observationProtocol !== DESKTOP_VM_OBSERVATION_PROTOCOL) throw new TypeError('Unexpected Desktop observer readiness.');
    return Object.freeze({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'ready', observationProtocol: DESKTOP_VM_OBSERVATION_PROTOCOL });
  }
  if (kind.value === 'heartbeat') {
    const value = record(input, ['protocol', 'kind', 'sequence']);
    if (value.protocol !== DESKTOP_VM_CONTROLLER_PROTOCOL) throw new TypeError('Unexpected Desktop observer protocol.');
    return Object.freeze({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'heartbeat', sequence: integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) });
  }
  if (kind.value === 'observation') {
    const value = record(input, ['protocol', 'kind', 'sequence', 'document']);
    if (value.protocol !== DESKTOP_VM_CONTROLLER_PROTOCOL) throw new TypeError('Unexpected Desktop observer protocol.');
    const document = record(value.document, ['format', 'byteOrder', 'kernel', 'architecture', 'networkNamespace', 'links', 'addresses', 'routes', 'complete']);
    return Object.freeze({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observation', sequence: integer(value.sequence, 1, Number.MAX_SAFE_INTEGER), document: Object.freeze(document) });
  }
  const value = record(input, ['protocol', 'kind', 'reason']);
  if (value.protocol !== DESKTOP_VM_CONTROLLER_PROTOCOL || value.kind !== 'closed') throw new TypeError('Unexpected Desktop observer response.');
  const reason = value.reason;
  if (reason !== 'stop' && reason !== 'control_eof' && reason !== 'lease_expired' && reason !== 'invalid_control'
    && reason !== 'observation_failure' && reason !== 'output_failure') throw new TypeError('Unknown Desktop observer close reason.');
  return Object.freeze({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'closed', reason });
}
