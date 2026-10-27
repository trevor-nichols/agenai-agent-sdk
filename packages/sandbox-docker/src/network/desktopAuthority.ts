// ------------------------------------------------------------------------------------------------
//                desktopAuthority.ts - Closed inert Docker Desktop route authority identity
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import type { DockerSandboxProfile } from '../policy/profiles.js';
import {
  DESKTOP_HOST_OBSERVATION_PROTOCOL, DESKTOP_VM_CONTROLLER_PROTOCOL,
  DESKTOP_VM_EXECUTABLE, DESKTOP_VM_OBSERVATION_PROTOCOL,
} from './desktop/protocol.js';

export type DockerDesktopRouteAuthorityProfile = Exclude<DockerSandboxProfile, 'linux-x64'>;

export interface DockerDesktopRouteAuthorityIdentity {
  readonly kind: 'local_docker_desktop';
  readonly profile: DockerDesktopRouteAuthorityProfile;
  readonly stability: 'caller_owned_quiescence';
  readonly interception: 'caller_owned_no_transparent_or_per_app_interception';
  readonly engine: Readonly<{ endpoint: string; id: string }>;
  readonly deployment: Readonly<{
    desktopVersion: string;
    desktopBuild: string;
    virtualMachineManager: 'apple_virtualization';
    rosetta: true;
    enhancedContainerIsolation: false;
    hostNetworking: false;
    kernelUdp: false;
    networkingMode: 'ipv4only';
    dnsInhibition: 'auto';
    dockerSubnet: '192.168.65.0/24';
    proxyMode: 'automatic_system';
    manualProxyConfiguration: false;
  }>;
  readonly hostObserver: Readonly<{
    protocol: 'agenai.desktop-host-network.v1';
    executable: Readonly<{ path: string; sha256: string }>;
    sourceDigest: string;
  }>;
  readonly vmObserver: Readonly<{
    protocol: 'agenai.sandbox.desktop-route-observer.v1';
    observationProtocol: 'agenai.desktop-vm-network.v1';
    imageDigest: string;
    sourceDigest: string;
    executable: '/usr/local/bin/agenai-sandbox-desktop-route';
    user: Readonly<{ uid: number; gid: number }>;
    resources: Readonly<{ cpus: number; memoryBytes: number; pids: number }>;
    temporaryBytes: number;
    control: Readonly<{ heartbeatMs: number; leaseTimeoutMs: number }>;
  }>;
  readonly pollIntervalMs: number;
  readonly commandTimeoutMs: number;
  readonly maxOutputBytes: number;
}

const noControls = (value: string) => !/\p{Cc}/u.test(value);
const identityString = (maximum: number) => z.string().refine((value) => {
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= 1 && bytes <= maximum && noControls(value);
}, `Expected 1–${maximum} UTF-8 bytes without control characters`);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const optionsSchema = z.strictObject({
  kind: z.literal('local_docker_desktop'),
  profile: z.enum(['desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64']),
  stability: z.literal('caller_owned_quiescence'),
  interception: z.literal('caller_owned_no_transparent_or_per_app_interception'),
  engine: z.strictObject({
    endpoint: z.string().max(512).regex(/^unix:\/\/\/[a-zA-Z0-9_.\-/]+$/u)
      .refine((value) => !value.slice(7).split('/').some((part) => part === '.' || part === '..')
        && !value.includes('//', 7), 'Expected a canonical absolute Unix socket endpoint'),
    id: identityString(256),
  }),
  deployment: z.strictObject({
    desktopVersion: identityString(64), desktopBuild: identityString(64),
    virtualMachineManager: z.literal('apple_virtualization'), rosetta: z.literal(true),
    enhancedContainerIsolation: z.literal(false), hostNetworking: z.literal(false), kernelUdp: z.literal(false),
    networkingMode: z.literal('ipv4only'), dnsInhibition: z.literal('auto'), dockerSubnet: z.literal('192.168.65.0/24'),
    proxyMode: z.literal('automatic_system'), manualProxyConfiguration: z.literal(false),
  }),
  hostObserver: z.strictObject({
    protocol: z.literal(DESKTOP_HOST_OBSERVATION_PROTOCOL),
    executable: z.strictObject({
      path: z.string().refine((value) => {
        const bytes = Buffer.byteLength(value, 'utf8');
        return bytes >= 2 && bytes <= 4096 && value.startsWith('/') && noControls(value)
          && value.slice(1).split('/').every((part) => part !== '' && part !== '.' && part !== '..');
      }, 'Expected a canonical absolute physical observer path'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
    sourceDigest: digestSchema,
  }),
  vmObserver: z.strictObject({
    protocol: z.literal(DESKTOP_VM_CONTROLLER_PROTOCOL), observationProtocol: z.literal(DESKTOP_VM_OBSERVATION_PROTOCOL),
    imageDigest: digestSchema, sourceDigest: digestSchema, executable: z.literal(DESKTOP_VM_EXECUTABLE),
    user: z.strictObject({ uid: z.number().int().min(1).max(262_143), gid: z.number().int().min(1).max(262_143) }),
    resources: z.strictObject({
      cpus: z.number().positive().max(1024).refine((value) => Number.isSafeInteger(value * 1_000_000_000)),
      memoryBytes: z.number().int().min(6 * 1024 ** 2), pids: z.number().int().positive(),
    }),
    temporaryBytes: z.number().int().positive(),
    control: z.strictObject({ heartbeatMs: z.number().int().min(1).max(5000), leaseTimeoutMs: z.number().int().min(100).max(120_000) }),
  }),
  pollIntervalMs: z.number().int().min(25).max(60_000), commandTimeoutMs: z.number().int().min(1).max(30_000),
  maxOutputBytes: z.number().int().min(1024).max(4 * 1024 ** 2),
}).refine((value) => value.vmObserver.control.leaseTimeoutMs >= value.commandTimeoutMs + 2 * value.vmObserver.control.heartbeatMs,
  { path: ['vmObserver', 'control', 'leaseTimeoutMs'], message: 'VM observer lease must cover the command timeout and two heartbeats' });

function captureData(input: unknown, depth = 0, budget = { nodes: 128 }): unknown {
  if (--budget.nodes < 0 || depth > 4) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Desktop route authority exceeds its bounded data graph' }]);
  }
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Reflect.ownKeys(input).length > 64) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Desktop route authority requires bounded plain data objects' }]);
  }
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || key === '__proto__' || property === undefined || !('value' in property) || !property.enumerable) {
      throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Desktop route authority cannot contain accessors, symbols or hidden fields' }]);
    }
    captured[key] = captureData(property.value, depth + 1, budget);
  }
  return captured;
}

export function parseDockerDesktopRouteAuthority(input: unknown): DockerDesktopRouteAuthorityIdentity {
  const captured = captureData(input);
  const parsed = optionsSchema.safeParse(captured);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(optionsSchema, parsed.error, captured));
  const value = parsed.data;
  return Object.freeze({ ...value, engine: Object.freeze(value.engine), deployment: Object.freeze(value.deployment),
    hostObserver: Object.freeze({ ...value.hostObserver, executable: Object.freeze(value.hostObserver.executable) }),
    vmObserver: Object.freeze({ ...value.vmObserver, user: Object.freeze(value.vmObserver.user),
      resources: Object.freeze(value.vmObserver.resources), control: Object.freeze(value.vmObserver.control) }) });
}
