import { sha256Digest } from '../shared/digest.js';
import { parseBoundedRegistryJson } from '../shared/bounds.js';
import { validateRegistryPackage } from '../catalog/launch.js';
import { invalidRegistry } from '../shared/errors.js';
import { exactKeys, inputDigest, inputRecord, inputString, PLANNING_INPUT_LIMITS } from '../selection/input.js';
import type { AcpDependencyLock, AcpInstallPolicy, AcpLockedPackage } from './contracts.js';
import { exactPackageVersion, isExactPackageVersion, packageName } from './specifier.js';
import { artifactUrl } from './policy.js';

interface LockContext { readonly kind: 'npx' | 'uvx'; readonly name: string; readonly version: string; readonly policy: AcpInstallPolicy }
const packageId = (item: Pick<AcpLockedPackage, 'name' | 'version'>) => `${item.name}@${item.version}`;

function declaredPackages(value: unknown, context: LockContext): readonly AcpLockedPackage[] {
  if (!Array.isArray(value) || !value.length || value.length > 2_048) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'packages'], 'A bounded declared dependency closure is required.');
  const packages = value.map((item, index) => {
    const entry = inputRecord(item, ['dependencyLock', 'packages', index]);
    exactKeys(entry, ['name', 'version', 'sha256', 'dependencies'], ['dependencyLock', 'packages', index]);
    const name = packageName(entry.name, context.kind, ['dependencyLock', 'packages', index, 'name']);
    const version = exactPackageVersion(entry.version, context.kind, ['dependencyLock', 'packages', index, 'version']);
    if (!Array.isArray(entry.dependencies) || entry.dependencies.length > 2_048) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'packages', index, 'dependencies'], 'Dependency references must be a bounded list.');
    const dependencies = entry.dependencies.map((reference, position) => inputString(reference, ['dependencyLock', 'packages', index, 'dependencies', position], 400)).sort();
    if (new Set(dependencies).size !== dependencies.length) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'packages', index], 'Duplicate dependency references are unsupported.');
    return { name, version, sha256: inputDigest(entry.sha256, ['dependencyLock', 'packages', index, 'sha256']), dependencies };
  }).sort((left, right) => packageId(left) < packageId(right) ? -1 : packageId(left) > packageId(right) ? 1 : 0);
  const byId = new Map(packages.map((item) => [packageId(item), item]));
  if (byId.size !== packages.length) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'packages'], 'Duplicate package identities are unsupported.');
  const root = byId.get(packageId(context));
  if (!root) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'packages'], 'The declared closure must contain the selected exact package.');
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length) {
    const item = pending.pop()!;
    if (visited.has(packageId(item))) continue;
    visited.add(packageId(item));
    for (const reference of item.dependencies) {
      const dependency = byId.get(reference);
      if (!dependency) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'packages'], 'The declared dependency graph contains an unresolved reference.');
      pending.push(dependency);
    }
  }
  if (visited.size !== packages.length) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'packages'], 'Unreachable packages are outside the selected dependency closure.');
  return packages;
}

