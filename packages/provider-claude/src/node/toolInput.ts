// ------------------------------------------------------------------------------------------------
//                toolInput.ts - Bounded serialized-byte accounting before a native call is retained
// ------------------------------------------------------------------------------------------------

/** Counts the SDK's schema-parsed JSON input without allocating an escaped copy. Includes the newline. */
export function toolCallBytes(message: unknown, limit: number): number {
  let bytes = 1;
  const add = (count: number) => {
    bytes += count;
    if (bytes > limit) throw new RangeError('Owned tool input exceeds the pending byte budget. Split large patches into smaller calls.');
  };
  const string = (value: string) => {
    add(Buffer.byteLength(value) + 2);
    // In Unicode mode a surrogate pair is one code point and does not match this class.
    for (const match of value.matchAll(/[\u0000-\u001f"\\\ud800-\udfff]/gu)) {
      const code = match[0].charCodeAt(0);
      add(code >= 0xd800 ? 3 : code < 0x20 && ![8, 9, 10, 12, 13].includes(code) ? 5 : 1);
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) throw new TypeError('Owned tool input is nested too deeply.');
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { string(value); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(String(value).length); return; }
    if (Array.isArray(value)) {
      add(2 + Math.max(0, value.length - 1));
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new TypeError('Owned tool input must be JSON data.');
    }
    add(2);
    let members = 0;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (members++ > 0) add(1);
      string(key);
      add(1);
      visit(item, depth + 1);
    }
  };
  visit(message, 0);
  return bytes;
}
