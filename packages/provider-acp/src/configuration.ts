export type AcpProviderConfiguration = Readonly<Record<string, never>>;

export function parseAcpProviderConfiguration(value: unknown): AcpProviderConfiguration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError('ACP driver configuration must be an empty object.');
  }
  return Object.freeze({});
}
