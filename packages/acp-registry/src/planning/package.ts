import type { AcpRegistryPackageDistribution } from '../catalog/contracts.js';
import { invalidRegistry } from '../shared/errors.js';
import { exactKeys, inputDigest, inputRecord, inputString } from '../selection/input.js';
import type { AcpInstallPolicy, AcpPackageResolution, AcpPackageResolutionEvidence, AcpToolchainIdentity } from './contracts.js';
import { artifactUrl } from './policy.js';
import { dependencyLock } from './lock.js';
import { exactPackageVersion, isExactPackageVersion, packageName } from './specifier.js';

export function resolutionEvidence(value: unknown, path: readonly (string | number)[]): AcpPackageResolutionEvidence {
  const evidence = inputRecord(value, path);
  exactKeys(evidence, ['kind', 'digest'], path);
  if (!['registry-metadata', 'artifact-inspection'].includes(evidence.kind as string)) invalidRegistry('acp_registry_package_resolution_invalid', path, 'Resolution evidence must identify exact metadata or artifact bytes.');
  return { kind: evidence.kind as AcpPackageResolutionEvidence['kind'], digest: inputDigest(evidence.digest, [...path, 'digest']) };
}

function catalogPackage(specifier: string, kind: 'npx' | 'uvx'): { name: string; version?: string } {
  if (kind === 'uvx') {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(.*)$/.exec(specifier)!;
    const name = match[1]!.toLowerCase().replace(/[-._]+/g, '-');
    packageName(name, kind, ['distribution', 'package']);
    const selector = match[2]!;
    if ((selector && !selector.startsWith('==') && !selector.startsWith('@')) || selector.includes('*')) {
      invalidRegistry('acp_registry_package_selector_unsupported', ['distribution', 'package'], 'Version ranges remain searchable metadata; this planner does not qualify Python range resolution.');
    }
    return { name, ...(selector.startsWith('==') ? { version: selector.slice(2) } : selector.startsWith('@') ? { version: selector.slice(1) } : {}) };
  }
  const index = specifier.lastIndexOf('@');
  const hasVersion = index > 0;
  const name = hasVersion ? specifier.slice(0, index) : specifier;
  packageName(name, kind, ['distribution', 'package']);
  const version = hasVersion ? specifier.slice(index + 1) : undefined;
  if (version !== undefined && (/^[~^*]/.test(version) || /^\d+(?:\.(?:\d+|[xX*]))?$/.test(version) || /^\d+\.\d+\.[xX*]$/.test(version))) {
    invalidRegistry('acp_registry_package_selector_unsupported', ['distribution', 'package'], 'Version ranges remain searchable metadata; this planner does not qualify npm range resolution.');
  }
  return { name, ...(version === undefined ? {} : { version }) };
}

export function packageResolution(distribution: AcpRegistryPackageDistribution, value: unknown, policy: AcpInstallPolicy): AcpPackageResolution {
  const catalog = catalogPackage(distribution.package, distribution.kind);
  if (value === undefined) invalidRegistry('acp_registry_package_resolution_required', ['packageResolution'], 'Package distributions require explicit exact package and executable resolution.');
  const resolution = inputRecord(value, ['packageResolution']);
  exactKeys(resolution, ['kind', 'name', 'version', 'command', 'evidence', 'artifact', 'dependencyLock'], ['packageResolution']);
  if (resolution.kind !== distribution.kind) invalidRegistry('acp_registry_package_resolution_invalid', ['packageResolution', 'kind'], 'Resolution kind does not match the selected distribution.');
  const name = packageName(resolution.name, distribution.kind, ['packageResolution', 'name']);
  const version = exactPackageVersion(resolution.version, distribution.kind, ['packageResolution', 'version']);
  const command = inputString(resolution.command, ['packageResolution', 'command'], 214);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(command) || /\.(?:cmd|bat)$/i.test(command)) invalidRegistry('acp_registry_launch_unsupported', ['packageResolution', 'command'], 'Select one package-owned executable name without shell or path syntax.');
  if (catalog.name !== name) invalidRegistry('acp_registry_package_resolution_invalid', ['packageResolution', 'name'], 'Resolution names another package.');
  const exactCatalogVersion = catalog.version !== undefined && isExactPackageVersion(catalog.version, distribution.kind) ? catalog.version : undefined;
  if (exactCatalogVersion !== undefined && exactCatalogVersion !== version) invalidRegistry('acp_registry_package_resolution_invalid', ['packageResolution', 'version'], 'Resolution conflicts with the exact catalog package version.');
  const evidence = resolution.evidence === undefined ? undefined : resolutionEvidence(resolution.evidence, ['packageResolution', 'evidence']);
  if (exactCatalogVersion === undefined && !evidence) invalidRegistry('acp_registry_package_resolution_required', ['packageResolution', 'evidence'], 'Unversioned packages, tags, and ranges require caller-supplied exact resolution evidence.');
  let artifact: AcpPackageResolution['artifact'];
  if (resolution.artifact !== undefined) {
    const input = inputRecord(resolution.artifact, ['packageResolution', 'artifact']);
    exactKeys(input, ['url', 'sha256'], ['packageResolution', 'artifact']);
    artifact = { url: artifactUrl(input.url, ['packageResolution', 'artifact', 'url'], policy), sha256: inputDigest(input.sha256, ['packageResolution', 'artifact', 'sha256']) };
  }
  const lock = resolution.dependencyLock === undefined ? undefined : dependencyLock(resolution.dependencyLock, { kind: distribution.kind, name, version, policy });
  if (artifact && lock && lock.packages.find((item) => item.name === name && item.version === version)?.sha256 !== artifact.sha256) {
    invalidRegistry('acp_registry_package_lock_invalid', ['packageResolution', 'artifact', 'sha256'], 'Top-level artifact and lock integrity disagree.');
  }
  return { kind: distribution.kind, name, version, command, ...(evidence ? { evidence } : {}), ...(artifact ? { artifact } : {}), ...(lock ? { dependencyLock: lock } : {}) };
}

export function toolchainIdentities(value: unknown, kind: 'binary' | 'npx' | 'uvx'): readonly AcpToolchainIdentity[] {
  if (value === undefined) value = [];
  if (!Array.isArray(value) || value.length > 2) invalidRegistry('acp_registry_toolchain_required', ['toolchains'], 'Explicit exact runtime and installer toolchain identities are required.');
  const identities = value.map((item, index) => {
    const input = inputRecord(item, ['toolchains', index]);
    exactKeys(input, ['kind', 'version', 'sha256'], ['toolchains', index]);
    if (!['node', 'npm', 'python', 'uv'].includes(input.kind as string)) invalidRegistry('acp_registry_toolchain_required', ['toolchains', index], 'Unsupported toolchain kind.');
    const version = exactPackageVersion(input.version, 'npx', ['toolchains', index, 'version']);
    if (input.kind === 'node' && Number(version.split('.')[0]) < 22) invalidRegistry('acp_registry_toolchain_required', ['toolchains', index], 'Node toolchains require version 22 or newer.');
    return { kind: input.kind as AcpToolchainIdentity['kind'], version, sha256: inputDigest(input.sha256, ['toolchains', index, 'sha256']) };
  }).sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
  const required = kind === 'binary' ? [] : kind === 'npx' ? ['node', 'npm'] : ['python', 'uv'];
  if (identities.length !== required.length || identities.some((item) => !required.includes(item.kind)) || new Set(identities.map((item) => item.kind)).size !== identities.length) {
    invalidRegistry('acp_registry_toolchain_required', ['toolchains'], 'Toolchain identities must exactly match the selected distribution runtime and installer.');
  }
  return identities;
}
