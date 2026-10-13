// ------------------------------------------------------------------------------------------------
//                limits.ts - Bounded ACP transport policy - Dependencies: none
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
//                Contracts
// ------------------------------------------------------------------------------------------------

export interface AcpProtocolLimits {
  readonly maxInboundFrameBytes: number;
  readonly maxOutboundFrameBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxObjectProperties: number;
  readonly maxArrayItems: number;
  readonly maxOutstandingRequests: number;
  readonly maxInboundRequestConcurrency: number;
  readonly maxNotificationHandlerConcurrency: number;
  readonly maxNotificationsPerWindow: number;
  readonly notificationWindowMs: number;
  readonly maxRequestIdBytes: number;
  readonly defaultRequestTimeoutMs: number;
  readonly maxRequestTimeoutMs: number;
  readonly maxOutboundBufferedBytes: number;
  readonly maxStderrBufferedBytes: number;
  readonly shutdownDrainMs: number;
}

export const DEFAULT_ACP_PROTOCOL_LIMITS: AcpProtocolLimits = Object.freeze({
  maxInboundFrameBytes: 8 * 1_024 * 1_024,
  maxOutboundFrameBytes: 8 * 1_024 * 1_024,
  maxJsonDepth: 48,
  maxJsonNodes: 65_536,
  maxObjectProperties: 4_096,
  maxArrayItems: 16_384,
  maxOutstandingRequests: 64,
  maxInboundRequestConcurrency: 16,
  maxNotificationHandlerConcurrency: 32,
  maxNotificationsPerWindow: 512,
  notificationWindowMs: 1_000,
  maxRequestIdBytes: 128,
  defaultRequestTimeoutMs: 30_000,
  maxRequestTimeoutMs: 30 * 60_000,
  maxOutboundBufferedBytes: 8 * 1_024 * 1_024 + 1,
  maxStderrBufferedBytes: 128 * 1_024,
  shutdownDrainMs: 2_000,
});

// ------------------------------------------------------------------------------------------------
//                Validation
// ------------------------------------------------------------------------------------------------

const LIMIT_BOUNDS: Readonly<Record<keyof AcpProtocolLimits, readonly [number, number]>> = {
  maxInboundFrameBytes: [1_024, 64 * 1_024 * 1_024],
  maxOutboundFrameBytes: [1_024, 64 * 1_024 * 1_024],
  maxJsonDepth: [4, 128],
  maxJsonNodes: [128, 1_000_000],
  maxObjectProperties: [16, 65_536],
  maxArrayItems: [16, 100_000],
  maxOutstandingRequests: [1, 1_024],
  maxInboundRequestConcurrency: [1, 256],
  maxNotificationHandlerConcurrency: [1, 1_024],
  maxNotificationsPerWindow: [1, 100_000],
  notificationWindowMs: [10, 60_000],
  maxRequestIdBytes: [8, 1_024],
  defaultRequestTimeoutMs: [10, 30 * 60_000],
  maxRequestTimeoutMs: [10, 60 * 60_000],
  maxOutboundBufferedBytes: [1_024, 64 * 1_024 * 1_024 + 1],
  maxStderrBufferedBytes: [1_024, 8 * 1_024 * 1_024],
  shutdownDrainMs: [0, 30_000],
};

export function resolveAcpProtocolLimits(
  overrides: Partial<AcpProtocolLimits> = {},
): AcpProtocolLimits {
  const unknownKeys = Object.keys(overrides).filter((key) => !(key in LIMIT_BOUNDS));
  if (unknownKeys.length > 0) throw new TypeError('ACP protocol limits contain unknown keys.');

  const resolved = { ...DEFAULT_ACP_PROTOCOL_LIMITS, ...overrides };
  for (const [key, [minimum, maximum]] of Object.entries(LIMIT_BOUNDS) as [
    keyof AcpProtocolLimits,
    readonly [number, number],
  ][]) {
    const value = resolved[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`ACP protocol limit ${key} is outside its supported range.`);
    }
  }
  if (resolved.defaultRequestTimeoutMs > resolved.maxRequestTimeoutMs) {
    throw new TypeError('ACP default request timeout exceeds the maximum timeout.');
  }
  if (resolved.maxOutboundBufferedBytes < resolved.maxOutboundFrameBytes + 1) {
    throw new TypeError(
      'ACP outbound buffer must hold one maximum-sized frame and its delimiter.',
    );
  }

  return Object.freeze(resolved);
}
