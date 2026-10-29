import type { Sandbox, SandboxProcessReservation } from '@agen-ai/sandbox';
import { reserveSandboxOpenCode } from '../index.js';
import type { SandboxOpenCodeInput, SandboxOpenCodeConfiguredInput } from '../index.js';

/** Existing typed API-key wrappers retain their synchronous reservation. */
export function existingKeyCaller(sandbox: Sandbox, input: SandboxOpenCodeInput): SandboxProcessReservation {
  return reserveSandboxOpenCode(sandbox, input).reservation;
}

export async function configuredKeyCaller(sandbox: Sandbox): Promise<SandboxProcessReservation> {
  const configured = {
    credential: { kind: 'api_key', value: 'synthetic-key' }, guestExecutable: '/opt/agenai/native/opencode', task: 'Selected task.',
    selection: { provider: 'openai', model: 'openai/gpt-5.4', httpsDestinations: ['https://api.openai.com'] },
    preparation: { bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 1000 },
  } satisfies SandboxOpenCodeConfiguredInput;
  // @ts-expect-error Configured async requests must not enter a wrapper promising synchronous reservations.
  const legacy: SandboxOpenCodeInput = configured;
  void legacy;
  return (await reserveSandboxOpenCode(sandbox, configured)).reservation;
}
