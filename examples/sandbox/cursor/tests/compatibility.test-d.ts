import type { Sandbox, SandboxProcessReservation } from '@agen-ai/sandbox';
import { reserveSandboxCursor } from '../index.js';
import type { SandboxCursorInput } from '../index.js';

/** Existing typed API-key wrappers retain their synchronous reservation. */
export function existingKeyCaller(sandbox: Sandbox, input: SandboxCursorInput): SandboxProcessReservation {
  return reserveSandboxCursor(sandbox, input).reservation;
}
