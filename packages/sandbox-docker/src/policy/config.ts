// ------------------------------------------------------------------------------------------------
//                config.ts - Explicit inert local Docker authority - Strict public configuration
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { parseSandboxSpillDirectory } from '@agen-ai/sandbox/node';
import { DOCKER_SANDBOX_PROFILES } from './profiles.js';
import type { DockerDesktopSandboxProfile, DockerSandboxProfile } from './profiles.js';
import { desktopSharedAuthorityDigest } from './coordination.js';
import { datasetsSchema, MAX_DATASET_ATTACHMENTS, normalizeDatasets } from '../datasets/configuration.js';
import { captureDockerRouteAuthority } from '../network/routeAuthority.js';
import type {
  DockerDesktopRouteAuthorityBinding, DockerRouteAuthorityBinding, DockerRouteAuthorityIdentity,
} from '../network/routeAuthority.js';
import { captureDesktopCoordinatorAuthority } from '../network/desktop/coordinator/binding.js';
import type { DesktopCoordinatorBinding } from '../network/desktop/coordinator/binding.js';
import { DESKTOP_COORDINATOR_POLICY } from '../network/desktop/coordinator/policy.js';
import type { DockerSandboxBackendOptions, DockerSandboxEgressOptions } from './options.js';
import type { DockerSandboxDataset } from '../datasets/types.js';

export interface DockerSandboxEgressConfig extends Omit<DockerSandboxEgressOptions, 'routeAuthority'> {
  readonly routeAuthority: DockerRouteAuthorityIdentity;
}

interface DockerSandboxBaseConfig extends Omit<DockerSandboxBackendOptions, 'egress'> {
  readonly profile: DockerSandboxProfile;
  readonly datasets: readonly DockerSandboxDataset[];
}

/** Captured host authority is correlated with, but separate from, inert configuration identity. */
type DockerLegacySandboxConfig = DockerSandboxBaseConfig & (
  | Readonly<{ egress: undefined; egressAuthority: undefined }>
  | Readonly<{ egress: DockerSandboxEgressConfig; egressAuthority: DockerRouteAuthorityBinding }>
) & Readonly<{ coordination?: undefined; coordinator?: undefined }>;

type DockerCoordinatedConfig = Omit<DockerSandboxBaseConfig, 'profile'> & Readonly<{
  profile: DockerDesktopSandboxProfile;
  egress: DockerSandboxEgressConfig & Readonly<{ routeAuthority: DockerDesktopRouteAuthorityBinding['identity'] }>;
  egressAuthority: DockerDesktopRouteAuthorityBinding;
  coordination: DesktopCoordinatorBinding['identity'];
}>;

export type DockerCoordinatedSandboxConfig = DockerCoordinatedConfig & Readonly<{ coordinator: DesktopCoordinatorBinding }>;
export type DockerCoordinatedCleanupConfig = DockerCoordinatedConfig & Readonly<{ coordinator?: undefined }>;
export type DockerSandboxConfig = DockerLegacySandboxConfig | DockerCoordinatedSandboxConfig | DockerCoordinatedCleanupConfig;

const userSchema = z.strictObject({ uid: z.number().int().min(1).max(262_143), gid: z.number().int().min(1).max(262_143) });
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const resourcesSchema = z.strictObject({
  cpus: z.number().positive().max(1024).refine((value) => Number.isSafeInteger(value * 1_000_000_000)),
  memoryBytes: z.number().int().min(6 * 1024 ** 2),
  pids: z.number().int().positive(),
});
const helperBudgetSchema = z.strictObject({ resources: resourcesSchema, temporaryBytes: z.number().int().positive() });
const controlSchema = z.strictObject({ heartbeatMs: z.number().int().min(1).max(2_147_483_647),
  leaseTimeoutMs: z.number().int().min(1).max(2_147_483_647) })
  .refine((value) => value.leaseTimeoutMs > value.heartbeatMs, 'Control lease must exceed its heartbeat interval');
