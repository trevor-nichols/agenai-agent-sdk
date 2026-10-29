import { captureSandboxRecipeFields, type SandboxCredentialLineage } from '../credentials/index.js';

/** Only the explicitly selected native OAuth entry crosses into the fresh guest database. */
export function selectOpenCodeAccount(input: unknown, credentialId: string, provider: string,
  lineage: SandboxCredentialLineage = 'caller_quiescent'): readonly unknown[] {
  if (!Array.isArray(input)) invalid();
  const matches = input.filter((entry: unknown) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && Object.getOwnPropertyDescriptor(entry, 'id')?.value === credentialId);
  if (matches.length !== 1) invalid();
  const entry = captureSandboxRecipeFields(matches[0], ['id', 'integrationID', 'label', 'active', 'value']);
  if (entry.integrationID !== provider || typeof entry.label !== 'string' || typeof entry.active !== 'boolean') invalid();
  const value = captureSandboxRecipeFields(entry.value, ['type', 'methodID', 'refresh', 'access', 'expires'], ['metadata']);
  // Native methods own expiry/refresh semantics: Copilot uses expires=0 and an empty access token.
  if (value.type !== 'oauth' || !token(value.methodID) || typeof value.refresh !== 'string' || typeof value.access !== 'string'
    || (value.refresh !== '' && !token(value.refresh)) || (value.access !== '' && !token(value.access))
    || (!token(value.refresh) && !token(value.access)) || typeof value.expires !== 'number'
    || !Number.isSafeInteger(value.expires) || value.expires < 0
    || (value.metadata !== undefined && (value.metadata === null || typeof value.metadata !== 'object' || Array.isArray(value.metadata)))) invalid();
  if (lineage === 'access_token_only') {
    if (provider !== 'openai' || !['chatgpt-browser', 'chatgpt-headless'].includes(String(value.methodID)) || !token(value.access)) invalid();
    // Native 2.1.2 resolves OAuth by refreshing five minutes before expiry, even with an empty refresh field.
    if (value.expires <= Date.now() + 5 * 60 * 1000) invalid();
    const metadata = value.metadata === undefined ? {} : captureSandboxRecipeFields(value.metadata, [], Object.keys(value.metadata));
    if (metadata.accountID !== undefined && !token(metadata.accountID)) invalid();
    return [{ id: credentialId, integrationID: provider, label: 'Explicit sandbox account', active: true,
      value: { type: 'oauth', methodID: value.methodID, access: value.access, refresh: '', expires: value.expires,
        ...(metadata.accountID === undefined ? {} : { metadata: { accountID: metadata.accountID } }) } }];
  }
  return [{ id: credentialId, integrationID: provider, label: 'Explicit sandbox account', active: true, value }];
}

export function createOpenCodeKeyExport(key: string, provider: string): Uint8Array {
  return Buffer.from(JSON.stringify([{ id: 'cred_agenai-sandbox-selected', integrationID: provider,
    label: 'Explicit sandbox API key', active: true, value: { type: 'key', key } }]));
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() && !/[\u0000\r\n]/u.test(value);
}
function invalid(): never { throw new TypeError('Select exactly one matching native OpenCode OAuth credential from auth export.'); }
