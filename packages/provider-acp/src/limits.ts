export interface AcpProviderLimits {
  readonly maxQueuedMessages: number;
  readonly maxQueuedBytes: number;
  readonly maxPendingRequests: number;
  readonly maxHostTerminals: number;
  readonly hostOperationTimeoutMs: number;
  readonly authenticationTimeoutMs: number;
  readonly cancellationTimeoutMs: number;
  readonly initializationTimeoutMs: number;
  readonly promptTimeoutMs: number;
}

export const DEFAULT_ACP_PROVIDER_LIMITS: AcpProviderLimits = Object.freeze({
  maxQueuedMessages: 128,
  maxQueuedBytes: 8 * 1_024 * 1_024,
  maxPendingRequests: 16,
  maxHostTerminals: 16,
  hostOperationTimeoutMs: 30_000,
  authenticationTimeoutMs: 15 * 60_000,
  cancellationTimeoutMs: 5_000,
  initializationTimeoutMs: 30_000,
  promptTimeoutMs: 30 * 60_000,
});

const BOUNDS: Readonly<Record<keyof AcpProviderLimits, readonly [number, number]>> = {
  maxQueuedMessages: [4, 1_024],
  maxQueuedBytes: [128 * 1_024, 64 * 1_024 * 1_024],
  maxPendingRequests: [1, 256],
  maxHostTerminals: [1, 128],
  hostOperationTimeoutMs: [10, 30 * 60_000],
  authenticationTimeoutMs: [10, 30 * 60_000],
  cancellationTimeoutMs: [10, 60_000],
  initializationTimeoutMs: [10, 30 * 60_000],
  promptTimeoutMs: [10, 30 * 60_000],
};

export function resolveAcpProviderLimits(
  overrides: Partial<AcpProviderLimits> = {},
): AcpProviderLimits {
  if (Object.keys(overrides).some((key) => !Object.hasOwn(BOUNDS, key))) {
    throw new TypeError('ACP provider limits contain unknown keys.');
  }
  const limits = { ...DEFAULT_ACP_PROVIDER_LIMITS, ...overrides };
  for (const key of Object.keys(BOUNDS) as (keyof AcpProviderLimits)[]) {
    const [minimum, maximum] = BOUNDS[key];
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > maximum) {
      throw new TypeError(`ACP provider limit ${key} is outside its supported range.`);
    }
  }
  if (limits.maxPendingRequests > limits.maxQueuedMessages - 2) {
    throw new TypeError('ACP request capacity must leave room for output and terminal control.');
  }
  return Object.freeze(limits);
}
