import { z } from 'zod/v4';
import path from 'node:path';
import type { AcpInstallPlan } from '../../../planning/contracts.js';
import { parseAcpInstallPlan } from '../../../planning/parse.js';
import { canonicalDigest, sha256Digest } from '../../../shared/digest.js';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import { deepFreeze } from '../../../shared/immutable.js';
import type { AcpInstallationLimits, AcpInstallationReceipt, AcpPreparedInstallation } from '../contracts.js';
import { storeFailure, validateStoreRecord } from './errors.js';
import { containedPayloadPath, createInstalledPayloadResolver, type InstalledPayload } from './payload.js';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

function receiptSchemas(limits: AcpInstallationLimits) {
  const text = z.string().max(limits.maxReceiptBytes).refine((value) => !value.includes('\0'));
  const relative = text.min(1).refine((value) => {
    try { return containedPayloadPath(value) === value && Buffer.byteLength(value, 'utf8') <= limits.maxPathBytes && value.split('/').length <= limits.maxPathDepth; } catch { return false; }
  });
  const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const mode = z.number().int().min(0).max(0o777);
  const toolchain = z.strictObject({ kind: z.enum(['node', 'npm', 'python', 'uv']), version: text.min(1), sha256: digestSchema,
    path: text.min(1).refine((value) => path.isAbsolute(value) && path.resolve(value) === value) });
  const launch = z.strictObject({ command: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('payload'), path: relative }),
    z.strictObject({ kind: z.literal('toolchain'), toolchain: z.enum(['node', 'python']) }),
  ]), args: z.array(z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('literal'), value: text }),
    z.strictObject({ kind: z.literal('payload-path'), path: relative })])).max(1_024), env: z.record(z.string().max(128), text), shell: z.literal(false) });
  const prepared = z.strictObject({ launch,
    artifacts: z.array(z.strictObject({ sourceUrl: text.optional(), finalUrl: text.optional(), origin: z.enum(['local', 'network']),
      measuredSha256: digestSchema, expectedSha256: digestSchema.optional(), sizeBytes: count.max(limits.maxArtifactBytes) })).min(1).max(limits.maxEntries),
    toolchains: z.array(toolchain).max(4),
    packages: z.array(z.strictObject({ name: text.min(1), version: text.min(1), dependencies: z.array(text.min(1)).max(limits.maxEntries) })).max(limits.maxEntries),
    resolvedLock: z.strictObject({ format: z.enum(['npm-package-lock-v3', 'python-requirements-hashes']), content: text, digest: digestSchema }).optional(),
    verification: z.strictObject({ expectedArtifactIntegrity: z.enum(['verified', 'not-provided']), dependencyClosure: z.enum(['verified', 'not-applicable']),
      packageCommand: z.enum(['verified', 'not-applicable']), toolchains: z.enum(['verified', 'not-applicable']),
      reproducibility: z.enum(['pinned-binary', 'locked-package-inputs', 'incomplete']), gaps: z.array(text.min(1)).max(128) }),
  });
  const payload = z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('directory'), path: relative, mode }),
    z.strictObject({ kind: z.literal('file'), path: relative, mode, sizeBytes: count.max(limits.maxPayloadBytes), sha256: digestSchema }),
    z.strictObject({ kind: z.literal('symlink'), path: relative, target: text.min(1).max(limits.maxPathBytes) }),
  ])).max(limits.maxEntries);
  const receipt = z.strictObject({ format: z.literal('acp-registry-installation-v1'), installationId: digestSchema, receiptDigest: digestSchema,
    plan: z.unknown(), payloadDigest: digestSchema, payload, prepared,
    installedAt: z.string().datetime(), publication: z.enum(['synced-rename', 'atomic-rename']) });
  return { receipt, prepared };
}

function installationIdentity(plan: AcpInstallPlan, payloadDigest: string, prepared: AcpPreparedInstallation): string {
  const portablePrepared = { ...prepared, toolchains: prepared.toolchains.map(({ kind, version, sha256 }) => ({ kind, version, sha256 })) };
  return canonicalDigest({ format: 'acp-registry-installation-v1', mappingProfile: plan.mappingProfile, planDigest: plan.digest, payloadDigest, prepared: portablePrepared });
}

