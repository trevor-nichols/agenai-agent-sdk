import { parseSandboxGuestPath } from '@agen-ai/sandbox';

export type SandboxApiKeyCredential = Readonly<{ kind: 'api_key'; value: string }>;

/** Capture data properties without evaluating untrusted accessors or accepting extra options. */
export function captureSandboxRecipeFields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (input === null || typeof input !== 'object'
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) invalid();
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
      fields[key] = descriptor.value;
    }
    if (required.some((key) => !Object.hasOwn(fields, key))) invalid();
    return fields;
  } catch {
    // Object/proxy inspection can itself throw caller data; keep this boundary content-free.
    invalid();
  }
}

/** The returned string is a selected secret; never include it in preflight or reports. */
export function captureSandboxApiKey(input: unknown): string {
  const fields = captureSandboxRecipeFields(input, ['kind', 'value']);
  if (fields.kind !== 'api_key' || typeof fields.value !== 'string' || !fields.value.isWellFormed()
    || fields.value.length === 0 || Buffer.byteLength(fields.value) > 8192 || /[\u0000\r\n]/u.test(fields.value)) invalid();
  return fields.value;
}

export function parseSandboxCliPrompt(input: unknown): string {
  if (typeof input !== 'string' || !input.isWellFormed() || input.length === 0
    || input.includes('\0') || Buffer.byteLength(input) > 64 * 1024) invalid();
  return input;
}

export function parseSandboxCliExecutable(input: unknown): string {
  try {
    const path = parseSandboxGuestPath(input);
    if (path === '/') invalid();
    return path;
  } catch { invalid(); }
}

function invalid(): never { throw new TypeError('Unsupported or malformed sandbox credential recipe input.'); }
