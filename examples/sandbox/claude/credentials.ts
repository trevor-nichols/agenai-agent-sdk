import { parseSandboxGuestPath } from '@agen-ai/sandbox';
import { readSandboxCredentialFile } from '@agen-ai/sandbox/node';
import { claudeFields, invalidClaudeInput as invalid } from './fields.js';
import type { ClaudeSandboxCredential, ClaudeSavedCredential } from './types.js';

export function parseClaudeCredential(input: unknown): ClaudeSandboxCredential {
  const fields = claudeFields(input, new Set(['kind', 'value', 'path', 'lineage', 'bootstrapExecutable', 'preparationTimeoutMs']));
  if (fields.kind === 'api_key' || fields.kind === 'oauth_token') {
    claudeFields(input, new Set(['kind', 'value']));
    if (!token(fields.value) || Buffer.byteLength(fields.value) > 8192) invalid();
    return Object.freeze({ kind: fields.kind, value: fields.value });
  }
  if (fields.kind !== 'auth_json') invalid();
  claudeFields(input, new Set(['kind', 'path', 'lineage', 'bootstrapExecutable', 'preparationTimeoutMs']));
  if (typeof fields.path !== 'string' || fields.lineage !== 'caller_quiescent'
    || typeof fields.preparationTimeoutMs !== 'number' || !Number.isInteger(fields.preparationTimeoutMs)
    || fields.preparationTimeoutMs < 1 || fields.preparationTimeoutMs > 60_000) invalid();
  let bootstrapExecutable: string;
  try { bootstrapExecutable = parseSandboxGuestPath(fields.bootstrapExecutable); } catch { invalid(); }
  if (bootstrapExecutable === '/') invalid();
  return Object.freeze({ kind: 'auth_json', path: fields.path, lineage: fields.lineage,
    bootstrapExecutable, preparationTimeoutMs: fields.preparationTimeoutMs });
}

export function claudeCredentialEnvironment(credential: ClaudeSandboxCredential): Readonly<Record<string, string>> {
  switch (credential.kind) {
    case 'api_key': return { ANTHROPIC_API_KEY: credential.value };
    case 'oauth_token': return { CLAUDE_CODE_OAUTH_TOKEN: credential.value };
    case 'auth_json': return { CLAUDE_CONFIG_DIR: '/home/sandbox/.agenai-credentials' };
  }
}

export async function readClaudeCredential(credential: ClaudeSavedCredential, signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = await readSandboxCredentialFile({ path: credential.path, ...(signal === undefined ? {} : { signal }) });
  try {
    signal?.throwIfAborted();
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) invalid();
    const cache = claudeFields(data, new Set(Object.keys(data)));
    const account = cache.claudeAiOauth;
    if (account === null || typeof account !== 'object' || Array.isArray(account)) invalid();
    const oauth = claudeFields(account, new Set(Object.keys(account)));
    if (!token(oauth.accessToken) || !token(oauth.refreshToken) || typeof oauth.expiresAt !== 'number'
      || !Number.isSafeInteger(oauth.expiresAt) || oauth.expiresAt < 0) invalid();
    return Buffer.from(JSON.stringify({ claudeAiOauth: account }), 'utf8');
  } catch { invalid(); }
  finally { bytes.fill(0); }
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value.length > 0 && !/[\u0000\r\n]/u.test(value);
}
