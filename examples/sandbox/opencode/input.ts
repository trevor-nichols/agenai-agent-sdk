import { captureSandboxApiKey, captureSandboxRecipeFields, captureSandboxCredentialPreparation } from '../credentials/index.js';
import type { SandboxOpenCodeConfiguredInput, SandboxOpenCodeSelection } from './types.js';

export function captureOpenCodeConfiguration(fields: Record<string, unknown>) {
  const selected = captureSandboxRecipeFields(fields.selection, ['provider', 'model', 'httpsDestinations']);
  if (typeof selected.provider !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/u.test(selected.provider)
    || typeof selected.model !== 'string' || !selected.model.startsWith(`${selected.provider}/`)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,255}$/u.test(selected.model)
    || selected.model.length === selected.provider.length + 1) invalid();
  const selection: SandboxOpenCodeSelection = Object.freeze({ provider: selected.provider, model: selected.model,
    httpsDestinations: captureOrigins(selected.httpsDestinations) });
  const preparation = captureSandboxCredentialPreparation(fields.preparation);
  const selectedCredential = captureSandboxRecipeFields(fields.credential, ['kind'], ['value', 'path', 'credentialId', 'lineage']);
  let credential: SandboxOpenCodeConfiguredInput['credential'];
  if (selectedCredential.kind === 'api_key') credential = { kind: 'api_key', value: captureSandboxApiKey(selectedCredential) };
  else {
    const account = captureSandboxRecipeFields(selectedCredential, ['kind', 'path', 'credentialId', 'lineage']);
    if (account.kind !== 'auth_export' || typeof account.path !== 'string'
      || (account.lineage !== 'caller_quiescent' && account.lineage !== 'access_token_only')
      || typeof account.credentialId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(account.credentialId)) invalid();
    credential = { kind: 'auth_export', path: account.path, credentialId: account.credentialId, lineage: account.lineage };
  }
  const signal = fields.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  return { selection, credential, preparation, signal };
}

function captureOrigins(input: unknown): readonly string[] {
  try {
    if (!Array.isArray(input) || input.length < 1 || input.length > 128) invalid();
    const origins: string[] = [];
    for (let index = 0; index < input.length; index++) {
      const field = Object.getOwnPropertyDescriptor(input, String(index));
      if (!field || !('value' in field) || typeof field.value !== 'string' || field.value.length > 512) invalid();
      const url = new URL(field.value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid();
      origins.push(url.origin);
    }
    return Object.freeze([...new Set(origins)]);
  } catch { invalid(); }
}
function invalid(): never { throw new TypeError('Select one OpenCode provider/model, credential and bounded native import preparation.'); }
