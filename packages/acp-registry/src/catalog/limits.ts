import type { AcpRegistryLimits } from './contracts.js';
import { invalidRegistry } from '../shared/errors.js';

export const DEFAULT_ACP_REGISTRY_LIMITS: AcpRegistryLimits = Object.freeze({
  maxSnapshotBytes: 8 * 1_024 * 1_024,
  maxEntries: 1_024,
  maxDepth: 16,
  maxValues: 200_000,
  maxStringBytes: 16 * 1_024,
  maxArgs: 128,
  maxEnvEntries: 128,
});

export const MAX_ACP_REGISTRY_LIMITS: AcpRegistryLimits = Object.freeze({
  maxSnapshotBytes: 64 * 1_024 * 1_024, maxEntries: 10_000, maxDepth: 64,
  maxValues: 1_000_000, maxStringBytes: 1_024 * 1_024, maxArgs: 1_024, maxEnvEntries: 1_024,
});

export function resolveAcpRegistryLimits(input: Partial<AcpRegistryLimits> = {}): AcpRegistryLimits {
  if (input === null || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) invalidRegistry('invalid_limits', ['limits'], 'Registry limits must be a plain object.');
  const resolved = { ...DEFAULT_ACP_REGISTRY_LIMITS };
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !Object.hasOwn(MAX_ACP_REGISTRY_LIMITS, key)) invalidRegistry('invalid_limits', ['limits'], 'Unknown registry limit.');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidRegistry('invalid_limits', ['limits', key], 'Registry limits require enumerable data properties.');
    const value: unknown = descriptor.value;
    const minimum = key === 'maxArgs' || key === 'maxEnvEntries' ? 0 : 1;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_ACP_REGISTRY_LIMITS[key as keyof AcpRegistryLimits]) {
      invalidRegistry('invalid_limits', ['limits', key], 'Registry limit is outside its supported finite range.');
    }
    resolved[key as keyof AcpRegistryLimits] = value;
  }
  return Object.freeze(resolved);
}
