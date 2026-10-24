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

export function configurationDigest(config: DockerSandboxConfig): string {
  return digest({ profile: config.profile, user: config.user, imageDigest: config.imageDigest, datasets: config.datasets });
}

export function newRecoveryRecord(config: DockerSandboxConfig, request: SandboxRequest): SandboxRecoveryRecord {
  const operationId = randomUUID();
  const roles: ResourceRole[] = ['compute', 'storage', 'export'];
  if (request.policy.network.kind === 'outbound') roles.push('network');
  return parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v2', backendId: DOCKER_BACKEND_ID, backendRevision: dockerBackendRevision(config.profile),
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
  const roles = record.resources.map((resource) => resource.role);
  return record.backendId === DOCKER_BACKEND_ID && record.backendRevision === dockerBackendRevision(config.profile)
    && record.namespace === config.namespace && record.imageDigest === config.imageDigest
    && record.configurationDigest === configurationDigest(config)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(record.operationId)
    && record.sandboxId === `docker-${record.operationId}`
    && roles.length >= 3 && roles.length <= 4 && ['compute', 'storage', 'export'].every((role) => roles.includes(role as ResourceRole))
    && record.resources.every((resource) => resource.name === resourceName(config.namespace, record.operationId, resource.role));
}
