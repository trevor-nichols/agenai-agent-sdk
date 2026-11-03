import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod/v4';

export function preparedHelperSchema<const Protocol extends string>(protocol: Protocol) {
  return z.strictObject({
    protocol: z.literal(protocol),
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    executable: z.strictObject({
      path: z.string().refine((value) => value.isWellFormed() && Buffer.byteLength(value) <= 4096 && isAbsolute(value)
        && normalize(value) === value && !value.endsWith('/') && !/\p{Cc}/u.test(value), 'Canonical absolute physical executable path required'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  });
}

export function captureDataFields(input: unknown, allowed: readonly string[], context: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new TypeError(`${context} requires plain data objects.`);
  }
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !property?.enumerable || !('value' in property)) {
      throw new TypeError(`${context} rejects unknown fields and accessors.`);
    }
    captured[key] = property.value;
  }
  return captured;
}
