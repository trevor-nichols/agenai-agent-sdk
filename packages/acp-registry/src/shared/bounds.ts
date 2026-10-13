import type { AcpRegistryLimits } from '../catalog/contracts.js';
import { invalidRegistry } from './errors.js';

export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function boundedString(value: string, path: readonly (string | number)[], limits: AcpRegistryLimits): void {
  if (value.length > limits.maxStringBytes || utf8Bytes(value) > limits.maxStringBytes) invalidRegistry('string_limit', path, 'Registry string exceeds its byte limit.');
  if (value.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    invalidRegistry('invalid_string', path, 'Registry strings cannot contain NUL or unpaired Unicode surrogates.');
  }
}

/** Descriptor reads reject accessors before schema validation can read untrusted properties. */
export function copyBoundedJson(input: unknown, limits: AcpRegistryLimits): unknown {
  let values = 0;
  let bytes = 0;
  const reserve = (count: number, path: readonly (string | number)[]) => {
    bytes += count;
    if (bytes > limits.maxSnapshotBytes) invalidRegistry('byte_limit', path, 'Registry JSON exceeds its aggregate byte limit.');
  };
  const ancestors = new Set<object>();
  const visit = (value: unknown, path: readonly (string | number)[], depth: number): unknown => {
    if (++values > limits.maxValues) invalidRegistry('value_limit', path, 'Registry value count exceeds its limit.');
    if (depth > limits.maxDepth) invalidRegistry('depth_limit', path, 'Registry nesting exceeds its limit.');
    if (typeof value === 'string') { boundedString(value, path, limits); reserve(utf8Bytes(JSON.stringify(value)), path); return value; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { reserve(JSON.stringify(value).length, path); return value; }
    if (typeof value !== 'object') invalidRegistry('invalid_json_value', path, 'Registry values must be finite plain JSON.');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) invalidRegistry('invalid_json_value', path, 'Registry objects must have plain JSON prototypes.');
    if (ancestors.has(value)) invalidRegistry('invalid_json_value', path, 'Registry values cannot contain cycles.');
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = array ? Object.getOwnPropertyDescriptor(value, 'length') : undefined;
    const length: unknown = lengthDescriptor?.value;
    if (array && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > limits.maxValues || keys.length !== length + 1)) {
      invalidRegistry('invalid_json_value', path, 'Registry arrays must be dense, bounded and free of extra properties.');
    }
    const result = array ? new Array<unknown>(length as number) : {};
    reserve(2 + Math.max(0, keys.length - (array ? 2 : 1)), path);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') invalidRegistry('invalid_json_value', path, 'Registry values cannot contain symbol properties.');
      if (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= (length as number))) invalidRegistry('invalid_json_value', path, 'Registry arrays cannot carry extra properties.');
      boundedString(key, path, limits);
      if (!array) reserve(utf8Bytes(JSON.stringify(key)) + 1, path);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidRegistry('invalid_json_value', [...path, key], 'Registry properties must be enumerable data properties.');
      const child = visit(descriptor.value, [...path, array ? Number(key) : key], depth + 1);
      Object.defineProperty(result, key, { value: child, enumerable: true, configurable: true, writable: true });
    }
    ancestors.delete(value);
    return result;
  };
  return visit(input, [], 0);
}

/** Checks nesting and duplicate decoded keys before JSON.parse allocates the complete tree. */
export function parseBoundedRegistryJson(content: string, limits: AcpRegistryLimits): unknown {
  let position = content.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let values = 0;
  const scalar = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/uy;
  const whitespace = () => { while (/[\t\n\r ]/u.test(content[position] ?? '') && position < content.length) position++; };
  const malformed = (): never => invalidRegistry('invalid_json', [], 'Registry content is not valid JSON.');
  const string = (path: readonly (string | number)[]): string => {
    const start = position++;
    while (position < content.length) {
      const character = content[position++];
      if (character === '\\') { position++; continue; }
      if (character === '"') {
        let value: unknown;
        try { value = JSON.parse(content.slice(start, position)); } catch { return malformed(); }
        if (typeof value !== 'string') return malformed();
        boundedString(value, path, limits);
        return value;
      }
    }
    return malformed();
  };
  const value = (path: readonly (string | number)[], depth: number): void => {
    if (++values > limits.maxValues) invalidRegistry('value_limit', path, 'Registry value count exceeds its limit.');
    if (depth > limits.maxDepth) invalidRegistry('depth_limit', path, 'Registry nesting exceeds its limit.');
    whitespace();
    const character = content[position];
    if (character === '"') { string(path); return; }
    if (character === '{' || character === '[') {
      const object = character === '{';
      const end = object ? '}' : ']';
      const keys = new Set<string>();
      position++; whitespace();
      if (content[position] === end) { position++; return; }
      let index = 0;
      for (;;) {
        whitespace();
        let segment: string | number = index++;
        if (object) {
          if (content[position] !== '"') return malformed();
          segment = string(path);
          if (keys.has(segment)) invalidRegistry('duplicate_key', [...path, segment], 'Registry JSON contains a duplicate object key.');
          keys.add(segment);
          whitespace();
          if (content[position++] !== ':') return malformed();
        }
        value([...path, segment], depth + 1);
        whitespace();
        const next = content[position++];
        if (next === end) return;
        if (next !== ',') return malformed();
      }
    }
    scalar.lastIndex = position;
    const token = scalar.exec(content)?.[0];
    if (!token) return malformed();
    if (/^[-0-9]/u.test(token) && !Number.isFinite(Number(token))) invalidRegistry('invalid_json_value', path, 'Registry JSON numbers must be finite.');
    position += token.length;
  };
  value([], 0); whitespace();
  if (position !== content.length) malformed();
  let parsed: unknown;
  try { parsed = JSON.parse(content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content); } catch { return malformed(); }
  return parsed;
}
