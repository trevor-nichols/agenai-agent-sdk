// ------------------------------------------------------------------------------------------------
//                identity.ts - Exact canonical original-record selection for cleanup only
// ------------------------------------------------------------------------------------------------

import { SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../../../../policy/config.js';
import { validateRecord } from '../../../../recovery/identity.js';
import { recoveryRecordDigest } from '../journal/schema.js';
import type { CoordinatorMember } from '../journal/schema.js';
import type { DesktopCoordinatorCleanupJournal } from './contracts.js';

export function validateCleanupRecord(journal: DesktopCoordinatorCleanupJournal, config: DockerSandboxConfig,
  member: CoordinatorMember, supplied: SandboxRecoveryRecord): void {
  const snapshot = journal.snapshot();
  if (config.coordination === undefined || snapshot.generation.kind !== 'dirty'
    || config.coordination.authorityId !== snapshot.authorityId || config.coordination.engineKey !== snapshot.engineKey
    || JSON.stringify(config.coordination.generation) !== JSON.stringify(snapshot.generation.identity)
    || !validateRecord(supplied, config)) throw new SandboxStateError('Cleanup configuration does not match the original coordinator generation and member binding.');
  if (recoveryRecordDigest(member.checkpoint.record) !== recoveryRecordDigest(supplied)) {
    throw new SandboxStateError('Cleanup requires the exact current canonical member record.');
  }
}
