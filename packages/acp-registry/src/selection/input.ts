import { invalidRegistry } from '../shared/errors.js';
import { copyBoundedJson } from '../shared/bounds.js';
import { normalizeRegistryUrl } from '../catalog/source.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type InputRecord = Record<string, unknown>;
export const PLANNING_INPUT_LIMITS = Object.freeze({ maxSnapshotBytes: 4 * 1_024 * 1_024, maxStringBytes: 2 * 1_024 * 1_024,
  maxValues: 100_000, maxDepth: 24, maxEntries: 2_048, maxArgs: 128, maxEnvEntries: 128 });

export function plainInput(value: unknown): JsonValue {
  return copyBoundedJson(value, PLANNING_INPUT_LIMITS) as JsonValue;
}

export function inputRecord(value: unknown, path: readonly (string | number)[]): InputRecord {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    invalidRegistry('acp_registry_plan_input_invalid', path, 'Expected a plain object.');
  }
  return value as InputRecord;
}

export function exactKeys(value: InputRecord, allowed: readonly string[], path: readonly (string | number)[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalidRegistry('acp_registry_plan_input_invalid', [...path, key], 'Unknown planning property.');
  }
}

export function inputString(value: unknown, path: readonly (string | number)[], max = 4_096): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) {
    invalidRegistry('acp_registry_plan_input_invalid', path, 'Expected a bounded nonempty string without control characters.');
  }
  return value;
}

export function inputDigest(value: unknown, path: readonly (string | number)[]): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    invalidRegistry('acp_registry_plan_digest_invalid', path, 'Expected a canonical SHA-256 digest.');
  }
  return value;
}

export function inputUrl(value: unknown, path: readonly (string | number)[]): string {
  const literal = inputString(value, path, 8_192);
  if (normalizeRegistryUrl(literal, path) !== literal) {
    invalidRegistry('acp_registry_plan_url_invalid', path, 'Artifact URLs must be canonical HTTP(S), without credentials or fragments.');
  }
  return literal;
}
