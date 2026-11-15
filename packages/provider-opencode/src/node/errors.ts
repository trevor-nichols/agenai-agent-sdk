// ------------------------------------------------------------------------------------------------
//                errors.ts - Public OpenCode driver and native composition failures
// ------------------------------------------------------------------------------------------------

export class NodeOpenCodeProviderError extends Error {
  constructor(readonly code: 'session_active' | 'closed' | 'invalid_session', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeOpenCodeProviderError';
  }
}

/** The owned native server, its plugin endpoint or its event source failed or did not prove readiness. */
export class NativeFailure extends Error {
  constructor(readonly stage: 'startup' | 'readiness' | 'runtime' | 'transport' | 'capacity', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeOpenCodeNativeFailure';
  }
}
