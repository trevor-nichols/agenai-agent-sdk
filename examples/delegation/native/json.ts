import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export class NativeInputError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'NativeInputError'; }
}

export function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || !value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new NativeInputError('evidence_value_invalid');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function semanticDigest(value: unknown): string { return sha256(canonicalJson(value)); }

// JSON.parse cannot detect duplicate decoded keys. Inspect the bounded text first.
export function parseNativeJson(text: string): unknown {
  let at = 0;
  let nodes = 0;
  const invalid = (): never => { throw new NativeInputError('input_json_invalid'); };
  const whitespace = () => { while (/[\t\n\r ]/u.test(text[at] ?? '\0')) at += 1; };
  const string = (): string => {
    if (text[at] !== '"') return invalid();
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === '\\') { at += 1; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, at)) as string; } catch { return invalid(); }
      }
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 16 || ++nodes > 50_000) throw new NativeInputError('input_json_limit');
    whitespace();
    const character = text[at];
    if (character === '"') { string(); return; }
    if (character === '{' || character === '[') {
      at += 1;
      const end = character === '{' ? '}' : ']';
      const keys = new Set<string>();
      whitespace();
      if (text[at] === end) { at += 1; return; }
      for (;;) {
        whitespace();
        if (character === '{') {
          const key = string();
          if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
            throw new NativeInputError('input_json_duplicate_or_unsafe_key');
          }
          keys.add(key);
          whitespace();
          if (text[at++] !== ':') return invalid();
        }
        value(depth + 1);
        whitespace();
        if (text[at] === end) { at += 1; return; }
        if (text[at++] !== ',') return invalid();
      }
    }
    const start = at;
    while (at < text.length && !/[\t\n\r ,}\]]/u.test(text[at]!)) at += 1;
    if (at === start) return invalid();
  };
  value(0);
  whitespace();
  if (at !== text.length) return invalid();
  try {
    const parsed: unknown = JSON.parse(text);
    canonicalJson(parsed); // Also rejects overflowed JSON numbers.
    return parsed;
  } catch (error) {
    if (error instanceof NativeInputError) throw error;
    return invalid();
  }
}

export function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new NativeInputError('input_object_invalid');
  const fields = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(fields, key)) || Object.keys(fields).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new NativeInputError('input_fields_invalid');
  }
  return fields;
}

export function textValue(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NativeInputError('input_string_invalid');
  }
  return value;
}

export function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new NativeInputError('input_integer_invalid');
  return value;
}

export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new NativeInputError('input_digest_invalid');
  return value;
}

export function exact<T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) throw new NativeInputError('input_literal_invalid');
  return expected;
}

export function array<T>(value: unknown, maximum: number, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new NativeInputError('input_array_invalid');
  return value.map(parse);
}

export async function readNativeInput(path: string, expected: string | undefined, maximum: number): Promise<{ value: unknown; fileDigest: string }> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new NativeInputError('input_path_invalid');
  if (expected !== undefined) digest(expected);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum) throw new NativeInputError('input_file_limit');
    const bytes = Buffer.alloc(Math.min(maximum + 1, before.size + 1));
    let used = 0;
    while (used < bytes.length) {
      const next = await file.read(bytes, used, bytes.length - used, used);
      if (next.bytesRead === 0) break;
      used += next.bytesRead;
    }
    const after = await file.stat();
    if (used !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new NativeInputError('input_file_changed');
    }
    const content = bytes.subarray(0, used);
    const fileDigest = sha256(content);
    if (expected !== undefined && fileDigest !== expected) throw new NativeInputError('input_digest_mismatch');
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { throw new NativeInputError('input_utf8_invalid'); }
    return { value: parseNativeJson(decoded), fileDigest };
  } finally { await file.close(); }
}
