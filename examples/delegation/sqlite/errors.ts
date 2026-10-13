// ------------------------------------------------------------------------------------------------
//                errors.ts - Bounded reference-store failures
// ------------------------------------------------------------------------------------------------

import { DelegationOperationError, type DelegationErrorCode } from '@agen-ai/agent-orchestration';

export function fail(code: DelegationErrorCode, message: string): never {
  throw new DelegationOperationError(code, message);
}

export function sqliteFailure(error: unknown): never {
  if (error instanceof DelegationOperationError) throw error;
  return fail('store_failed', 'The reference SQLite store could not complete its transaction. Retain the last committed intent.');
}
