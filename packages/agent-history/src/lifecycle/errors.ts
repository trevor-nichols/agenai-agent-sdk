export type AgentHistoryErrorCode =
  | 'invalid_input' | 'invalid_cursor' | 'wrong_source' | 'not_found' | 'access_denied'
  | 'unsupported_scope' | 'closed' | 'cancelled' | 'deadline_exceeded'
  | 'busy' | 'limit_exhausted' | 'native_failure' | 'cleanup_failed';

export class AgentHistoryError extends Error {
  constructor(readonly code: AgentHistoryErrorCode, message: string) {
    super(message.slice(0, 1024));
    this.name = 'AgentHistoryError';
  }
}

export class AgentHistoryCleanupError extends AgentHistoryError {
  constructor(private readonly retry: () => Promise<void>) {
    super('cleanup_failed', 'History cleanup is incomplete; retain the source and retry cleanup.');
    this.name = 'AgentHistoryCleanupError';
  }

  retryCleanup(): Promise<void> {
    return this.retry();
  }
}

export class OperationFailure extends Error {
  constructor(readonly error: AgentHistoryError, readonly dispatched: boolean) {
    super(error.message);
    this.name = 'OperationFailure';
  }
}
