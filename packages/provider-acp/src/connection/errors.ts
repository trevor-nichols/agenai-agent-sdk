export class AcpProviderConnectionError extends Error {
  constructor(readonly reasonCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcpProviderConnectionError';
  }
}
