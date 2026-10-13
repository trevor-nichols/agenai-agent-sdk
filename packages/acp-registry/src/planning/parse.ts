import { z } from 'zod/v4';
import { acpRegistrySchemas } from '../catalog/schemas.js';
import { resolveAcpRegistryLimits } from '../catalog/limits.js';
import { acpRegistrySourceIdentity, normalizeRegistryUrl, parseAcpRegistrySource } from '../catalog/source.js';
import { normalizeRegistryExecutable, validateRegistryPackage } from '../catalog/launch.js';
import { canonicalDigest } from '../shared/digest.js';
import { invalidRegistry, registrySchemaError } from '../shared/errors.js';
import { distributionPreference, registryTarget, validateDistributionTarget } from '../selection/distribution.js';
import { exactKeys, inputDigest, inputRecord, plainInput } from '../selection/input.js';
import type { AcpInstallPlan } from './contracts.js';
import { deriveAcpInstallPlan } from './derive.js';

const entrySchema = z.strictObject({ identity: z.string().max(512), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  id: z.string().max(128).regex(/^[a-z][a-z0-9-]*$/u), version: z.string().max(128).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-preview\.[0-9]+)?$/u) });

/** Revalidate retained plan semantics against a separately retained caller pin; this does not authenticate a publisher. */
export function parseAcpInstallPlan(input: unknown, expectedDigest: string): AcpInstallPlan {
  const value = inputRecord(plainInput(input), []);
  exactKeys(value, ['format', 'mappingProfile', 'digest', 'source', 'sourceIdentity', 'snapshotDigest', 'rawSnapshotDigest',
    'entry', 'target', 'distributionPreference', 'binaryFormat', 'distribution', 'launch', 'policy', 'toolchains',
    'packageResolution', 'expectedIntegrity', 'verificationObligations', 'reproducibility'], []);
  const digest = inputDigest(value.digest, ['digest']);
  if (digest !== inputDigest(expectedDigest, ['expectedDigest'])) invalidRegistry('acp_registry_plan_stale', ['digest'], 'The retained plan differs from the caller-pinned digest.');
  const source = parseAcpRegistrySource(value.source);
  const sourceIdentity = acpRegistrySourceIdentity(source);
  const parsedEntry = entrySchema.safeParse(value.entry);
  if (!parsedEntry.success) registrySchemaError(parsedEntry.error, value.entry);
  const entry = parsedEntry.data;
  if (value.sourceIdentity !== sourceIdentity || entry.identity !== `${sourceIdentity}/${entry.id}`
    || (source.channel === 'stable' && entry.version.includes('-preview.'))) {
    invalidRegistry('acp_registry_plan_input_invalid', ['entry'], 'Retained source and entry identities must agree.');
  }
  const parsedDistribution = acpRegistrySchemas(resolveAcpRegistryLimits()).normalizedDistribution.safeParse(value.distribution);
  if (!parsedDistribution.success) registrySchemaError(parsedDistribution.error, value.distribution);
  const distribution = parsedDistribution.data;
  const target = registryTarget(value.target);
  const preference = distributionPreference(value.distributionPreference);
  if (!preference.includes(distribution.kind) || (distribution.kind === 'binary' && distribution.target !== target)) {
    invalidRegistry('acp_registry_plan_input_invalid', ['distribution'], 'Retained distribution must match the target and permitted kinds.');
  }
  validateDistributionTarget(distribution, target);
  if (distribution.kind === 'binary') {
    distribution.archive = normalizeRegistryUrl(distribution.archive, ['distribution', 'archive']);
    distribution.executable = normalizeRegistryExecutable(distribution.executable);
    const keys = Object.keys(distribution.env);
    if (target.startsWith('windows-') && new Set(keys.map((key) => key.toUpperCase())).size !== keys.length) invalidRegistry('invalid_environment', ['distribution', 'env'], 'Windows environment keys collide.');
  } else validateRegistryPackage(distribution.package, distribution.kind);
  const integrity = inputRecord(value.expectedIntegrity, ['expectedIntegrity']);
  exactKeys(integrity, ['source', 'sha256', 'evidence'], ['expectedIntegrity']);
  const options = { policy: value.policy, toolchains: value.toolchains, ...(value.binaryFormat === undefined ? {} : { binaryFormat: value.binaryFormat }),
    ...(value.packageResolution === undefined ? {} : { packageResolution: value.packageResolution }),
    ...(integrity.evidence === undefined ? {} : { binaryIntegrity: { sha256: integrity.sha256, evidence: integrity.evidence } }) };
  const derived = deriveAcpInstallPlan({ source, sourceIdentity, entry, distribution, target, distributionPreference: preference,
    snapshotDigest: inputDigest(value.snapshotDigest, ['snapshotDigest']), rawSnapshotDigest: inputDigest(value.rawSnapshotDigest, ['rawSnapshotDigest']) }, options);
  if (derived.digest !== digest || canonicalDigest(derived) !== canonicalDigest(value)) {
    invalidRegistry('acp_registry_plan_input_invalid', [], 'Retained plan bytes and derived installation semantics do not agree.');
  }
  return derived;
}
