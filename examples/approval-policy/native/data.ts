import { isAbsolute, normalize } from 'node:path';

export class NativeExampleError extends Error {
  constructor(readonly code: 'invalid_input' | 'reservation_refused' | 'artifact_failed' | 'run_failed' | 'output_limit' | 'tool_action_limit' | 'residual_refused' | 'cleanup_pending') {
    super('The explicit native example did not complete; consult its safe status and original cleanup record.');
    this.name = 'NativeExampleError';
  }
}
export function invalid(): never { throw new NativeExampleError('invalid_input'); }
export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) invalid();
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}
export function text(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length < 1 || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
export function path(value: unknown): string {
  const selected = text(value);
  if (!isAbsolute(selected) || normalize(selected) !== selected || selected === '/' || selected.endsWith('/')) invalid();
  return selected;
}
export function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
export function literal<T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) invalid();
  return expected;
}
export function sha(value: unknown): string {
  const selected = text(value, 64); if (!/^[a-f0-9]{64}$/u.test(selected)) invalid(); return selected;
}
export function digest(value: unknown): string {
  const selected = text(value, 71); if (!/^sha256:[a-f0-9]{64}$/u.test(selected)) invalid(); return selected;
}
export function token(value: unknown): string {
  const selected = text(value, 64); if (!/^[a-z][a-z0-9-]{0,63}$/u.test(selected)) invalid(); return selected;
}
