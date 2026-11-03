import { RecoveryJournalError } from '../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { DesktopCoordinatorSequenceError } from '../../network/desktop/coordinator/sequence.js';
import { DockerDesktopRecoveryError } from './contracts.js';
import type { DockerDesktopRecoveryController, DockerDesktopRecoveryFailure } from './contracts.js';
import { RecoveryNativeError } from './native/owner.js';
import { RecoveryRestorationError } from './restoration/engine.js';

export function recoveryError(cause: unknown, owner: DockerDesktopRecoveryController,
  fallback: DockerDesktopRecoveryFailure): DockerDesktopRecoveryError {
  if (cause instanceof DockerDesktopRecoveryError) return cause;
  let failure = fallback;
  if (cause instanceof RecoveryJournalError) {
    switch (cause.reason) {
      case 'unsupported_no_id_noncontainer': failure = { kind: 'unsupported', reason: 'no_id_noncontainer' }; break;
      case 'capacity': failure = { kind: 'capacity_exhausted', resource: 'journal' }; break;
      case 'invalid': failure = { kind: 'journal_invalid', reason: 'corrupt' }; break;
      case 'evidence': failure = { kind: 'identity_conflict', scope: 'evidence' }; break;
      case 'transition': failure = { kind: 'invalid_state' }; break;
      case 'publication': failure = fallback.kind === 'persistence_failed' ? fallback : { kind: 'persistence_failed', boundary: 'transition' }; break;
    }
  } else if (cause instanceof RecoveryNativeError) {
    if (cause.claim === 'lost') failure = { kind: 'authority_lost', source: 'native_holder' };
    else if (cause.reason === 'busy') failure = { kind: 'busy' };
    else if (cause.reason === 'authority_partial' || cause.reason === 'directory_open') failure = { kind: 'journal_invalid', reason: 'missing' };
    else if (cause.reason === 'state_frame_bound') failure = { kind: 'journal_invalid', reason: 'corrupt' };
    else if (cause.reason === 'unpublished_temp') failure = { kind: 'journal_invalid', reason: 'unpublished_temp' };
    else if (cause.reason === 'producer_roles_missing') failure = { kind: 'observation_incomplete', reason: 'producer' };
  } else if (cause instanceof RecoveryRestorationError) {
    switch (cause.reason) {
      case 'capacity': failure = { kind: 'capacity_exhausted', resource: 'observation' }; break;
      case 'engine': case 'endpoint': case 'store': failure = { kind: 'identity_conflict', scope: cause.reason }; break;
      case 'composition': case 'producer': case 'fresh_boot': case 'restoration': failure = { kind: 'observation_incomplete', reason: cause.reason }; break;
    }
  } else if (cause instanceof DesktopCoordinatorSequenceError) {
    failure = cause.failure.kind === 'capacity_exhausted' ? { kind: 'capacity_exhausted', resource: 'sequence' }
      : { kind: 'interrupted', by: 'signal', effect: 'not_entered' };
  }
  return new DockerDesktopRecoveryError(failure, owner, { cause });
}