export function validatePreparedInstallation(input: unknown, plan: AcpInstallPlan, payload: InstalledPayload, limits: AcpInstallationLimits): AcpPreparedInstallation {
  const parsed = receiptSchemas(limits).prepared.safeParse(input);
  if (!parsed.success) storeFailure('installation_mismatch', 'Prepared installation evidence is malformed.');
  const prepared = parsed.data;
  if (canonicalDigest(prepared.launch.env) !== canonicalDigest(plan.launch.env)) storeFailure('installation_mismatch', 'Installed launch environment differs from its immutable plan.');
  const literalArguments = plan.launch.args.map((value) => ({ kind: 'literal', value }));
  if (plan.distribution.kind === 'binary') {
    if (canonicalDigest(prepared.launch) !== canonicalDigest({ command: { kind: 'payload', path: plan.launch.executable }, args: literalArguments, env: plan.launch.env, shell: false })
      || prepared.packages.length > 0 || prepared.resolvedLock !== undefined) storeFailure('installation_mismatch', 'Binary installation facts differ from the exact planned launch.');
  } else {
    const command = plan.distribution.kind === 'npx' ? 'node' : 'python';
    const lockFormat = plan.distribution.kind === 'npx' ? 'npm-package-lock-v3' : 'python-requirements-hashes';
    const suffix = literalArguments.length ? prepared.launch.args.slice(-literalArguments.length) : [];
    if (prepared.launch.command.kind !== 'toolchain' || prepared.launch.command.toolchain !== command
      || canonicalDigest(suffix) !== canonicalDigest(literalArguments) || prepared.resolvedLock?.format !== lockFormat
      || !prepared.packages.some((item) => item.name === plan.packageResolution?.name && item.version === plan.packageResolution.version)) {
      storeFailure('installation_mismatch', 'Package installation facts differ from the selected command and package identity.');
    }
  }
  if (prepared.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > limits.maxTotalArtifactBytes) storeFailure('limit_exceeded', 'Retained artifact evidence exceeds its total byte limit.');
  const allExpected = prepared.artifacts.every((artifact) => artifact.expectedSha256 !== undefined);
  if (prepared.verification.expectedArtifactIntegrity !== (allExpected ? 'verified' : 'not-provided')
    || prepared.verification.reproducibility !== plan.reproducibility.classification
    || canonicalDigest(prepared.verification.gaps) !== canonicalDigest(plan.reproducibility.gaps)
    || prepared.verification.dependencyClosure !== (plan.distribution.kind === 'binary' ? 'not-applicable' : 'verified')
    || prepared.verification.packageCommand !== (plan.distribution.kind === 'binary' ? 'not-applicable' : 'verified')
    || prepared.verification.toolchains !== (plan.distribution.kind === 'binary' ? 'not-applicable' : 'verified')) {
    storeFailure('installation_mismatch', 'Installation verification claims contradict their retained plan and evidence.');
  }
  for (const artifact of prepared.artifacts) {
    if (artifact.expectedSha256 && artifact.expectedSha256 !== artifact.measuredSha256) storeFailure('integrity_mismatch', 'Measured artifact integrity differs from its expected value.');
  }
  if (plan.expectedIntegrity.sha256 && !prepared.artifacts.some((artifact) => artifact.measuredSha256 === plan.expectedIntegrity.sha256 && artifact.expectedSha256 === plan.expectedIntegrity.sha256)) {
    storeFailure('integrity_mismatch', 'The prepared installation does not prove the plan-expected artifact integrity.');
  }
  if (prepared.resolvedLock && sha256Digest(prepared.resolvedLock.content) !== prepared.resolvedLock.digest) storeFailure('installation_mismatch', 'Resolved lock bytes do not match their recorded digest.');
  const observedToolchains = prepared.toolchains.map(({ kind, version, sha256 }) => ({ kind, version, sha256 })).sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
  const plannedToolchains = [...plan.toolchains].sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
  if (canonicalDigest(observedToolchains) !== canonicalDigest(plannedToolchains)) storeFailure('toolchain_mismatch', 'Installed toolchain identities differ from their immutable plan.');
  const payloadPaths = prepared.launch.args.filter((argument) => argument.kind === 'payload-path').map((argument) => argument.path);
  if (prepared.launch.command.kind === 'payload') payloadPaths.push(prepared.launch.command.path);
  else {
    const commandToolchain = prepared.launch.command.toolchain;
    if (!prepared.toolchains.some((toolchain) => toolchain.kind === commandToolchain)) storeFailure('toolchain_mismatch', 'The installed launch toolchain is absent.');
  }
  const resolvePayload = createInstalledPayloadResolver(payload.entries, limits.maxPathDepth);
  for (const relative of payloadPaths) {
    const entry = resolvePayload(relative);
    if (entry?.kind !== 'file') storeFailure('installation_mismatch', 'An installed launch path is missing or is not a regular payload file.');
    if (process.platform !== 'win32' && prepared.launch.command.kind === 'payload' && relative === prepared.launch.command.path && !(entry.mode & 0o111)) {
      storeFailure('installation_mismatch', 'The installed payload command is not executable.');
    }
  }
  if (plan.policy.reproducibility === 'require-complete' && (prepared.verification.reproducibility === 'incomplete' || prepared.verification.gaps.length > 0)) {
    storeFailure('policy_denied', 'Prepared installation evidence does not satisfy strict reproducibility.');
  }
  return deepFreeze(prepared);
}

