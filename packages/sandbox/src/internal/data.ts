// ------------------------------------------------------------------------------------------------
//                data.ts - Bounded plain-data capture without caller-owned mutable references
// ------------------------------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import { SandboxValidationError } from '../errors.js';

export function invalidInput(message: string, path: readonly (string | number)[] = []): never {
  throw new SandboxValidationError([{ code: 'invalid_input', path, message }]);
}

/** Capture plain data without invoking caller-controlled accessors or retaining mutable input. */
export function captureData(input: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  function capture(value: unknown, depth: number): unknown {
    nodes += 1;
    if (nodes > 8192 || depth > 16) invalidInput('Sandbox input exceeds structural bounds');
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > 1024 * 1024) invalidInput('Sandbox input exceeds text bounds');
      if (!value.isWellFormed()) invalidInput('Sandbox strings must contain well-formed Unicode');
      return value;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value;
    if (typeof value !== 'object') invalidInput('Sandbox inputs must contain plain data');
    if (seen.has(value)) invalidInput('Sandbox inputs cannot contain cycles');
    seen.add(value);
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) invalidInput('Sandbox inputs must contain plain objects');
    const keys = Reflect.ownKeys(value);
    if (keys.length > 8192) invalidInput('Sandbox input exceeds structural bounds');
    if (array) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) invalidInput('Sandbox arrays must be dense data arrays');
        result.push(capture(descriptor.value, depth + 1));
      }
      if (keys.length !== value.length + 1) invalidInput('Sandbox arrays cannot have extra properties');
      seen.delete(value);
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') invalidInput('Sandbox inputs cannot contain symbol keys');
      if (key === '__proto__') invalidInput('Sandbox inputs cannot contain prototype mutation keys');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalidInput('Sandbox inputs cannot contain accessors or hidden fields');
      result[key] = capture(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return result;
  }
  return capture(input, 0);
}

export function freezeData<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) value.forEach(freezeData);
    else Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}

export function utf8Within(value: string, maximum: number): boolean {
  return value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= maximum;
}
