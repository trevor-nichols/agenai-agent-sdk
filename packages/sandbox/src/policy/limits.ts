// ------------------------------------------------------------------------------------------------
//                limits.ts - Finite sandbox admission ceilings and explicit starter limits
// ------------------------------------------------------------------------------------------------

export const SANDBOX_LIMITS = Object.freeze({
  maxTransferChunkBytes: 64 * 1024,
  maxMetadataBatchBytes: 4 * 1024 * 1024,
  maxMetadataMergeFanIn: 32,
  maxPathBytes: 1024,
  maxPathSegments: 64,
  maxPathSegmentBytes: 255,
  maxArgs: 128,
  maxEnvEntries: 128,
  maxEnvValueBytes: 16 * 1024,
  maxRecipeBytes: 256 * 1024,
  maxBufferedOutputBytes: 8 * 1024 * 1024,
  maxBufferedInputBytes: 8 * 1024 * 1024,
  highWaterMarkBytes: 64 * 1024,
  startupMs: 60_000,
  cleanupMs: 30_000,
  maxRecoveryBytes: 64 * 1024,
  maxIdentityBytes: 256,
  maxNamespaceBytes: 64,
});

export const SANDBOX_DEFAULT_TRANSFER_BUFFERS = Object.freeze({
  chunkBytes: SANDBOX_LIMITS.maxTransferChunkBytes,
  metadataBatchBytes: 64 * 1024,
  metadataMergeFanIn: 8,
});

export const SANDBOX_DEFAULT_STREAM_LIMITS = Object.freeze({
  maxBufferedInputBytes: SANDBOX_LIMITS.maxBufferedInputBytes,
  maxBufferedOutputBytes: SANDBOX_LIMITS.maxBufferedOutputBytes,
  highWaterMarkBytes: SANDBOX_LIMITS.highWaterMarkBytes,
});
