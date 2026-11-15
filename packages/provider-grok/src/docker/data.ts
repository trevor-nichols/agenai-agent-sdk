export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object') invalid();
  const captured = descriptors(value, required, optional);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(captured)) result[key] = dataValue(descriptor);
  return result;
}

/** Typed snapshots preserve opaque authority handles without reading caller properties again. */
export function descriptors<T extends object>(value: T, required: readonly string[], optional: readonly string[] = []) {
  if (value === null || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null)) invalid();
  const captured = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(captured)) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) invalid();
  }
  if (required.some((key) => !Object.hasOwn(captured, key))) invalid();
  return captured;
}

export function dataValue<T>(descriptor: TypedPropertyDescriptor<T>): T {
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) invalid();
  return descriptor.value;
}

export function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}

export function invalid(): never { throw new TypeError('Invalid controlled Grok Docker input.'); }
