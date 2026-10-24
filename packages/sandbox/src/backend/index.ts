// ------------------------------------------------------------------------------------------------
//                index.ts - Validated backend construction - Neutral ownership and parsers
// ------------------------------------------------------------------------------------------------

import type { SandboxBackend } from '../contracts.js';
import { SandboxOperationError, SandboxStateError } from '../errors.js';
import { parseOperationOptions } from '../internal/operations.js';
import { actualOperation, observe } from '../lifecycle/observation.js';
import { SandboxOwner } from '../lifecycle/owner.js';
import { RecoveredSandboxOwner } from '../lifecycle/recovered.js';
import { assertRecoveryContinuation } from '../lifecycle/recoveryIdentity.js';
import { SANDBOX_LIMITS } from '../policy/limits.js';
import { assertSandboxRequestSupported, parseSandboxId, parseSandboxRequest, parseSandboxSupport } from '../policy/parse.js';
import { parseSandboxRecoveryPolicy, parseSandboxRecoveryRecord } from '../recovery/parse.js';
import type { SandboxBackendDriver } from './contracts.js';

export type { SandboxBackendDriver, SandboxDriverReservation, SandboxDriverReady, SandboxDriverProcessReservation, SandboxDriverStartOptions, SandboxDriverTransferOptions } from './contracts.js';
export type { SandboxDriverSpillStore, SandboxDriverSpillFile } from './spill.js';

export function createSandboxBackend(driver: SandboxBackendDriver): SandboxBackend {
  const support = parseSandboxSupport(driver.support);
  const reservations = new WeakSet<object>();
  const backend: SandboxBackend = {
    support,
    reserve(request, recovery) {
      const parsed = parseSandboxRequest(request);
      const recoveryPolicy = parseSandboxRecoveryPolicy(recovery);
      assertSandboxRequestSupported(parsed, support);
      const reserved = driver.reserve(parsed);
      if (!reserved || typeof reserved !== 'object' || 'then' in reserved || reservations.has(reserved)
        || typeof reserved.start !== 'function' || typeof reserved.stop !== 'function' || typeof reserved.destroy !== 'function') {
        throw new SandboxStateError('A backend must return a fresh synchronous inert reservation with cleanup ownership.');
      }
      reservations.add(reserved);
      const id = parseSandboxId(reserved.id);
      const record = parseSandboxRecoveryRecord(reserved.recoveryRecord);
      if (record.sandboxId !== id || record.backendId !== support.backendId || record.backendRevision !== support.backendRevision
        || record.phase !== 'reserved' || record.authority.kind !== 'unverified'
        || record.resources.some((resource) => resource.identity.kind !== 'planned')) {
        throw new SandboxStateError('The initial recovery record must describe this reserved backend ownership before resource effects.');
      }
      return new SandboxOwner(reserved, parsed, recoveryPolicy, record);
    },
    async reconcile(record, options) {
      const parsed = parseSandboxRecoveryRecord(record);
      const operation = parseOperationOptions(options);
      if (parsed.backendId !== support.backendId || parsed.backendRevision !== support.backendRevision) {
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
    },
  };
  return Object.freeze(backend);
}
