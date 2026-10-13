import { resolveAcpBinaryArchiveFormat, type AcpBinaryArchiveFormat } from './binary.js';
import { canonicalDigest } from '../shared/digest.js';
import { invalidRegistry } from '../shared/errors.js';
import { deepFreeze } from '../shared/immutable.js';
import { exactKeys, inputDigest, inputRecord, plainInput, type InputRecord } from '../selection/input.js';
import type { AcpInstallPlan } from './contracts.js';
import { packageResolution, resolutionEvidence, toolchainIdentities } from './package.js';
import { artifactUrl, installPolicy, validateLaunchEnvironment } from './policy.js';

type PlanSelection = Pick<AcpInstallPlan, 'source' | 'sourceIdentity' | 'snapshotDigest' | 'rawSnapshotDigest' | 'entry' | 'target' | 'distributionPreference' | 'distribution'>;

export function deriveAcpInstallPlan(selection: PlanSelection, options: InputRecord): AcpInstallPlan {
  const { entry, target, distribution, distributionPreference: preference } = selection;
  const policy = installPolicy(options.policy);
  validateLaunchEnvironment(distribution, policy);
  const toolchains = toolchainIdentities(options.toolchains, distribution.kind);
  let expectedIntegrity: AcpInstallPlan['expectedIntegrity'] = { source: 'none' };
  let resolution: AcpInstallPlan['packageResolution'];
  let executable: string;
  let binaryFormat: AcpBinaryArchiveFormat | undefined;
  if (distribution.kind === 'binary') {
    binaryFormat = resolveAcpBinaryArchiveFormat(distribution.archive, options.binaryFormat);
    if (options.packageResolution !== undefined) invalidRegistry('acp_registry_package_resolution_invalid', ['packageResolution'], 'Package resolution is not applicable to a binary distribution.');
    artifactUrl(distribution.archive, ['distribution', 'archive'], policy);
    executable = distribution.executable;
    const catalogDigest = distribution.sha256 === undefined ? undefined : `sha256:${distribution.sha256}`;
    if (catalogDigest) expectedIntegrity = { source: 'catalog', sha256: catalogDigest };
    if (options.binaryIntegrity !== undefined) {
      const supplied = inputRecord(options.binaryIntegrity, ['binaryIntegrity']);
      exactKeys(supplied, ['sha256', 'evidence'], ['binaryIntegrity']);
      const sha256 = inputDigest(supplied.sha256, ['binaryIntegrity', 'sha256']);
      const evidence = resolutionEvidence(supplied.evidence, ['binaryIntegrity', 'evidence']);
      if (catalogDigest && catalogDigest !== sha256) invalidRegistry('acp_registry_integrity_conflict', ['binaryIntegrity', 'sha256'], 'Caller integrity conflicts with the selected catalog artifact.');
      expectedIntegrity = { source: catalogDigest ? 'catalog' : 'caller', sha256, evidence };
    }
  } else {
    if (options.binaryFormat !== undefined) invalidRegistry('acp_registry_binary_format_unsupported', ['binaryFormat'], 'An archive format is only applicable to binary distributions.');
    if (options.binaryIntegrity !== undefined) invalidRegistry('acp_registry_integrity_conflict', ['binaryIntegrity'], 'Binary integrity cannot authorize a package distribution.');
    resolution = packageResolution(distribution, options.packageResolution, policy);
    executable = resolution.command;
    const sha256 = resolution.artifact?.sha256 ?? resolution.dependencyLock?.packages.find((item) => item.name === resolution!.name && item.version === resolution!.version)?.sha256;
    if (sha256) expectedIntegrity = { source: 'package-resolution', sha256 };
  }
  const gaps: AcpInstallPlan['reproducibility']['gaps'][number][] = [];
  if (!expectedIntegrity.sha256) gaps.push('expected-sha256-missing');
  if (distribution.kind !== 'binary' && !resolution?.dependencyLock) gaps.push('dependency-closure-missing');
  if (distribution.kind !== 'binary' && policy.packageScripts === 'allow') gaps.push('package-scripts-enabled');
  if (!expectedIntegrity.sha256 && policy.integrity === 'require-expected-sha256') invalidRegistry('acp_registry_integrity_required', ['policy', 'integrity'], 'This plan requires expected artifact bytes before installation; a later measured hash is insufficient.');
  if (policy.reproducibility === 'require-complete' && gaps.length) invalidRegistry('acp_registry_reproducibility_incomplete', ['policy', 'reproducibility'], 'Strict reproducibility requires expected artifact bytes, declared locked dependencies, and disabled package scripts.');
  const value: Omit<AcpInstallPlan, 'digest'> = {
    format: 'acp-registry-install-plan-v1', mappingProfile: 'acp-registry-install-v1',
    ...selection,
    entry: { identity: entry.identity, digest: entry.digest, id: entry.id, version: entry.version },
    target, distributionPreference: preference, distribution, ...(binaryFormat ? { binaryFormat } : {}),
    launch: { kind: distribution.kind === 'binary' ? 'binary' : 'package-bin', executable, args: distribution.args, env: distribution.env, shell: false },
    policy, toolchains, ...(resolution ? { packageResolution: resolution } : {}), expectedIntegrity,
    verificationObligations: distribution.kind === 'binary' ? ['payload-integrity'] : ['payload-integrity', 'toolchain-identity', 'package-command', 'dependency-closure', 'lock-artifact-integrity'],
    reproducibility: { classification: gaps.length ? 'incomplete' : distribution.kind === 'binary' ? 'pinned-binary' : 'locked-package-inputs', gaps, verified: false },
  };
  const detached = plainInput(value) as unknown as Omit<AcpInstallPlan, 'digest'>;
  return deepFreeze({ ...detached, digest: canonicalDigest(detached) });
}
