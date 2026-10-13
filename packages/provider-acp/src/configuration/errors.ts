export class AcpConfigurationError extends Error {
  constructor(readonly reasonCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcpConfigurationError';
  }
}

export function invalidConfigurationCatalog(): never {
  throw new AcpConfigurationError('acp_configuration_catalog_invalid', 'ACP configuration cannot be represented faithfully within the declared bounds.');
}
