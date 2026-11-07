import { createHash } from 'node:crypto';
import { importInstalled } from '../../../../scalability/identity.mjs';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The MS001 reproduction retains the published 0.4.7 contract. */
export const installed = (consumer, name, subpath = '.') => importInstalled(consumer, name, subpath, '0.4.7');

export function failure(error) {
  if (error instanceof AggregateError) return { name: error.name, message: error.message,
    errors: error.errors.map(failure), ...(error.cause ? { cause: failure(error.cause) } : {}) };
  return { name: error?.name ?? 'ThrownValue', message: error?.message ?? String(error),
    ...(error?.code ? { code: error.code } : {}), ...(error?.cause ? { cause: failure(error.cause) } : {}) };
}
