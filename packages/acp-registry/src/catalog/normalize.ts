import type { z } from 'zod/v4';

import type { AcpRegistryDistribution, AcpRegistryEntry } from './contracts.js';
import { normalizeRegistryExecutable, validateRegistryPackage } from './launch.js';
import { normalizeRegistryUrl } from './source.js';
import { ACP_REGISTRY_TARGETS, type acpRegistrySchemas } from './schemas.js';
import { canonicalDigest } from '../shared/digest.js';
import { invalidRegistry } from '../shared/errors.js';

type RawEntry = z.infer<ReturnType<typeof acpRegistrySchemas>['rawEntry']>;

export function normalizeAcpRegistryEntry(input: RawEntry, sourceIdentity: string, channel: 'stable' | 'preview', index: number): AcpRegistryEntry {
  const path = ['agents', index] as const;
  if (channel === 'stable' && input.version.includes('-')) invalidRegistry('channel_mismatch', [...path, 'version'], 'Stable catalogs cannot contain preview agent release identities.');
  if (input.id !== 'dimcode' && input.license_url === undefined) invalidRegistry('license_required', [...path, 'license_url'], 'Published ACP entries require license_url except the pinned dimcode exception.');
  const distributions: AcpRegistryDistribution[] = [];
  for (const target of ACP_REGISTRY_TARGETS) {
    const binary = input.distribution.binary?.[target];
    if (!binary) continue;
    const env = { ...binary.env ?? {} };
    if (target.startsWith('windows-') && new Set(Object.keys(env).map((key) => key.toUpperCase())).size !== Object.keys(env).length) {
      invalidRegistry('ambiguous_environment', [...path, 'distribution', 'binary', target, 'env'], 'Windows environment names cannot collide after case folding.');
    }
    distributions.push({ kind: 'binary', target,
      archive: normalizeRegistryUrl(binary.archive, [...path, 'distribution', 'binary', target, 'archive']),
      executable: normalizeRegistryExecutable(binary.cmd), args: [...binary.args ?? []], env,
      ...(binary.sha256 === undefined ? {} : { sha256: binary.sha256.toLowerCase() }),
    });
  }
  for (const kind of ['npx', 'uvx'] as const) {
    const distribution = input.distribution[kind];
    if (!distribution) continue;
    validateRegistryPackage(distribution.package, kind);
    distributions.push({ kind, package: distribution.package, args: [...distribution.args ?? []], env: { ...distribution.env ?? {} } });
  }
  const entry = {
    identity: `${sourceIdentity}/${input.id}`, id: input.id, name: input.name, version: input.version,
    description: input.description, authors: [...input.authors ?? []], distributions,
    ...(input.repository === undefined ? {} : { repository: normalizeRegistryUrl(input.repository, [...path, 'repository']) }),
    ...(input.website === undefined ? {} : { website: normalizeRegistryUrl(input.website, [...path, 'website']) }),
    ...(input.license === undefined ? {} : { license: input.license }),
    ...(input.license_url === undefined ? {} : { licenseUrl: normalizeRegistryUrl(input.license_url, [...path, 'license_url']) }),
    ...(input.icon === undefined ? {} : { icon: normalizeRegistryUrl(input.icon, [...path, 'icon']) }),
    ...(input.bundled === undefined ? {} : { bundled: input.bundled }),
  };
  return { ...entry, digest: canonicalDigest(entry) };
}

/** Reuses the published shape's closure for normalized snapshot admission without trusting retained digests. */
export function acpRegistryEntryToPublished(entry: AcpRegistryEntry): RawEntry {
  const binary: NonNullable<RawEntry['distribution']['binary']> = {};
  const distribution: RawEntry['distribution'] = {};
  for (const item of entry.distributions) {
    if (item.kind === 'binary') {
      if (Object.hasOwn(binary, item.target)) invalidRegistry('duplicate_distribution', ['distributions'], 'An entry repeats a binary target.');
      binary[item.target] = { archive: item.archive, cmd: item.executable, args: [...item.args], env: { ...item.env }, ...(item.sha256 === undefined ? {} : { sha256: item.sha256 }) };
    } else {
      if (distribution[item.kind] !== undefined) invalidRegistry('duplicate_distribution', ['distributions'], 'An entry repeats a package distribution kind.');
      distribution[item.kind] = { package: item.package, args: [...item.args], env: { ...item.env } };
    }
  }
  if (Object.keys(binary).length) distribution.binary = binary;
  return { id: entry.id, name: entry.name, version: entry.version, description: entry.description, authors: [...entry.authors], distribution,
    ...(entry.repository === undefined ? {} : { repository: entry.repository }), ...(entry.website === undefined ? {} : { website: entry.website }),
    ...(entry.license === undefined ? {} : { license: entry.license }), ...(entry.licenseUrl === undefined ? {} : { license_url: entry.licenseUrl }),
    ...(entry.icon === undefined ? {} : { icon: entry.icon }), ...(entry.bundled === undefined ? {} : { bundled: entry.bundled }),
  };
}
