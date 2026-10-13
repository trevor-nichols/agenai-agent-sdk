import { z } from 'zod/v4';

import type { AcpRegistrySource } from './contracts.js';
import { resolveAcpRegistryLimits } from './limits.js';
import { copyBoundedJson } from '../shared/bounds.js';
import { canonicalDigest } from '../shared/digest.js';
import { invalidRegistry, registrySchemaError } from '../shared/errors.js';
import { deepFreeze } from '../shared/immutable.js';

export const registrySourceSchema = z.strictObject({
  namespace: z.string().min(1).max(128).regex(/^[a-z][a-z0-9._-]*$/u),
  kind: z.enum(['remote', 'local']),
  channel: z.enum(['stable', 'preview']),
  location: z.string().min(1).max(4_096),
  profile: z.literal('published-v1'),
});

export function normalizeRegistryUrl(value: string, path: readonly (string | number)[]): string {
  if (/[\p{Cc}\p{Cf}\s\\]/u.test(value) || /%(?![0-9a-f]{2})/iu.test(value)) invalidRegistry('unsafe_url', path, 'Registry URLs cannot contain controls, whitespace, backslashes or malformed escapes.');
  let url: URL;
  try { url = new URL(value); } catch { return invalidRegistry('unsafe_url', path, 'Registry URLs must be absolute HTTP or HTTPS URLs.'); }
  const authority = value.match(/^https?:\/\/([^/?#]*)/iu)?.[1];
  if (authority === undefined || authority.includes('@') || value.includes('#') || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    invalidRegistry('unsafe_url', path, 'Registry URLs require HTTP or HTTPS without userinfo or fragments.');
  }
  if (/%(?:00|0a|0d)/iu.test(url.href)) invalidRegistry('unsafe_url', path, 'Registry URLs cannot contain encoded NUL or line breaks.');
  return url.href;
}

export function parseAcpRegistrySource(input: unknown): AcpRegistrySource {
  const captured = copyBoundedJson(input, resolveAcpRegistryLimits());
  const result = registrySourceSchema.safeParse(captured);
  if (!result.success) registrySchemaError(result.error, captured);
  const source = result.data;
  if (source.kind === 'remote') source.location = normalizeRegistryUrl(source.location, ['source', 'location']);
  else if (/[\p{Cc}\p{Cf}]/u.test(source.location)) invalidRegistry('invalid_source', ['source', 'location'], 'Local registry source identities cannot contain control characters.');
  return deepFreeze(source);
}

export function acpRegistrySourceIdentity(source: AcpRegistrySource): string {
  return `acp-registry:${source.namespace}:${canonicalDigest(source)}`;
}
