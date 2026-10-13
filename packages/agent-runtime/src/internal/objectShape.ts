// ------------------------------------------------------------------------------------------------
//                objectShape.ts - Closed provider boundary shape checks
// ------------------------------------------------------------------------------------------------

export function hasExactOwnKeys(candidate: object, expectedKeys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(candidate);
  return ownKeys.length === expectedKeys.length
    && ownKeys.every((key) => typeof key === "string" && expectedKeys.includes(key));
}
