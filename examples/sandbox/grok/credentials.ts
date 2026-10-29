import { captureSandboxRecipeFields, type SandboxCredentialLineage } from '../credentials/index.js';

const issuer = 'https://auth.x.ai';
const clientId = 'b1a00492-073a-47ea-816f-4c329264a828';
const scope = `${issuer}::${clientId}`;

/** Admit one first-party saved account; the native binary owns refresh and entitlement. */
export function selectGrokAccount(value: unknown, lineage: SandboxCredentialLineage = 'caller_quiescent'): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const store = captureSandboxRecipeFields(value, [scope], Object.keys(value));
  const account = store[scope];
  if (account === null || typeof account !== 'object' || Array.isArray(account)) invalid();
  const fields = captureSandboxRecipeFields(account, ['key', 'auth_mode', 'create_time', 'user_id'], Object.keys(account));
  if (fields.auth_mode !== 'oidc' || fields.oidc_issuer !== issuer || fields.oidc_client_id !== clientId
    || !text(fields.key) || !text(fields.user_id) || !text(fields.create_time) || !Number.isFinite(Date.parse(fields.create_time))
    || (fields.refresh_token !== undefined && fields.refresh_token !== null && !text(fields.refresh_token))
    || (fields.expires_at !== undefined && fields.expires_at !== null
      && (!text(fields.expires_at) || !Number.isFinite(Date.parse(fields.expires_at))))) invalid();
  if (lineage === 'access_token_only') delete fields.refresh_token;
  return { [scope]: fields };
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value.length > 0 && !/[\u0000\r\n]/u.test(value);
}
function invalid(): never { throw new TypeError('Select one native first-party Grok account credential.'); }
