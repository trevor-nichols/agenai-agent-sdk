export function invalidClaudeInput(): never {
  throw new TypeError('Unsupported or malformed contained Claude configuration.');
}

/** Snapshot data properties without invoking accessors or disclosing thrown caller values. */
export function claudeFields(input: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  try {
    if (typeof input !== 'object' || input === null || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalidClaudeInput();
    const data: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) invalidClaudeInput();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidClaudeInput();
      data[key] = descriptor.value;
    }
    return data;
  } catch { invalidClaudeInput(); }
}
