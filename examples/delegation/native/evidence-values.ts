// ------------------------------------------------------------------------------------------------
//                evidence-values.ts - Bounded plain JSON values before evidence parsing
// ------------------------------------------------------------------------------------------------

import { canonicalJson, NativeInputError } from './json.js';

/** Inspect descriptors before reading fields so report parsing never invokes supplied accessors. */
export function assertBoundedNativeEvidence(value: unknown, maximum: number): void {
  const requireFact: (condition: unknown) => asserts condition = (condition) => {
    if (!condition) throw new NativeInputError('qualification_evidence_invalid');
  };
  let nodes = 0, stringBytes = 0, keyBytes = 0;
  const visit = (item: unknown, depth: number): void => {
    requireFact(++nodes <= 50_000 && depth <= 16);
    if (typeof item === 'string') { stringBytes += Buffer.byteLength(item); requireFact(stringBytes <= 65_536); return; }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { requireFact(Number.isFinite(item)); return; }
    requireFact(typeof item === 'object' && item !== null);
    const list = Array.isArray(item);
    requireFact(list || Object.getPrototypeOf(item) === Object.prototype);
    const keys = Reflect.ownKeys(item);
    requireFact(keys.length <= 50_000);
    if (list) requireFact(keys.length === item.length + 1);
    for (const key of keys) {
      requireFact(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key));
      if (list && key === 'length') continue;
      keyBytes += Buffer.byteLength(key); requireFact(keyBytes + stringBytes <= maximum);
      if (list) requireFact(/^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < item.length);
      const field = Object.getOwnPropertyDescriptor(item, key);
      requireFact(field?.enumerable && Object.hasOwn(field, 'value'));
      visit(field.value, depth + 1);
    }
  };
  visit(value, 0);
  requireFact(Buffer.byteLength(canonicalJson(value)) <= maximum);
}
