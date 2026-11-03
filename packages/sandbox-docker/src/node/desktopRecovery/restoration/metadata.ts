import { z } from 'zod/v4';
import { observationFingerprint } from '../../../network/desktop/observation/engine.js';
import { coordinatorDigest } from '../../../network/desktop/coordinator/journal/schema.js';
import { RecoveryRestorationError } from './engine.js';

const componentsSchema = z.object({ appVersion: z.literal('4.54.0'), buildNumber: z.union([z.literal('212467'), z.literal(212467)]),
  engineVersion: z.literal('29.1.2'), desktopCliVersion: z.literal('v0.2.0'), linuxVersion: z.literal('v6.12.54') });

export function parseRecoveryMetadata(source: 'components' | 'settings', bytes: Uint8Array): Readonly<{ digest: string }> {
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RecoveryRestorationError('composition', 'Desktop metadata is not complete UTF-8 JSON.'); }
  if (input === null || Array.isArray(input) || typeof input !== 'object') {
    throw new RecoveryRestorationError('composition', 'Desktop metadata must be an object.');
  }
  if (source === 'components' && !componentsSchema.safeParse(input).success) {
    throw new RecoveryRestorationError('composition', 'Desktop installed component metadata differs from the qualified profile.');
  }
  return Object.freeze({ digest: coordinatorDigest(`agenai.desktop-recovery.${source}-metadata.v1`, observationFingerprint(input)) });
}
