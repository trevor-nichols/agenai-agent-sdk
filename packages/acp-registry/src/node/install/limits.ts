import type { AcpInstallationLimits } from './contracts.js';
import { AcpInstallationError } from './errors.js';

const MiB = 1_024 * 1_024;
export const DEFAULT_ACP_INSTALLATION_LIMITS: AcpInstallationLimits = Object.freeze({
  maxArtifactBytes: 256 * MiB, maxTotalArtifactBytes: 1_024 * MiB, maxPayloadBytes: 1_024 * MiB,
  maxDecompressedBytes: 2_048 * MiB, maxEntries: 25_000, maxPathDepth: 32, maxPathBytes: 4_096,
  maxDownloadRedirects: 3, artifactTimeoutMs: 120_000, toolTimeoutMs: 120_000,
  maxToolOutputBytes: MiB, maxReceiptBytes: 16 * MiB, maxReferences: 1_024,
});
const maxima: AcpInstallationLimits = Object.freeze({
  maxArtifactBytes: 2_048 * MiB, maxTotalArtifactBytes: 8_192 * MiB, maxPayloadBytes: 8_192 * MiB,
  maxDecompressedBytes: 16_384 * MiB, maxEntries: 100_000, maxPathDepth: 64, maxPathBytes: 8_192,
  maxDownloadRedirects: 8, artifactTimeoutMs: 600_000, toolTimeoutMs: 600_000,
  maxToolOutputBytes: 16 * MiB, maxReceiptBytes: 64 * MiB, maxReferences: 10_000,
});

export function resolveAcpInstallationLimits(input: Partial<AcpInstallationLimits> = {}): AcpInstallationLimits {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new AcpInstallationError('invalid_input', 'Installation limits require a plain object.');
  const resolved = { ...DEFAULT_ACP_INSTALLATION_LIMITS };
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !Object.hasOwn(maxima, key)) throw new AcpInstallationError('invalid_input', 'Unknown installation limit.');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    const value: unknown = descriptor?.value;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < (key === 'maxDownloadRedirects' ? 0 : 1) || value > maxima[key as keyof AcpInstallationLimits]) {
      throw new AcpInstallationError('invalid_input', 'Installation limits must be finite integers within the supported range.');
    }
    resolved[key as keyof AcpInstallationLimits] = value;
  }
  return Object.freeze(resolved);
}
