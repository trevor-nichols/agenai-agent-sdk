// ------------------------------------------------------------------------------------------------
//                errors.ts - Public Claude driver and worker failures
// ------------------------------------------------------------------------------------------------

export class NodeClaudeProviderError extends Error {
  constructor(readonly code: 'session_active' | 'closed' | 'invalid_session' | 'not_ready', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeClaudeProviderError';
  }
}

export class WorkerFailure extends Error {
  constructor(readonly stage: 'startup' | 'runtime' | 'transport', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeClaudeWorkerFailure';
  }
}
