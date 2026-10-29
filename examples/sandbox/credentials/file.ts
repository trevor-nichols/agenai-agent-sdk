import { readSandboxCredentialFile } from '@agen-ai/sandbox/node';
import { captureSandboxRecipeFields, parseSandboxCliExecutable } from './input.js';

export type SandboxCredentialLineage = 'caller_quiescent' | 'access_token_only';
export type SandboxSavedCredential<Kind extends string = 'auth_json', Lineage extends SandboxCredentialLineage = 'caller_quiescent'> = Readonly<{
  kind: Kind;
  path: string;
  /** Quiescent copies own refresh; access-token-only projections must omit native refresh authority. */
  lineage: Lineage;
  bootstrapExecutable: string;
  preparationTimeoutMs: number;
}>;

export function captureSandboxCredentialPreparation(input: unknown) {
  const fields = captureSandboxRecipeFields(input, ['bootstrapExecutable', 'preparationTimeoutMs']);
  if (typeof fields.preparationTimeoutMs !== 'number' || !Number.isInteger(fields.preparationTimeoutMs)
    || fields.preparationTimeoutMs < 1 || fields.preparationTimeoutMs > 60_000) invalid();
  return Object.freeze({ bootstrapExecutable: parseSandboxCliExecutable(fields.bootstrapExecutable), preparationTimeoutMs: fields.preparationTimeoutMs });
}

export function captureSandboxSavedCredential<Kind extends string>(input: unknown, kind: Kind): SandboxSavedCredential<Kind>;
export function captureSandboxSavedCredential<Kind extends string>(input: unknown, kind: Kind, lineage: SandboxCredentialLineage): SandboxSavedCredential<Kind, SandboxCredentialLineage>;
export function captureSandboxSavedCredential<Kind extends string>(input: unknown, kind: Kind,
  lineage: SandboxCredentialLineage = 'caller_quiescent'): SandboxSavedCredential<Kind, SandboxCredentialLineage> {
  const fields = captureSandboxRecipeFields(input, ['kind', 'path', 'lineage', 'bootstrapExecutable', 'preparationTimeoutMs']);
  if (fields.kind !== kind || typeof fields.path !== 'string' || fields.lineage !== lineage) invalid();
  return Object.freeze({ kind, path: fields.path, lineage,
    ...captureSandboxCredentialPreparation({ bootstrapExecutable: fields.bootstrapExecutable, preparationTimeoutMs: fields.preparationTimeoutMs }) });
}

/** Caller owns and must wipe returned bytes after the reservation has captured them. */
export async function readSandboxCredentialJson(credential: Readonly<{ path: string }>, select: (value: unknown) => unknown,
  signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = await readSandboxCredentialFile({ path: credential.path, ...(signal === undefined ? {} : { signal }) });
  try {
    signal?.throwIfAborted();
    const selected = select(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return Buffer.from(JSON.stringify(selected), 'utf8');
  } catch { invalid(); }
  finally { bytes.fill(0); }
}

function invalid(): never { throw new TypeError('Unsupported or malformed selected native credential file.'); }
