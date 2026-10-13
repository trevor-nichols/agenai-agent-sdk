import { basename } from 'node:path';
import type { AcpPackageArtifact } from '../contracts.js';
import type { AcpInstallPreparationContext } from '../internal.js';
import { AcpInstallationError } from '../errors.js';
import { acquireArtifact } from '../artifacts/acquire.js';
import { inspectArchive } from '../binary/archive.js';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import { inputRecord, PLANNING_INPUT_LIMITS } from '../../../selection/input.js';

export async function packageSources(context: AcpInstallPreparationContext, kind: 'npx' | 'uvx') {
  const resolution = context.plan.packageResolution!;
  const expected = resolution.dependencyLock?.packages;
  let descriptors: AcpPackageArtifact[] = [...context.packageArtifacts];
  if (expected) {
    const nativeLock = kind === 'npx' ? inputRecord(parseBoundedRegistryJson(resolution.dependencyLock!.content, PLANNING_INPUT_LIMITS), []) : undefined;
    const nativePackages = nativeLock ? inputRecord(nativeLock.packages, []) : undefined;
    descriptors = expected.map((item) => {
      const explicit = context.packageArtifacts.find((candidate) => candidate.name === item.name && candidate.version === item.version);
      if (explicit) {
        if (explicit.sha256 !== item.sha256) throw new AcpInstallationError('integrity_mismatch', 'An artifact mirror conflicts with expected locked package bytes.');
        return explicit;
      }
      const record = nativePackages && Object.entries(nativePackages).find(([path, value]) => path.split('node_modules/').at(-1) === item.name
        && inputRecord(value, []).version === item.version)?.[1];
      if (!record) throw new AcpInstallationError('artifact_unavailable', 'Every Python lock artifact requires an explicit name, version, wheel filename and source descriptor.');
      const url = inputRecord(record, []).resolved;
      if (typeof url !== 'string') throw new AcpInstallationError('invalid_input', 'Locked package artifacts require an explicit source URL.');
      return { name: item.name, version: item.version, sha256: item.sha256, url, filename: basename(new URL(url).pathname) };
    });
    if (context.packageArtifacts.some((item) => !expected.some((entry) => entry.name === item.name && entry.version === item.version))) {
      throw new AcpInstallationError('invalid_input', 'Artifact descriptors cannot add packages outside the declared lock.');
    }
  } else if (resolution.artifact && !descriptors.some((item) => item.name === resolution.name && item.version === resolution.version)) {
    descriptors.push({ name: resolution.name, version: resolution.version, ...resolution.artifact, filename: basename(new URL(resolution.artifact.url).pathname) });
  }
  if (!descriptors.length || descriptors.length > Math.min(context.limits.maxEntries, 2_048)
    || new Set(descriptors.map((item) => `${item.name}@${item.version}`)).size !== descriptors.length
    || !descriptors.some((item) => item.name === resolution.name && item.version === resolution.version)) {
    throw new AcpInstallationError('artifact_unavailable', 'Package installation needs a bounded explicit offline artifact closure including its exact root.');
  }
  const rootSource = descriptors.find((item) => item.name === resolution.name && item.version === resolution.version)!;
  if (context.plan.expectedIntegrity.sha256 && rootSource.sha256 !== context.plan.expectedIntegrity.sha256) {
    throw new AcpInstallationError('integrity_mismatch', 'The root package artifact conflicts with expected plan bytes.');
  }
  const sources = [];
  for (const descriptor of descriptors.sort((left, right) => `${left.name}@${left.version}` < `${right.name}@${right.version}` ? -1 : 1)) {
    if (kind === 'uvx' && !/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*\.whl$/.test(descriptor.filename)) throw new AcpInstallationError('unsupported_format', 'Python installation supports wheel artifacts with explicit safe wheel filenames.');
    const artifact = await acquireArtifact({ url: descriptor.url, expectedSha256: descriptor.sha256, context });
    const inspected = await inspectArchive({ artifactPath: artifact.path, format: kind === 'npx' ? 'tar.gz' : 'zip', limits: context.limits, signal: context.signal,
      ...(kind === 'npx' ? { readFiles: ['package/package.json'] } : {}) });
    sources.push({ descriptor, artifact, files: inspected.files });
  }
  return sources;
}
