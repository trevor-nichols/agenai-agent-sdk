export function deepFreeze<Value>(value: Value): Readonly<Value> {
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(value);
  return value;
}
