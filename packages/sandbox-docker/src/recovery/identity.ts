// ------------------------------------------------------------------------------------------------
//                identity.ts - Original record binding and immutable resource fingerprints
// ------------------------------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto';
import { parseSandboxId, parseSandboxNamespace, parseSandboxRecoveryRecord, SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord, SandboxRecoveryResource, SandboxRequest } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../policy/config.js';
import { DOCKER_BACKEND_ID } from '../policy/config.js';
import { dockerBackendRevision } from '../policy/profiles.js';

export type ResourceRole = SandboxRecoveryResource['role'];

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function resourceName(namespace: string, operationId: string, role: ResourceRole): string {
  return `agenai-sbx-${createHash('sha256').update(`${namespace}\0${operationId}`).digest('hex').slice(0, 32)}-${role}`;
}

export function desktopBridgeName(record: SandboxRecoveryRecord): string {
  return `ag${createHash('sha256').update(`${record.namespace}\0${record.operationId}`).digest('hex').slice(0, 13)}`;
}

export function configurationDigest(config: DockerSandboxConfig): string {
  return digest({ profile: config.profile, endpoint: config.endpoint, user: config.user,
    imageDigest: config.imageDigest, datasets: config.datasets, egress: config.egress, filesystem: config.filesystem });
}

export function newRecoveryRecord(config: DockerSandboxConfig, request: SandboxRequest): SandboxRecoveryRecord {
  const operationId = randomUUID();
  const roles: ResourceRole[] = ['compute', 'storage', 'export'];
  if (request.policy.network.kind !== 'isolated') roles.push('network');
  if (request.policy.network.kind === 'restricted_https') roles.push('egress_socket', 'egress_broker', 'egress_relay');
  if (request.policy.files.kind !== 'disabled') roles.push('filesystem');
  if (request.policy.network.kind === 'restricted_https' && config.profile !== 'linux-x64') roles.push('route_observer');
  return parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: DOCKER_BACKEND_ID, backendRevision: dockerBackendRevision(config.profile),
    namespace: parseSandboxNamespace(config.namespace), operationId, sandboxId: parseSandboxId(`docker-${operationId}`),
    imageDigest: config.imageDigest, configurationDigest: configurationDigest(config), policyDigest: digest(request.policy),
    phase: 'reserved', authority: { kind: 'unverified' },
    resources: roles.map((role) => ({ role, name: resourceName(config.namespace, operationId, role), identity: { kind: 'planned' } })),
  });
}

function recordBinding(record: SandboxRecoveryRecord): string {
  return digest({ format: record.format, backendId: record.backendId, backendRevision: record.backendRevision,
    namespace: record.namespace, operationId: record.operationId, sandboxId: record.sandboxId,
    imageDigest: record.imageDigest, configurationDigest: record.configurationDigest, policyDigest: record.policyDigest,
    resources: record.resources.map(({ role, name }) => ({ role, name })) });
}

export function resourceLabels(record: SandboxRecoveryRecord, role: ResourceRole): Readonly<Record<string, string>> {
  return Object.freeze({ 'ai.agen.sandbox.record': recordBinding(record), 'ai.agen.sandbox.role': role,
    'ai.agen.sandbox.namespace': record.namespace, 'ai.agen.sandbox.operation': record.operationId,
    'ai.agen.sandbox.backend': record.backendId, 'ai.agen.sandbox.revision': record.backendRevision,
    'ai.agen.sandbox.image': record.imageDigest, 'ai.agen.sandbox.configuration': record.configurationDigest, 'ai.agen.sandbox.policy': record.policyDigest });
}

export function assertLabels(actual: Readonly<Record<string, string>>, record: SandboxRecoveryRecord, role: ResourceRole): void {
  const expected = resourceLabels(record, role);
  if (Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new SandboxStateError('Docker resource labels do not bind the original reserved ownership record.');
  }
}

export function validateRecord(record: SandboxRecoveryRecord, config: DockerSandboxConfig): boolean {
  const roles = record.resources.filter((resource) => resource.role !== 'filesystem').map((resource) => resource.role);
  const filesystem = record.resources.some((resource) => resource.role === 'filesystem');
  const exactRoles = (...expected: ResourceRole[]) => roles.length === expected.length && expected.every((role) => roles.includes(role));
  const topology = exactRoles('compute', 'storage', 'export') || exactRoles('compute', 'storage', 'export', 'network')
    || config.egress !== undefined && exactRoles('compute', 'storage', 'export', 'network', 'egress_socket', 'egress_broker', 'egress_relay',
      ...(config.profile === 'linux-x64' ? [] : ['route_observer'] satisfies ResourceRole[]));
  return record.format === 'agenai.sandbox-recovery.v3' && record.backendId === DOCKER_BACKEND_ID && record.backendRevision === dockerBackendRevision(config.profile)
    && record.namespace === config.namespace && record.imageDigest === config.imageDigest
    && record.configurationDigest === configurationDigest(config)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(record.operationId)
    && record.sandboxId === `docker-${record.operationId}`
    && topology
    && (!filesystem || config.filesystem !== undefined)
    && record.resources.every((resource) => resource.name === resourceName(config.namespace, record.operationId, resource.role));
}
