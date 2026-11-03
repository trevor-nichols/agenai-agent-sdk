import type { RecoveryEnvelope } from './schema.js';
import type { RecoveryHelper } from './scalars.js';

export const PREVIOUS_RECOVERY_SOURCE = 'sha256:601a896215001ea067f7826dc7f9a23adfc3c9fb63188f1fafa12e1e7d0a2b18';
export const PREVIOUS_RECOVERY_PROFILE = 'sha256:bebe94c6f0b6413e890178ba4dd831ecba868488e67eeb78573744de8b4903d4';
export const FIRST_SUCCESSOR_SOURCE = 'sha256:3b5d479ff8ea9a3ba2de9ccfb5a21fc2005625c76bb213b63d450e57cecb7880';
export const FIRST_SUCCESSOR_PROFILE = 'sha256:91bb41f130a1dcd30261f82d84b98f8d91bd9e4600f35c91064b97d37c4ab535';

export interface RecoveryReceiptIssuer {
  readonly helper: RecoveryHelper;
  readonly profileDigest: string;
}

export function activeRecoveryHelper(envelope: RecoveryEnvelope): RecoveryHelper {
  return envelope.format === 'agenai.docker-desktop-recovery.v1' ? envelope.preparation.recoveryHelper : envelope.activeHelper;
}

export function recoveryReceiptIssuer(envelope: RecoveryEnvelope, attempt: number, currentProfileDigest: string): RecoveryReceiptIssuer {
  if (envelope.format === 'agenai.docker-desktop-recovery.v3') {
    const [original, successor] = envelope.previousIssuers;
    if (attempt <= original.throughAttempt) return { helper: envelope.preparation.recoveryHelper, profileDigest: original.profileDigest };
    if (attempt <= successor.throughAttempt) return { helper: successor.helper, profileDigest: successor.profileDigest };
    return { helper: envelope.activeHelper, profileDigest: envelope.activeProfileDigest };
  }
  if (envelope.format === 'agenai.docker-desktop-recovery.v2') {
    return attempt <= envelope.previousIssuer.throughAttempt
      ? { helper: envelope.preparation.recoveryHelper, profileDigest: envelope.previousIssuer.profileDigest }
      : { helper: envelope.activeHelper, profileDigest: envelope.activeProfileDigest };
  }
  return { helper: envelope.preparation.recoveryHelper, profileDigest: currentProfileDigest };
}
