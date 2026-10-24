// ------------------------------------------------------------------------------------------------
//                recoveryIdentity.ts - Immutable resource identity transitions - Recovery contracts
// ------------------------------------------------------------------------------------------------

import { SandboxStateError } from '../errors.js';
import type { SandboxRecoveryRecord } from '../recovery/types.js';

export function assertRecoveryContinuation(previous: SandboxRecoveryRecord, next: SandboxRecoveryRecord,
  operation: 'checkpoint' | 'reconciliation'): void {
  if (next.backendId !== previous.backendId || next.backendRevision !== previous.backendRevision
    || next.namespace !== previous.namespace || next.operationId !== previous.operationId || next.sandboxId !== previous.sandboxId
    || next.imageDigest !== previous.imageDigest || next.policyDigest !== previous.policyDigest
    || next.configurationDigest !== previous.configurationDigest
    || next.resources.length !== previous.resources.length) {
    throw new SandboxStateError('Recovery observations cannot change their reserved ownership identity.');
  }
  if (previous.authority.kind === 'verified' && (next.authority.kind !== 'verified'
    || next.authority.backendIdentity !== previous.authority.backendIdentity)) {
    throw new SandboxStateError('Recovery observations cannot replace verified backend authority.');
  }
  for (const resource of previous.resources) {
    const replacement = next.resources.find((candidate) => candidate.role === resource.role);
    if (!replacement || replacement.name !== resource.name
      || (resource.identity.kind === 'planned' && replacement.identity.kind === 'identified')
      || (resource.identity.kind === 'planned' && replacement.identity.kind === 'creating' && operation === 'reconciliation')
      || (resource.identity.kind === 'creating' && replacement.identity.kind === 'planned')
      || (resource.identity.kind === 'identified' && (replacement.identity.kind !== 'identified'
        || replacement.identity.id !== resource.identity.id || replacement.identity.fingerprint !== resource.identity.fingerprint))) {
      throw new SandboxStateError('Recovery observations cannot replace an owned resource identity or enter a new resource effect.');
    }
  }
}
