// ------------------------------------------------------------------------------------------------
//                reconciliation.ts - Shared validated cleanup admission and bounded owner observation
// ------------------------------------------------------------------------------------------------

import type { OperationOptions } from '../contracts.js';
import { SandboxOperationError, SandboxStateError } from '../errors.js';
import { parseOperationOptions } from '../internal/operations.js';
import { actualOperation, observe } from '../lifecycle/observation.js';
import { RecoveredSandboxOwner } from '../lifecycle/recovered.js';
import { assertRecoveryContinuation } from '../lifecycle/recoveryIdentity.js';
import { SANDBOX_LIMITS } from '../policy/limits.js';
import { parseSandboxRecoveryRecord } from '../recovery/parse.js';
import type { SandboxReconciliation, SandboxRecoveryRecord } from '../recovery/types.js';

export interface SandboxRecoveryDriver {
  readonly backendId: string;
  readonly backendRevision: string;
  reconcile(record: SandboxRecoveryRecord, options?: OperationOptions): Promise<SandboxReconciliation>;
}

export async function reconcileSandboxRecovery(driver: SandboxRecoveryDriver, record: SandboxRecoveryRecord,
  options?: OperationOptions): Promise<SandboxReconciliation> {
  const parsed = parseSandboxRecoveryRecord(record);
  const operation = parseOperationOptions(options);
  if (parsed.backendId !== driver.backendId || parsed.backendRevision !== driver.backendRevision) {
    return Object.freeze({ kind: 'conflict', reason: 'Recovery record belongs to another backend identity or revision.' });
  }
  const controller = new AbortController();
  if (operation.signal?.aborted) throw new SandboxOperationError('cancelled', 'Sandbox reconciliation was cancelled before entry.');
  const actual = actualOperation(() => driver.reconcile(parsed, { signal: controller.signal }));
  const result = await observe(actual, SANDBOX_LIMITS.startupMs, { ...operation, onInterrupt: (error) => controller.abort(error) });
  if (result.kind === 'matched' || result.kind === 'uncertain') {
    const owner = new RecoveredSandboxOwner(result.owner, parsed);
    void owner.recoveryRecord;
    return Object.freeze({ kind: result.kind, owner });
  }
  if (result.kind === 'absent') {
    const absent = parseSandboxRecoveryRecord(result.record);
    assertRecoveryContinuation(parsed, absent, 'reconciliation');
    if (absent.resources.some((resource) => resource.identity.kind === 'creating')) {
      throw new SandboxStateError('An entered acquisition with unresolved identity cannot be conclusively absent.');
    }
    return Object.freeze({ kind: 'absent', record: absent });
  }
  if (result.kind === 'conflict' && typeof result.reason === 'string' && result.reason.length > 0 && result.reason.length <= 1024) {
    return Object.freeze({ kind: 'conflict', reason: result.reason });
  }
  throw new SandboxStateError('Backend returned an invalid reconciliation result.');
}
