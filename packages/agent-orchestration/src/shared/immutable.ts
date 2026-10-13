// ------------------------------------------------------------------------------------------------
//                immutable.ts - Freeze parser-owned JSON trees
// ------------------------------------------------------------------------------------------------

export function freezeDelegationData<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDelegationData(child);
    Object.freeze(value);
  }
  return value;
}
