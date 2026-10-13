import type { AcpRegistryEntry, AcpRegistrySnapshot } from './contracts.js';
import { MAX_ACP_REGISTRY_LIMITS } from './limits.js';
import { acpRegistryEntryToPublished, normalizeAcpRegistryEntry } from './normalize.js';
import { acpRegistrySchemas } from './schemas.js';
import { acpRegistrySourceIdentity, parseAcpRegistrySource } from './source.js';
import { copyBoundedJson } from '../shared/bounds.js';
import { canonicalDigest } from '../shared/digest.js';
import { invalidRegistry, registrySchemaError } from '../shared/errors.js';
import { deepFreeze } from '../shared/immutable.js';

/** Verifies serializable normalized metadata and self-consistency; it does not authenticate its publisher. */
export function validateAcpRegistryEntry(input: unknown): AcpRegistryEntry {
  const captured = copyBoundedJson(input, MAX_ACP_REGISTRY_LIMITS);
  const schemas = acpRegistrySchemas(MAX_ACP_REGISTRY_LIMITS);
  const result = schemas.normalizedEntry.safeParse(captured);
  if (!result.success) registrySchemaError(result.error, captured);
  assertCanonicalEntry(result.data);
  return deepFreeze(result.data);
}

function assertCanonicalEntry(entry: AcpRegistryEntry): void {
  const sourceIdentity = entry.identity.slice(0, entry.identity.lastIndexOf('/'));
  const normalized = normalizeAcpRegistryEntry(acpRegistryEntryToPublished(entry), sourceIdentity, 'preview', 0);
  if (canonicalDigest(normalized) !== canonicalDigest(entry)) invalidRegistry('entry_digest_mismatch', ['digest'], 'Registry entry metadata, identity or digest is not canonical.');
}

/** A retained rawDigest is provenance evidence, never proof that these bytes came from a trusted publisher. */
export function validateAcpRegistrySnapshot(input: unknown): AcpRegistrySnapshot {
  const captured = copyBoundedJson(input, MAX_ACP_REGISTRY_LIMITS);
  const result = acpRegistrySchemas(MAX_ACP_REGISTRY_LIMITS).normalizedSnapshot.safeParse(captured);
  if (!result.success) registrySchemaError(result.error, captured);
  const snapshot = result.data;
  const source = parseAcpRegistrySource(snapshot.source);
  if (snapshot.sourceIdentity !== acpRegistrySourceIdentity(source) || canonicalDigest(source) !== canonicalDigest(snapshot.source)) {
    invalidRegistry('source_identity_mismatch', ['sourceIdentity'], 'Registry source identity does not match its canonical descriptor.');
  }
  let previous = '';
  for (const [index, entry] of snapshot.entries.entries()) {
    assertCanonicalEntry(entry);
    if (entry.id <= previous) invalidRegistry('duplicate_identity', ['entries', index, 'id'], 'Registry entries must have unique identities in canonical order.');
    previous = entry.id;
    if (entry.identity !== `${snapshot.sourceIdentity}/${entry.id}`) invalidRegistry('source_identity_mismatch', ['entries', index, 'identity'], 'Registry entry belongs to a different source.');
    if (source.channel === 'stable' && entry.version.includes('-')) invalidRegistry('channel_mismatch', ['entries', index, 'version'], 'Stable catalogs cannot contain preview release identities.');
  }
  const { digest, ...body } = snapshot;
  if (canonicalDigest(body) !== digest) invalidRegistry('snapshot_digest_mismatch', ['digest'], 'Registry normalized snapshot digest does not match its metadata.');
  return deepFreeze(snapshot);
}