function packagePathName(path: string): string {
  const match = /^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/)*node_modules\/((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$/.exec(path);
  if (!match) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content'], 'Only contained npm package paths are supported.');
  return match[1]!;
}

function verifyNpmLock(content: string, packages: readonly AcpLockedPackage[], context: LockContext): void {
  const lock = inputRecord(parseBoundedRegistryJson(content, PLANNING_INPUT_LIMITS), ['dependencyLock', 'content']);
  if (lock.lockfileVersion !== 3) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'format'], 'Only npm package-lock version 3 is supported.');
  const locked = inputRecord(lock.packages, ['dependencyLock', 'content', 'packages']);
  const root = inputRecord(locked[''], ['dependencyLock', 'content', 'packages', '']);
  const dependencies = inputRecord(root.dependencies, ['dependencyLock', 'content', 'packages', '', 'dependencies']);
  if (Object.keys(dependencies).length !== 1 || dependencies[context.name] !== context.version) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content'], 'The lock root must depend only on the selected exact package.');
  const expected = new Map(packages.map((item) => [packageId(item), item]));
  const seen = new Set<string>();
  for (const [path, value] of Object.entries(locked)) {
    if (!path) continue;
    const item = inputRecord(value, ['dependencyLock', 'content', 'packages', path]);
    const name = packagePathName(path);
    const version = exactPackageVersion(item.version, 'npx', ['dependencyLock', 'content', 'packages', path, 'version']);
    const id = `${name}@${version}`;
    const declared = expected.get(id);
    if (!declared || item.link || item.inBundle || item.optional || item.dev || item.os || item.cpu || item.libc) {
      invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content', 'packages', path], 'Links, bundled, conditional, dev, or undeclared lock entries are unsupported.');
    }
    artifactUrl(item.resolved, ['dependencyLock', 'content', 'packages', path, 'resolved'], context.policy);
    const integrity = inputString(item.integrity, ['dependencyLock', 'content', 'packages', path, 'integrity'], 512);
    const match = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
    if (!match || Buffer.from(match[2]!, 'base64').length !== Number(match[1]) / 8 || Buffer.from(match[2]!, 'base64').toString('base64') !== match[2]) {
      invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content', 'packages', path, 'integrity'], 'Every locked artifact requires canonical strong integrity.');
    }
    if (match[1] === '256' && `sha256:${Buffer.from(match[2]!, 'base64').toString('hex')}` !== declared.sha256) {
      invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content', 'packages', path, 'integrity'], 'Lock and declared artifact integrity disagree.');
    }
    const nativeDependencies = item.dependencies === undefined ? {} : inputRecord(item.dependencies, ['dependencyLock', 'content', 'packages', path, 'dependencies']);
    const declaredNames = declared.dependencies.map((reference) => expected.get(reference)!.name).sort();
    if (JSON.stringify(Object.keys(nativeDependencies).sort()) !== JSON.stringify(declaredNames)) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content', 'packages', path], 'Lock dependency names disagree with the declared closure.');
    for (const [dependencyName, value] of Object.entries(nativeDependencies)) {
      const requirement = inputString(value, ['dependencyLock', 'content', 'packages', path, 'dependencies', dependencyName], 256);
      validateRegistryPackage(`${dependencyName}@${requirement}`, 'npx');
      const resolved = declared.dependencies.map((reference) => expected.get(reference)!).find((dependency) => dependency.name === dependencyName)!;
      if (isExactPackageVersion(requirement, 'npx') && requirement !== resolved.version) {
        invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content', 'packages', path, 'dependencies', dependencyName], 'An exact native dependency requirement conflicts with its declared locked version.');
      }
    }
    if (item.optionalDependencies || item.peerDependencies || item.peerDependenciesMeta) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content', 'packages', path], 'Optional and peer dependency lock semantics require additional qualification.');
    seen.add(id);
  }
  if (seen.size !== expected.size) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content'], 'The lock omits declared package artifacts.');
}

function verifyPythonLock(content: string, packages: readonly AcpLockedPackage[]): void {
  const expected = new Map(packages.map((item) => [packageId(item), item]));
  const seen = new Set<string>();
  for (const raw of content.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-z0-9][a-z0-9-]*)==([^\s]+)\s+--hash=sha256:([a-f0-9]{64})$/.exec(line);
    if (!match) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content'], 'Python locks support only exact canonical package requirements with one target SHA-256; options, markers, URLs, extras, and source builds are unsupported.');
    const id = `${match[1]}@${match[2]}`;
    const declared = expected.get(id);
    if (!declared || declared.sha256 !== `sha256:${match[3]}` || seen.has(id)) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content'], 'Python lock and declared target artifacts disagree.');
    seen.add(id);
  }
  if (seen.size !== expected.size) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'content'], 'The Python lock omits declared package artifacts.');
}

export function dependencyLock(value: unknown, context: LockContext): AcpDependencyLock {
  const lock = inputRecord(value, ['dependencyLock']);
  exactKeys(lock, ['format', 'content', 'digest', 'packages'], ['dependencyLock']);
  const format = context.kind === 'npx' ? 'npm-package-lock-v3' : 'python-requirements-hashes';
  if (lock.format !== format || typeof lock.content !== 'string' || !lock.content || lock.content.includes('\0') || Buffer.byteLength(lock.content, 'utf8') > 2 * 1_024 * 1_024) {
    invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock'], 'Select the bounded lock document format supported by this package installer.');
  }
  const digest = inputDigest(lock.digest, ['dependencyLock', 'digest']);
  if (sha256Digest(lock.content) !== digest) invalidRegistry('acp_registry_package_lock_invalid', ['dependencyLock', 'digest'], 'Lock bytes do not match the expected digest.');
  const packages = declaredPackages(lock.packages, context);
  if (context.kind === 'npx') verifyNpmLock(lock.content, packages, context); else verifyPythonLock(lock.content, packages);
  return { format, content: lock.content, digest, packages };
}
