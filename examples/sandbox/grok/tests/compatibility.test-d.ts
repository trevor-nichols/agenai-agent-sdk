import type { Sandbox, SandboxProcessReservation } from '@agen-ai/sandbox';
import { reserveSandboxGrok } from '../launch.js';
import type { SandboxGrokInput } from '../launch.js';

/** Existing wrappers retain the key-only annotation and synchronous reservation return. */
export function existingKeyCaller(sandbox: Sandbox, input: SandboxGrokInput): SandboxProcessReservation {
  const launch = reserveSandboxGrok(sandbox, input);
  return launch.reservation;
}
