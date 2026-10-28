import type { Sandbox } from '@agen-ai/sandbox';
import { readSandboxCredentialFile, reserveSandboxCredentialProcess } from '@agen-ai/sandbox/node';
import { captureSandboxApiKey, captureSandboxRecipeFields, parseSandboxCliExecutable, sandboxNativeEgress } from '../credentials/index.js';
import { codexPreflight, codexProcess } from './recipe.js';
import type { SandboxCodexLaunch, SandboxCodexRequest } from './types.js';

/** The borrowed sandbox must already contain the caller-verified exact native image and configuration. */
export async function reserveSandboxCodex(sandbox: Sandbox, input: SandboxCodexRequest): Promise<SandboxCodexLaunch> {
  const fields = captureSandboxRecipeFields(input, ['guestExecutable', 'credential'], ['signal']);
  const executable = parseSandboxCliExecutable(fields.guestExecutable);
  const signal = fields.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  const selected = captureSandboxRecipeFields(fields.credential, ['kind'],
    ['value', 'path', 'lineage', 'bootstrapExecutable', 'preparationTimeoutMs']);
  const kind = selected.kind;
  if (kind === 'api_key') {
    const value = captureSandboxApiKey(selected);
    const preflight = codexPreflight(kind);
    const egress = sandboxNativeEgress(sandbox, preflight.httpsDestinations);
    signal?.throwIfAborted();
    return Object.freeze({ reservation: sandbox.reserveProcess(codexProcess(executable, sandbox.workspace, { kind, value }, egress)), preflight });
  }
  if (kind !== 'auth_json') invalid();
  const credential = captureSandboxRecipeFields(selected,
    ['kind', 'path', 'lineage', 'bootstrapExecutable', 'preparationTimeoutMs']);
  if (credential.lineage !== 'caller_quiescent' || typeof credential.path !== 'string'
    || typeof credential.preparationTimeoutMs !== 'number' || !Number.isInteger(credential.preparationTimeoutMs)
    || credential.preparationTimeoutMs < 1 || credential.preparationTimeoutMs > 60_000) invalid();
  const bootstrapExecutable = parseSandboxCliExecutable(credential.bootstrapExecutable);
  const preflight = codexPreflight(kind);
  const egress = sandboxNativeEgress(sandbox, preflight.httpsDestinations);
  signal?.throwIfAborted();
  // The reader reports an abort during the read as its content-free source error.
  const bytes = await readSandboxCredentialFile({ path: credential.path, ...(signal === undefined ? {} : { signal }) });
  try {
    // An abort that arrives with the read result still prevents reservation; the copied bytes are wiped below.
    signal?.throwIfAborted();
    admitChatGptCache(bytes);
    return Object.freeze({ reservation: reserveSandboxCredentialProcess(sandbox, {
      bootstrapExecutable, process: codexProcess(executable, sandbox.workspace, { kind }, egress),
      file: { name: 'auth.json', bytes }, preparationTimeoutMs: credential.preparationTimeoutMs,
    }), preflight });
  } finally { bytes.fill(0); }
}

function admitChatGptCache(bytes: Uint8Array): void {
  try {
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
    const cache = captureSandboxRecipeFields(input, [], Object.keys(input));
    if (cache.auth_mode !== 'chatgpt' || (cache.OPENAI_API_KEY !== undefined
      && cache.OPENAI_API_KEY !== null && cache.OPENAI_API_KEY !== '')) invalid();
    if (cache.tokens === null || typeof cache.tokens !== 'object' || Array.isArray(cache.tokens)) invalid();
    const tokens = captureSandboxRecipeFields(cache.tokens, [], Object.keys(cache.tokens));
    for (const key of ['access_token', 'id_token', 'refresh_token']) {
      const token = tokens[key];
      if (typeof token !== 'string' || !token.isWellFormed() || token.length === 0 || /[\u0000\r\n]/u.test(token)) invalid();
    }
  } catch { invalid(); }
}

function invalid(): never { throw new TypeError('Unsupported or malformed selected Codex credential route.'); }

export type { SandboxCodexCredential, SandboxCodexLaunch, SandboxCodexPreflight, SandboxCodexRequest } from './types.js';
