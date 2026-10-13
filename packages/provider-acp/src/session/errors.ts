export class AcpProviderSessionError extends Error {
  constructor(readonly reasonCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcpProviderSessionError';
  }
}

export function sessionError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new AcpProviderSessionError('acp_session_failed', 'The ACP session failed.');
}
