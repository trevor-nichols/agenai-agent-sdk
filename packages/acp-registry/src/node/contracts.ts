import type { AcpRegistryLimits, AcpRegistrySnapshot, AcpRegistrySource } from '../catalog/contracts.js';

export interface FetchAcpRegistrySnapshotInput {
  readonly source: AcpRegistrySource;
  /** Exact URL origins trusted for the initial request and every redirect. */
  readonly trustedOrigins: readonly string[];
  /** HTTP is rejected unless this is true and its exact origin is trusted. */
  readonly allowInsecureHttp?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly limits?: Partial<AcpRegistryLimits>;
}

export interface FetchedAcpRegistrySnapshot {
  readonly snapshot: AcpRegistrySnapshot;
  /** Exact accepted UTF-8 content, suitable for caller-owned persistence. */
  readonly content: string;
  readonly finalUrl: string;
  /** Observation time only; it grants no freshness, publisher or execution authority. */
  readonly fetchedAt: string;
}

export type AcpRegistryFetchErrorCode =
  | 'invalid_fetch_policy'
  | 'untrusted_origin'
  | 'insecure_transport'
  | 'redirect_limit'
  | 'invalid_redirect'
  | 'http_status'
  | 'response_too_large'
  | 'invalid_utf8'
  | 'aborted'
  | 'timeout'
  | 'network_failure';

export class AcpRegistryFetchError extends Error {
  readonly code: AcpRegistryFetchErrorCode;
  readonly status?: number;

  constructor(code: AcpRegistryFetchErrorCode, message: string, options?: { readonly status?: number; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AcpRegistryFetchError';
    this.code = code;
    this.status = options?.status;
  }
}