export function createInstallationReceipt(plan: AcpInstallPlan, payload: InstalledPayload, prepared: AcpPreparedInstallation, publication: AcpInstallationReceipt['publication']): AcpInstallationReceipt {
  const body = { format: 'acp-registry-installation-v1' as const, installationId: installationIdentity(plan, payload.digest, prepared), plan,
    payloadDigest: payload.digest, payload: payload.entries, prepared, installedAt: new Date().toISOString(), publication };
  return deepFreeze({ ...body, receiptDigest: canonicalDigest(body) });
}

export function parseInstallationReceipt(content: string, limits: AcpInstallationLimits, expectedPlanDigest: string): AcpInstallationReceipt {
  const input = validateStoreRecord('installation_mismatch', () => parseBoundedRegistryJson(content, { maxSnapshotBytes: limits.maxReceiptBytes, maxStringBytes: limits.maxReceiptBytes,
    maxDepth: 64, maxValues: Math.min(1_000_000, limits.maxEntries * 16 + 10_000), maxEntries: limits.maxEntries, maxArgs: 1_024, maxEnvEntries: 1_024 }));
  const parsed = receiptSchemas(limits).receipt.safeParse(input);
  if (!parsed.success) storeFailure('installation_mismatch', 'The retained installation receipt is malformed.');
  const receipt = parsed.data as AcpInstallationReceipt;
  const plan = validateStoreRecord('installation_mismatch', () => parseAcpInstallPlan(receipt.plan, expectedPlanDigest));
  if (canonicalDigest(plan) !== canonicalDigest(receipt.plan)) storeFailure('installation_mismatch', 'The receipt plan is not canonical.');
  const { receiptDigest, ...body } = receipt;
  if (canonicalDigest(body) !== receiptDigest || canonicalDigest(receipt.payload) !== receipt.payloadDigest
    || installationIdentity(plan, receipt.payloadDigest, receipt.prepared) !== receipt.installationId) {
    storeFailure('installation_mismatch', 'The retained receipt or installation identity does not match its complete content.');
  }
  let previous = '';
  let bytes = 0;
  for (const entry of receipt.payload) {
    if (entry.path <= previous) storeFailure('installation_mismatch', 'The retained payload inventory is not unique and canonical.');
    previous = entry.path;
    if (entry.kind === 'file') bytes += entry.sizeBytes;
  }
  if (bytes > limits.maxPayloadBytes) storeFailure('limit_exceeded', 'The retained payload exceeds its byte limit.');
  validatePreparedInstallation(receipt.prepared, plan, { digest: receipt.payloadDigest, bytes, entries: receipt.payload }, limits);
  return deepFreeze(receipt);
}
