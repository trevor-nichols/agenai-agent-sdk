// ------------------------------------------------------------------------------------------------
//                canonical.ts - Canonical JSON form and immutability of usage values - No dependencies
// ------------------------------------------------------------------------------------------------

const UTF8 = new TextEncoder();

/** Sorted-key JSON; parsed observations already store reasons and rows in canonical order. */
export function canonicalUsageJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalUsageJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalUsageJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const usageJsonBytes = (canonical: string): number => UTF8.encode(canonical).byteLength;

export function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
