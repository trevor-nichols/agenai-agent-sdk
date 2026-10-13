import type { AcpRegistryLimits, AcpRegistrySnapshot, ParseAcpRegistrySnapshotInput } from './contracts.js';
import { resolveAcpRegistryLimits } from './limits.js';
import { normalizeAcpRegistryEntry } from './normalize.js';
import { acpRegistrySchemas } from './schemas.js';
import { acpRegistrySourceIdentity, parseAcpRegistrySource } from './source.js';
import { parseBoundedRegistryJson, utf8Bytes } from '../shared/bounds.js';
import { canonicalDigest, sha256Digest } from '../shared/digest.js';
import { invalidRegistry, registrySchemaError } from '../shared/errors.js';
import { deepFreeze } from '../shared/immutable.js';

export function parseAcpRegistrySnapshot(input: ParseAcpRegistrySnapshotInput): AcpRegistrySnapshot {
  if (input === null || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) invalidRegistry('invalid_input', [], 'Registry parser input must be a plain object.');
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !['source', 'content', 'limits'].includes(key)) invalidRegistry('invalid_input', [], 'Unknown registry parser input property.');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidRegistry('invalid_input', [key], 'Registry parser input requires enumerable data properties.');
    captured[key] = descriptor.value;
  }
  const limits = resolveAcpRegistryLimits(captured.limits as Partial<AcpRegistryLimits> | undefined);
  const source = parseAcpRegistrySource(captured.source);
  const sourceIdentity = acpRegistrySourceIdentity(source);
  const content = captured.content;
  if (typeof content !== 'string' && !(content instanceof Uint8Array)) invalidRegistry('invalid_content', ['content'], 'Registry content must be UTF-8 text or bytes.');
  if ((typeof content === 'string' ? content.length > limits.maxSnapshotBytes || utf8Bytes(content) > limits.maxSnapshotBytes : content.byteLength > limits.maxSnapshotBytes)) invalidRegistry('byte_limit', ['content'], 'Registry content exceeds its byte limit.');
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  if (bytes.byteLength > limits.maxSnapshotBytes) invalidRegistry('byte_limit', ['content'], 'Registry content exceeds its byte limit.');
  let text: string;
  try { text = typeof content === 'string' ? content : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalidRegistry('invalid_utf8', ['content'], 'Registry content must be valid UTF-8.'); }
  const parsed = parseBoundedRegistryJson(text, limits);
  const result = acpRegistrySchemas(limits).rawSnapshot.safeParse(parsed);
  if (!result.success) registrySchemaError(result.error, parsed);
  const identities = new Set<string>();
  const entries = result.data.agents.map((entry, index) => {
    if (identities.has(entry.id)) invalidRegistry('duplicate_identity', ['agents', index, 'id'], 'Registry agent identities must be unique within one source.');
    identities.add(entry.id);
    return normalizeAcpRegistryEntry(entry, sourceIdentity, source.channel, index);
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const snapshot = { format: 'acp-registry-published-v1' as const, source, sourceIdentity, rawDigest: sha256Digest(bytes), entries };
  return deepFreeze({ ...snapshot, digest: canonicalDigest(snapshot) });
}
