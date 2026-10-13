import { AcpRegistryFetchError, type FetchAcpRegistrySnapshotInput } from './contracts.js';

export interface RegistryFetchPolicy {
  readonly trustedOrigins: ReadonlySet<string>;
  readonly allowInsecureHttp: boolean;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
}

export function resolveFetchPolicy(input: FetchAcpRegistrySnapshotInput): RegistryFetchPolicy {
  const { trustedOrigins: suppliedOrigins, allowInsecureHttp, timeoutMs: suppliedTimeout, maxRedirects: suppliedRedirects } = input;
  if (!Array.isArray(suppliedOrigins)) {
    throw new AcpRegistryFetchError('invalid_fetch_policy', 'Provide between one and 32 exact trusted origins.');
  }
  const originCount = suppliedOrigins.length;
  if (!Number.isSafeInteger(originCount) || originCount < 1 || originCount > 32) {
    throw new AcpRegistryFetchError('invalid_fetch_policy', 'Provide between one and 32 exact trusted origins.');
  }
  const trustedOrigins = new Set<string>();
  for (let index = 0; index < originCount; index += 1) {
    const origin: unknown = suppliedOrigins[index];
    let url: URL;
    try {
      if (typeof origin !== 'string' || origin.length > 2_048) throw new Error('Invalid origin.');
      url = new URL(origin);
    } catch {
      throw new AcpRegistryFetchError('invalid_fetch_policy', 'A trusted origin must be an absolute HTTP or HTTPS URL origin.');
    }
    if (!['https:', 'http:'].includes(url.protocol) || origin !== url.origin) {
      throw new AcpRegistryFetchError('invalid_fetch_policy', 'Trusted origins must be canonical and contain no path, query, fragment or credentials.');
    }
    trustedOrigins.add(origin);
  }
  if (allowInsecureHttp !== undefined && typeof allowInsecureHttp !== 'boolean') {
    throw new AcpRegistryFetchError('invalid_fetch_policy', 'allowInsecureHttp must be a boolean.');
  }
  const timeoutMs = suppliedTimeout ?? 15_000;
  const maxRedirects = suppliedRedirects ?? 3;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new AcpRegistryFetchError('invalid_fetch_policy', 'timeoutMs must be between 1 and 300000.');
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 8) {
    throw new AcpRegistryFetchError('invalid_fetch_policy', 'maxRedirects must be between zero and eight.');
  }
  return { trustedOrigins, allowInsecureHttp: allowInsecureHttp === true, timeoutMs, maxRedirects };
}

export function assertFetchUrl(url: URL, policy: RegistryFetchPolicy): void {
  if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol)) {
    throw new AcpRegistryFetchError('invalid_redirect', 'Registry requests require HTTP or HTTPS URLs without credentials or fragments.');
  }
  if (url.protocol === 'http:' && !policy.allowInsecureHttp) {
    throw new AcpRegistryFetchError('insecure_transport', 'HTTP registry fetching requires explicit allowInsecureHttp policy.');
  }
  if (!policy.trustedOrigins.has(url.origin)) {
    throw new AcpRegistryFetchError('untrusted_origin', 'The registry request origin is not explicitly trusted.');
  }
}

export function redirectUrl(location: string | null, current: URL): URL {
  if (!location || location.length > 8_192 || /[\u0000-\u0020\u007f\\]/u.test(location)) {
    throw new AcpRegistryFetchError('invalid_redirect', 'The registry returned a missing or unsafe redirect location.');
  }
  try {
    return new URL(location, current);
  } catch {
    throw new AcpRegistryFetchError('invalid_redirect', 'The registry returned an invalid redirect URL.');
  }
}
