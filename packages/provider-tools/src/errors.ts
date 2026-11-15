// ------------------------------------------------------------------------------------------------
//                errors.ts - Typed owned-tool refusals and retained cleanup ownership
// ------------------------------------------------------------------------------------------------

export type NodeProviderToolsErrorCode =
  | 'invalid_options'
  | 'platform_unsupported'
  | 'identity_mismatch'
  | 'workspace_invalid'
  | 'workspace_leased'
  | 'namespace_unavailable'
  | 'helper_unavailable'
  | 'session_active'
  | 'closed';

export class NodeProviderToolsError extends Error {
  readonly code: NodeProviderToolsErrorCode;

  constructor(code: NodeProviderToolsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeProviderToolsError';
    this.code = code;
  }
}

/** Cleanup that could not settle. The original owner stays retained; only `retryCleanup` releases it. */
export class NodeProviderCleanupError extends Error {
  readonly cleanupError: unknown;
  readonly retryCleanup: () => Promise<void>;

  constructor(input: Readonly<{ message: string; cause?: unknown; cleanupError: unknown; retryCleanup: () => Promise<void> }>) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'NodeProviderCleanupError';
    this.cleanupError = input.cleanupError;
    this.retryCleanup = input.retryCleanup;
  }
}