function configurationSchema(identity?: DockerRouteAuthorityIdentity) { return z.strictObject({
  profile: z.enum(DOCKER_SANDBOX_PROFILES).default('linux-x64'),
  endpoint: z.string().min(9).max(512).regex(/^unix:\/\/\/[a-zA-Z0-9_.\-/]+$/u)
    .refine((value) => !value.slice(7).split('/').some((part) => part === '.' || part === '..') && !value.includes('//', 7), 'Expected a canonical absolute Unix socket endpoint'),
  namespace: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  imageDigest: imageDigestSchema,
  spillDirectory: z.string(),
  user: userSchema,
  datasets: datasetsSchema.default([]),
  egress: z.strictObject({ imageDigest: imageDigestSchema, protocol: z.literal('agenai.sandbox.egress-connect.v1'),
    user: userSchema, broker: helperBudgetSchema, relay: helperBudgetSchema,
    routeAuthority: z.custom<DockerRouteAuthorityIdentity>((value) => identity !== undefined && value === identity),
    control: controlSchema,
  }).optional(),
  filesystem: z.strictObject({ imageDigest: imageDigestSchema, protocol: z.literal('agenai.sandbox.filesystem.v1'),
    executable: z.literal('/usr/local/bin/agenai-sandbox-files'), layout: z.literal('agenai.sandbox.workspace.v1'),
    user: userSchema, resources: resourcesSchema, temporaryBytes: z.number().int().positive(), control: controlSchema }).optional(),
}).refine((value) => value.filesystem === undefined
  || value.filesystem.user.uid === value.user.uid && value.filesystem.user.gid === value.user.gid,
  { path: ['filesystem', 'user'], message: 'Prepared filesystem helper must use the exact workload UID and GID' })
  .superRefine((value, context) => {
    if (value.egress === undefined || identity === undefined) return;
    const authorityProfile = identity.kind === 'local_linux_same_host' ? 'linux-x64' : identity.profile;
    if (value.profile !== authorityProfile) context.addIssue({ code: 'custom', path: ['egress', 'routeAuthority'],
      message: 'Route authority must match the selected Docker backend profile' });
    if (identity.kind === 'local_docker_desktop' && value.endpoint !== identity.engine.endpoint) {
      context.addIssue({ code: 'custom', path: ['egress', 'routeAuthority', 'engine', 'endpoint'],
        message: 'Desktop route authority must bind the exact selected Docker endpoint' });
    }
  }); }

function plainData(value: unknown, captureAuthority: (value: unknown) => DockerRouteAuthorityIdentity,
  path: readonly string[] = [], budget = { nodes: 1024 }, captureCoordinator?: (value: unknown) => void): unknown {
  if (--budget.nodes < 0 || path.length > 8) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker configuration exceeds its bounded data graph' }]);
  }
  if (path.length === 2 && path[0] === 'egress' && path[1] === 'routeAuthority') return captureAuthority(value);
  if (path.length === 1 && path[0] === 'coordinator' && captureCoordinator !== undefined) {
    captureCoordinator(value);
    return undefined;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const maximum = path.length === 1 && path[0] === 'datasets' ? MAX_DATASET_ATTACHMENTS : 128;
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) {
      throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker datasets require a bounded dense data array' }]);
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry || !('value' in entry) || !entry.enumerable) {
        throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker dataset entries must be enumerable data properties' }]);
      }
      result.push(plainData(entry.value, captureAuthority, [...path, String(index)], budget, captureCoordinator));
    }
    return result;
  }
  if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Reflect.ownKeys(value).length > 64) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker configuration requires plain data objects' }]);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || key === '__proto__' || property === undefined || !('value' in property) || !property.enumerable) {
      throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker configuration cannot contain accessors, symbols or hidden fields' }]);
    }
    result[key] = plainData(property.value, captureAuthority, [...path, key], budget, captureCoordinator);
  }
  return result;
}

export function parseDockerConfig(input: unknown): DockerLegacySandboxConfig {
  let egressAuthority: DockerRouteAuthorityBinding | undefined;
  const captured = plainData(input, (authority) => {
    egressAuthority = captureDockerRouteAuthority(authority);
    return egressAuthority.identity;
  });
  return parseCapturedDockerConfig(captured, egressAuthority);
}

