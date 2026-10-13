// ------------------------------------------------------------------------------------------------
//                bounds.ts - Bounded inert input capture before schema validation
// ------------------------------------------------------------------------------------------------

import { invalidDelegationData } from "./errors.js";

export const DELEGATION_DOCUMENT_BYTES = 1_048_576;
export const DELEGATION_TARGET_BYTES = 32_768;
export const DELEGATION_ENTRIES = 1_000;

export function captureDelegationRecord(input: unknown, path: readonly (string | number)[] = []): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    return invalidDelegationData("invalid_data", path, "Delegation objects must be plain data records.");
  }
  const result: Record<string, unknown> = {};
  const keys = Reflect.ownKeys(input);
  if (keys.length > DELEGATION_ENTRIES) invalidDelegationData("entry_limit", path, "Delegation object has too many properties.");
  for (const key of keys) {
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) {
      invalidDelegationData("invalid_data", path, "Delegation property names must be safe strings.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      invalidDelegationData("invalid_data", [...path, key], "Delegation properties must be enumerable data properties.");
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function copyBoundedDelegationData(input: unknown): unknown {
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  let bytes = 0;
  const reserve = (count: number, path: readonly (string | number)[]): void => {
    bytes += count;
    if (bytes > DELEGATION_DOCUMENT_BYTES) invalidDelegationData("byte_limit", path, "Delegation data exceeds 1 MiB of serialized JSON.");
  };
  const visit = (value: unknown, path: readonly (string | number)[], depth: number): unknown => {
    if (depth > 16) invalidDelegationData("depth_limit", path, "Delegation data exceeds its nesting limit.");
    if (typeof value === "string") {
      if (value.length > DELEGATION_DOCUMENT_BYTES) invalidDelegationData("byte_limit", path, "Delegation string exceeds its byte limit.");
      reserve(encoder.encode(JSON.stringify(value)).byteLength, path);
      return value;
    }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      reserve(JSON.stringify(value).length, path);
      return value;
    }
    if (typeof value !== "object") invalidDelegationData("invalid_data", path, "Delegation data must contain only finite JSON values.");
    if (ancestors.has(value)) invalidDelegationData("invalid_data", path, "Delegation data cannot contain cycles.");
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value as number;
      if (Object.getPrototypeOf(value) !== Array.prototype || length > DELEGATION_ENTRIES || keys.length !== length + 1) {
        invalidDelegationData("invalid_data", path, "Delegation arrays must be dense, bounded and free of extra properties.");
      }
      const entries = new Array<unknown>(length);
      reserve(2 + Math.max(0, length - 1), path);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
          invalidDelegationData("invalid_data", path, "Delegation arrays cannot carry extra properties.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          invalidDelegationData("invalid_data", [...path, Number(key)], "Delegation array entries must be data properties.");
        }
        entries[Number(key)] = visit(descriptor.value, [...path, Number(key)], depth + 1);
      }
      result = entries;
    } else {
      const record = captureDelegationRecord(value, path);
      const entries = Object.entries(record);
      reserve(2 + Math.max(0, entries.length - 1), path);
      for (const [key, child] of entries) {
        reserve(encoder.encode(JSON.stringify(key)).byteLength + 1, path);
        record[key] = visit(child, [...path, key], depth + 1);
      }
      result = record;
    }
    ancestors.delete(value);
    return result;
  };
  return visit(input, [], 0);
}
