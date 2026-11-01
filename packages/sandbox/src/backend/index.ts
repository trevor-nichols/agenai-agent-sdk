// ------------------------------------------------------------------------------------------------
//                index.ts - Validated backend construction - Neutral ownership and parsers
// ------------------------------------------------------------------------------------------------

import type { SandboxBackend } from '../contracts.js';
import { SandboxStateError } from '../errors.js';
import { SandboxOwner } from '../lifecycle/owner.js';
import { assertSandboxRequestSupported, parseSandboxId, parseSandboxRequest, parseSandboxSupport } from '../policy/parse.js';
import { parseSandboxRecoveryPolicy, parseSandboxRecoveryRecord } from '../recovery/parse.js';
import type { SandboxBackendDriver } from './contracts.js';
import { reconcileSandboxRecovery } from './reconciliation.js';

export { reconcileSandboxRecovery } from './reconciliation.js';
export type { SandboxRecoveryDriver } from './reconciliation.js';

export type { SandboxBackendDriver, SandboxDriverReservation, SandboxDriverReady, SandboxDriverProcessReservation, SandboxDriverStartOptions, SandboxDriverTransferOptions } from './contracts.js';
export type { SandboxDriverSpillStore, SandboxDriverSpillFile } from './spill.js';
export type { SandboxDriverFiles, SandboxDriverReadOnlyFiles, SandboxDriverReadWriteFiles, SandboxDriverFileOptions, SandboxDriverFileWriteOptions } from '../live/driver.js';
export { createMetadataLedger, MetadataCleanupError, MetadataConflictError } from '../files/metadata/index.js';
export type { MetadataLedger, MetadataLedgerOptions, MetadataRecord } from '../files/metadata/index.js';
export { parseSandboxSymlinkTarget } from '../files/paths.js';
export { captureSandboxTreeSelection } from '../files/parse.js';
export type { SandboxCapturedTreeSelection } from '../files/types.js';

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
      return new SandboxOwner(reserved, parsed, recoveryPolicy, record, support.transferSymlinks ?? false);
    },
    reconcile(record, options) {
      return reconcileSandboxRecovery({ backendId: support.backendId, backendRevision: support.backendRevision,
        reconcile: (parsed, operation) => driver.reconcile(parsed, operation) }, record, options);
    },
  };
  return Object.freeze(backend);
}
