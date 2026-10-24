import { invalidHistoryData } from './errors.js';

export const AGENT_HISTORY_MAX_PAGE_RECORDS = 100;
export const AGENT_HISTORY_MAX_PAGE_BYTES = 1_048_576;
export const AGENT_HISTORY_MAX_CURSOR_BYTES = 65_536;
export const AGENT_HISTORY_MAX_SOURCE_ID_LENGTH = 128;
export const AGENT_HISTORY_MAX_CONTENT_BLOCKS = 1_000;
const MAX_VALUES = 50_000;
const MAX_DEPTH = 16;
const encoder = new TextEncoder();

export function captureHistoryData(input: unknown): unknown {
  const ancestors = new Set<object>();
  let bytes = 0;
  let values = 0;
  const reserve = (size: number, path: readonly (string | number)[]) => {
    bytes += size;
    if (bytes > AGENT_HISTORY_MAX_PAGE_BYTES) invalidHistoryData('byte_limit', path, 'History data exceeds 1 MiB of serialized UTF-8 JSON.');
  };
  const visit = (value: unknown, path: readonly (string | number)[], depth: number): unknown => {
    values += 1;
    if (values > MAX_VALUES) invalidHistoryData('value_limit', path, 'History data contains too many values.');
    if (depth > MAX_DEPTH) invalidHistoryData('depth_limit', path, 'History data exceeds its nesting limit.');
    if (typeof value === 'string') {
      if (value.length > AGENT_HISTORY_MAX_PAGE_BYTES) invalidHistoryData('byte_limit', path, 'History text exceeds its byte ceiling.');
      reserve(encoder.encode(JSON.stringify(value)).byteLength, path);
      return value;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      reserve(JSON.stringify(value).length, path);
      return value;
    }
    if (typeof value !== 'object') invalidHistoryData('invalid_data', path, 'History data must contain finite JSON values.');
    if (ancestors.has(value)) invalidHistoryData('invalid_data', path, 'History data cannot contain cycles.');
    let array: boolean;
    let prototype: unknown;
    let descriptors: Record<string, PropertyDescriptor>;
    try {
      array = Array.isArray(value);
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return invalidHistoryData('invalid_data', path, 'History data cannot contain objects that reject inspection.');
    }
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
      invalidHistoryData('invalid_data', path, 'History data must use plain records and arrays.');
    }
    const keys = Reflect.ownKeys(descriptors);
    const length: unknown = array ? descriptors.length?.value : undefined;
    if (array && (typeof length !== 'number' || !Number.isSafeInteger(length) || length > AGENT_HISTORY_MAX_CONTENT_BLOCKS || keys.length !== length + 1)) {
      invalidHistoryData('entry_limit', path, 'History arrays must be dense, bounded and free of extra properties.');
    }
    if (!array && keys.length > AGENT_HISTORY_MAX_CONTENT_BLOCKS) invalidHistoryData('entry_limit', path, 'History record has too many properties.');
    ancestors.add(value);
    const captured: Record<string, unknown> = {};
    const entries: unknown[] = [];
    reserve(2, path);
    let retained = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        invalidHistoryData('invalid_data', path, 'History property names must be safe strings.');
      }
      if (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || (typeof length !== 'number' || Number(key) >= length))) {
        invalidHistoryData('invalid_data', path, 'History arrays cannot contain extra properties.');
      }
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        invalidHistoryData('invalid_data', [...path, key], 'History properties must be enumerable data properties.');
      }
      if (!array && descriptor.value === undefined) continue;
      if (retained > 0) reserve(1, path);
      retained += 1;
      const childPath = [...path, array ? Number(key) : key];
      if (!array) reserve(encoder.encode(JSON.stringify(key)).byteLength + 1, path);
      const child = visit(descriptor.value, childPath, depth + 1);
      if (array) entries[Number(key)] = child;
      else captured[key] = child;
    }
    ancestors.delete(value);
    return array ? entries : captured;
  };
  return visit(input, [], 0);
}

export function freezeHistoryData<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeHistoryData(child);
    Object.freeze(value);
  }
  return value;
}
