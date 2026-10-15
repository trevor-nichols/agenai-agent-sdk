export class NodeAcpExecutionCleanupError extends Error {
  readonly cleanupError: unknown;
  readonly retryCleanup: () => Promise<void>;

  constructor(input: Readonly<{ cause: unknown; cleanupError: unknown; retryCleanup: () => Promise<void> }>) {
    super('The owned Node ACP execution cleanup remains incomplete.', { cause: input.cause });
    this.name = 'NodeAcpExecutionCleanupError';
    this.cleanupError = input.cleanupError;
    this.retryCleanup = input.retryCleanup;
  }
}

export function isNodeAcpExecutionCleanupError(error: unknown): error is NodeAcpExecutionCleanupError {
  return error instanceof NodeAcpExecutionCleanupError;
}