function parseCapturedDockerConfig(captured: unknown, egressAuthority: DockerRouteAuthorityBinding | undefined): DockerLegacySandboxConfig {
  const configSchema = configurationSchema(egressAuthority?.identity);
  const result = configSchema.safeParse(captured);
  if (!result.success) throw new SandboxValidationError(normalizeZodValidationError(configSchema, result.error, captured));
  const { egress, filesystem, ...configuration } = result.data;
  const base = { ...configuration, spillDirectory: parseSandboxSpillDirectory(configuration.spillDirectory),
    user: Object.freeze(configuration.user), datasets: normalizeDatasets(configuration.datasets),
    filesystem: filesystem === undefined ? undefined : Object.freeze({ ...filesystem, user: Object.freeze(filesystem.user),
      resources: Object.freeze(filesystem.resources), control: Object.freeze(filesystem.control) }) };
  if (egress === undefined) return Object.freeze({ ...base, egress: undefined, egressAuthority: undefined });
  if (egressAuthority === undefined) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: ['egress', 'routeAuthority'], message: 'Egress authority was not captured at the configuration boundary' }]);
  }
  return Object.freeze({ ...base, egress: Object.freeze({ ...egress, user: Object.freeze(egress.user),
      broker: Object.freeze({ ...egress.broker, resources: Object.freeze(egress.broker.resources) }),
      relay: Object.freeze({ ...egress.relay, resources: Object.freeze(egress.relay.resources) }), control: Object.freeze(egress.control) }),
    egressAuthority,
  });
}

export function parseCoordinatedDockerConfig(input: unknown): DockerCoordinatedSandboxConfig {
  let egressAuthority: DockerRouteAuthorityBinding | undefined;
  let coordinator: DesktopCoordinatorBinding | undefined;
  const captured = plainData(input, (authority) => {
    egressAuthority = captureDockerRouteAuthority(authority);
    return egressAuthority.identity;
  }, [], { nodes: 1024 }, (authority) => {
    coordinator = captureDesktopCoordinatorAuthority(authority);
  });
  if (coordinator === undefined || captured === null || typeof captured !== 'object' || !('coordinator' in captured)) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: ['coordinator'],
      message: 'Coordinated Desktop configuration requires an original active coordinator capability' }]);
  }
  const { coordinator: _coordinator, ...memberConfiguration } = captured;
  const config = parseCapturedDockerConfig(memberConfiguration, egressAuthority);
  return Object.freeze({ ...bindCoordinatedConfig(config, coordinator), coordinator });
}

export function parseCoordinatedDockerCleanupConfig(input: unknown,
  binding: Pick<DesktopCoordinatorBinding, 'endpoint' | 'configurationDigest' | 'identity'>): DockerCoordinatedCleanupConfig {
  return bindCoordinatedConfig(parseDockerConfig(input), binding);
}

function bindCoordinatedConfig(config: DockerLegacySandboxConfig,
  coordinator: Pick<DesktopCoordinatorBinding, 'endpoint' | 'configurationDigest' | 'identity'>): DockerCoordinatedCleanupConfig {
  if (config.profile === 'linux-x64' || config.egress === undefined || config.egressAuthority?.kind !== 'local_docker_desktop') {
    throw new SandboxValidationError([{ code: 'invalid_input', path: ['profile'],
      message: 'Coordinated Docker configuration requires an explicit Desktop profile and prepared Desktop restricted egress' }]);
  }
  if (config.endpoint !== coordinator.endpoint
    || desktopSharedAuthorityDigest(config.egressAuthority.identity) !== coordinator.configurationDigest) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: ['coordinator'],
      message: 'Member route authority must match the original coordinator endpoint and shared Desktop preparation' }]);
  }
  const controls = [config.egress.control, ...(config.filesystem === undefined ? [] : [config.filesystem.control])];
  if (controls.some((control) => control.heartbeatMs !== DESKTOP_COORDINATOR_POLICY.heartbeatMs
    || control.leaseTimeoutMs !== DESKTOP_COORDINATOR_POLICY.leaseTimeoutMs)) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: ['egress', 'control'],
      message: 'Coordinated Desktop members require the fixed helper control timing composition' }]);
  }
  const coordination = Object.freeze({ ...coordinator.identity, generation: Object.freeze({ ...coordinator.identity.generation }) });
  return Object.freeze({ ...config, profile: config.profile, egressAuthority: config.egressAuthority,
    egress: Object.freeze({ ...config.egress, routeAuthority: config.egressAuthority.identity }),
    coordination });
}

export const DOCKER_BACKEND_ID = 'agenai-docker';
export const DOCKER_API = '/v1.52';
