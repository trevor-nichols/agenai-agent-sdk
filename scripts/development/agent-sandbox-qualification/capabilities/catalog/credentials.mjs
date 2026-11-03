import { homedir } from 'node:os';
import { join } from 'node:path';
import { physicalPath } from '../../platform/capabilities/input.mjs';

export const credentialScope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const nullableText = ['email', 'first_name', 'last_name', 'profile_image_asset_id', 'principal_type', 'principal_id',
  'team_id', 'team_name', 'team_role', 'organization_id', 'organization_name', 'organization_role', 'user_blocked_reason'];
const nullableBoolean = ['can_administer_team', 'has_grok_code_access'];
const text = (value) => typeof value === 'string' && value.length <= 1024 && !/[\p{Cc}\p{Cf}]/u.test(value);
const timestamp = (value) => {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second, offsetHour = 0, offsetMinute = 0] = parts.slice(1).map((part) => part === undefined ? 0 : Number(part));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class CatalogCredentialRefusal extends Error {
  constructor(code) { super('Existing access credential was refused.'); this.code = code; }
}

export function selectedCredentialPath(environment = process.env, home = homedir()) {
  return physicalPath(environment.GROK_AUTH_PATH || join(environment.GROK_HOME || join(home, '.grok'), 'auth.json'));
}

/** Project the existing first-party access record; refresh material is never serialized. */
export function projectAccessCredential(bytes, now = Date.now()) {
  const refuse = (code) => { throw new CatalogCredentialRefusal(code); };
  if (bytes.byteLength > 64 * 1024) refuse('credential_payload_too_large');
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { refuse('malformed_credentials'); }
  if (!object(input) || Object.keys(input).length > 128 || Object.keys(input).some((key) => key.length > 4096)) refuse('malformed_credentials');
  const source = input[credentialScope];
  if (source === undefined) refuse('unsupported_account');
  if (!object(source) || source.auth_mode !== 'oidc' || source.oidc_issuer !== 'https://auth.x.ai'
    || typeof source.key !== 'string' || source.key.length < 1 || source.key.length > 16 * 1024
    || !/^[A-Za-z0-9._~+/-]+=*$/u.test(source.key) || !timestamp(source.create_time)
    || !text(source.user_id) || source.user_id.length < 1) refuse('malformed_credentials');
  const record = { key: source.key, auth_mode: 'oidc', create_time: source.create_time, user_id: source.user_id, oidc_issuer: 'https://auth.x.ai' };
  for (const key of nullableText) if (source[key] !== undefined) {
    if (source[key] !== null && !text(source[key])) refuse('malformed_credentials');
    record[key] = source[key];
  }
  for (const key of nullableBoolean) if (source[key] !== undefined) {
    if (source[key] !== null && typeof source[key] !== 'boolean') refuse('malformed_credentials');
    record[key] = source[key];
  }
  if (source.team_blocked_reasons !== undefined) {
    if (!Array.isArray(source.team_blocked_reasons) || source.team_blocked_reasons.length > 128
      || !source.team_blocked_reasons.every(text)) refuse('malformed_credentials');
    record.team_blocked_reasons = source.team_blocked_reasons;
  }
  if (source.coding_data_retention_opt_out !== undefined) {
    if (typeof source.coding_data_retention_opt_out !== 'boolean') refuse('malformed_credentials');
    record.coding_data_retention_opt_out = source.coding_data_retention_opt_out;
  }
  if (source.expires_at !== undefined) {
    if (source.expires_at !== null && !timestamp(source.expires_at)) refuse('malformed_credentials');
    record.expires_at = source.expires_at;
  }
  if (!record.email && !record.principal_id) refuse('unsupported_account');
  const expires = record.expires_at == null ? Date.parse(record.create_time) + 30 * 24 * 60 * 60 * 1000 : Date.parse(record.expires_at);
  if (expires <= now + 300_000) refuse('expired_credentials');
  const projected = Buffer.from(JSON.stringify({ [credentialScope]: record }));
  return { bytes: projected, prepared() { projected.fill(0); }, dispose() { projected.fill(0); } };
}

export async function acquireAccessCredential(sandboxNode, path, signal) {
  let source;
  try {
    source = await sandboxNode.readSandboxCredentialFile({ path, ...(signal ? { signal } : {}) });
    return projectAccessCredential(source);
  } catch (error) {
    if (error instanceof CatalogCredentialRefusal) throw error;
    throw new CatalogCredentialRefusal(signal?.aborted ? 'aborted' : 'credential_source_unavailable');
  } finally { source?.fill(0); }
}
