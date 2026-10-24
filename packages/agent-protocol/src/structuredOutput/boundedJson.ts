import type {
  AgentJsonObject,
  AgentJsonValue,
  AgentProtocolParseResult,
  ValidationPathSegment,
} from '../foundation/types.js';
import { AGENT_OUTPUT_SCHEMA_PROPERTY_NAME_MAX_LENGTH } from './constants.js';
import { StructuredOutputIssues } from './issues.js';

export interface StructuredOutputJsonBounds {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxCollectionLength: number;
}

export function isJsonObject(value: AgentJsonValue): value is AgentJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function codePointLength(value: string): number {
  let length = 0;
  for (const _point of value) length += 1;
  return length;
}

export function isOutputPropertyName(value: string): boolean {
  return value.length > 0 && value.length <= 2 * AGENT_OUTPUT_SCHEMA_PROPERTY_NAME_MAX_LENGTH
    && value !== '__proto__' && value !== 'constructor' && value !== 'prototype'
    && codePointLength(value) <= AGENT_OUTPUT_SCHEMA_PROPERTY_NAME_MAX_LENGTH;
}

// Count directly rather than invoking stringify or allocating an encoded copy of untrusted text.
export function serializedStringBytes(value: string, stopAfter: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit <= 0x1f) bytes += [8, 9, 10, 12, 13].includes(unit) ? 2 : 6;
    else if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > stopAfter) break;
  }
  return bytes;
}

export function snapshotStructuredOutputJson(
  input: unknown,
  bounds: StructuredOutputJsonBounds,
): AgentProtocolParseResult<AgentJsonValue> {
  const issues = new StructuredOutputIssues();
  const active = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;

  function fail(code: string, message: string, path: readonly ValidationPathSegment[]): undefined {
    issues.add(code, message, path);
    return undefined;
  }

  function charge(amount: number, path: readonly ValidationPathSegment[]): boolean {
    bytes += amount;
    if (bytes <= bounds.maxBytes) return true;
    fail('output_limit_exceeded', 'JSON data exceeds the serialized UTF-8 byte limit.', path);
    return false;
  }

  function copy(value: unknown, depth: number, path: readonly ValidationPathSegment[]): AgentJsonValue | undefined {
    nodes += 1;
    if (nodes > bounds.maxNodes || depth > bounds.maxDepth) {
      return fail('output_limit_exceeded', 'JSON data exceeds the node or depth limit.', path);
    }
    if (value === null || typeof value === 'boolean') {
      return charge(value === null ? 4 : value ? 4 : 5, path) ? value : undefined;
    }
    if (typeof value === 'string') {
      return charge(serializedStringBytes(value, bounds.maxBytes - bytes), path) ? value : undefined;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return fail('invalid_json_data', 'JSON numbers must be finite.', path);
      return charge(JSON.stringify(value).length, path) ? value : undefined;
    }
    if (typeof value !== 'object') return fail('invalid_json_data', 'Only plain JSON data is accepted.', path);
    if (active.has(value)) return fail('invalid_json_data', 'JSON data must not contain cycles.', path);

    const array = Array.isArray(value);
    let keys: readonly PropertyKey[];
    let length = 0;
    try {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
        return fail('invalid_json_data', 'JSON data must use plain object and array prototypes.', path);
      }
      if (array) {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
        const arrayLength: unknown = descriptor?.value;
        if (!descriptor || !('value' in descriptor) || typeof arrayLength !== 'number'
          || !Number.isSafeInteger(arrayLength) || arrayLength < 0 || arrayLength > bounds.maxCollectionLength) {
          return fail('output_limit_exceeded', 'JSON arrays exceed the collection limit.', path);
        }
        length = arrayLength;
      }
      keys = Reflect.ownKeys(value);
    } catch {
      return fail('invalid_json_data', 'JSON data properties cannot be inspected safely.', path);
    }
    if (keys.length > bounds.maxCollectionLength + (array ? 1 : 0)) {
      return fail('output_limit_exceeded', 'JSON collections exceed the entry limit.', path);
    }
    if (array && keys.length !== length + 1) return fail('invalid_json_data', 'JSON arrays must be dense and have no extra properties.', path);

    const entries: Array<readonly [string, unknown]> = [];
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || (!array && !isOutputPropertyName(key))) {
        return fail('invalid_json_data', 'JSON object property names must be bounded and safe.', path);
      }
      if (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)) {
        return fail('invalid_json_data', 'JSON arrays must have only indexed entries.', path);
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        return fail('invalid_json_data', 'JSON data properties cannot be inspected safely.', path);
      }
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        return fail('invalid_json_data', 'JSON data must contain only enumerable data properties.', path);
      }
      const child: unknown = descriptor.value;
      entries.push([key, child]);
    }
    if (!charge(2 + Math.max(0, entries.length - 1), path)) return undefined;

    active.add(value);
    if (array) {
      const result: AgentJsonValue[] = [];
      for (const [key, child] of entries) {
        const copied = copy(child, depth + 1, [...path, Number(key)]);
        if (copied === undefined) return undefined;
        result.push(copied);
      }
      active.delete(value);
      return result;
    }
    const result: Record<string, AgentJsonValue> = {};
    for (const [key, child] of entries) {
      const childPath = [...path, key];
      if (!charge(serializedStringBytes(key, bounds.maxBytes - bytes) + 1, childPath)) return undefined;
      const copied = copy(child, depth + 1, childPath);
      if (copied === undefined) return undefined;
      result[key] = copied;
    }
    active.delete(value);
    return result;
  }

  const data = copy(input, 1, []);
  return data === undefined
    ? { success: false, issues: issues.issues }
    : { success: true, data };
}
