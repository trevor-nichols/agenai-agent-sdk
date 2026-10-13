// ------------------------------------------------------------------------------------------------
//                opening.ts - Adopt cleanup only from the exact delegated provider opening
// ------------------------------------------------------------------------------------------------

import type { AgentProviderKey } from "@agen-ai/agent-protocol";
import { AgentProviderSessionCleanupError } from "../contractErrors.js";
import type { MaybePromise } from "../foundation.js";
import { associateAgentSessionCleanupError, isAgentProviderSessionCleanupErrorFor } from "../sessionCleanup.js";
import type { AgentProviderSession, AgentProviderSessionContext } from "../sessions.js";
import { createAgentHostBindingCleanupError, type AgentHostBindingLease } from "./lifetime.js";

export async function invokeAgentSessionOpening<Input extends AgentProviderSessionContext>(input: Readonly<{
  providerKey: AgentProviderKey;
  openingInput: object;
  candidateInput: Input;
  lease: AgentHostBindingLease | undefined;
  open: (context: Input) => MaybePromise<AgentProviderSession>;
}>): Promise<AgentProviderSession> {
  try { return await input.open(input.candidateInput); }
  catch (error) {
    if (!isAgentProviderSessionCleanupErrorFor(error, input.candidateInput) || error.providerKey !== input.providerKey) throw error;
    input.lease?.stop();
    const ownership = {
      providerKey: input.providerKey,
      errors: [error],
      async retryCleanup() {
        await error.retryCleanup();
        await input.lease?.release();
      },
    };
    const retained = input.lease
      ? createAgentHostBindingCleanupError({ ...ownership, lease: input.lease })
      : new AgentProviderSessionCleanupError(ownership);
    throw associateAgentSessionCleanupError(retained, input.openingInput);
  }
}
