// ------------------------------------------------------------------------------------------------
//                opening.ts - Adopt cleanup only from the exact delegated provider opening
// ------------------------------------------------------------------------------------------------

import type { AgentProviderKey } from "@agen-ai/agent-protocol";
import { AgentProviderSessionCleanupError } from "../contractErrors.js";
import type { MaybePromise } from "../foundation.js";
import { associateAgentSessionCleanupError, isAgentProviderSessionCleanupErrorFor } from "../sessionCleanup.js";
import type { AgentProviderSession, AgentProviderSessionContext } from "../sessions.js";
import type { SessionInteractionOwner } from "../sessionInteractions/lifetime.js";
import { createAgentHostBindingCleanupError, type AgentHostBindingLease } from "./lifetime.js";

export async function invokeAgentSessionOpening<Input extends AgentProviderSessionContext>(input: Readonly<{
  providerKey: AgentProviderKey;
  openingInput: object;
  candidateInput: Input;
  lease: AgentHostBindingLease | undefined;
  interactions?: SessionInteractionOwner;
  open: (context: Input) => MaybePromise<AgentProviderSession>;
}>): Promise<AgentProviderSession> {
  if (input.interactions) return invokeInteractiveSessionOpening({ ...input, interactions: input.interactions });
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

async function invokeInteractiveSessionOpening<Input extends AgentProviderSessionContext>(input: Readonly<{
  providerKey: AgentProviderKey;
  openingInput: object;
  candidateInput: Input;
  lease: AgentHostBindingLease | undefined;
  interactions: SessionInteractionOwner;
  open: (context: Input) => MaybePromise<AgentProviderSession>;
}>): Promise<AgentProviderSession> {
  let actual: Promise<AgentProviderSession>;
  try { input.interactions.requireUsable(); actual = Promise.resolve(input.open(input.candidateInput)); }
  catch (cause) { actual = Promise.reject(cause); }
  // Keep the real opening even when a callback/abort wins the public opening race.
  void actual.catch(() => {});
  try {
    const candidate = await Promise.race([actual, input.interactions.failure.then((cause): never => { throw cause; })]);
    input.interactions.requireUsable();
    return candidate;
  } catch (error) {
    input.interactions.stop();
    input.lease?.stop();
    let providerClosed = false;
    let nativeCleanup: AgentProviderSessionCleanupError | undefined;
    let nativeCleanupRetained = false;
    const cleanup = async (): Promise<void> => {
      let candidate: AgentProviderSession | undefined;
      try { candidate = await actual; }
      catch (cause) {
        if (isAgentProviderSessionCleanupErrorFor(cause, input.candidateInput) && cause.providerKey === input.providerKey) {
          nativeCleanup = cause;
          if (!nativeCleanupRetained) { nativeCleanupRetained = true; throw cause; }
        }
      }
      if (!providerClosed) {
        if (nativeCleanup) await nativeCleanup.retryCleanup();
        else if (candidate) await candidate.close({ reason: "contract_rejected" });
        providerClosed = true;
      }
      await input.interactions.join();
      await input.lease?.release();
    };
    try { await input.interactions.close(cleanup, false); }
    catch (cleanupError) {
      const ownership = { providerKey: input.providerKey, errors: [error, cleanupError],
        retryCleanup: () => input.interactions.close(cleanup, false) };
      const retained = input.lease ? createAgentHostBindingCleanupError({ ...ownership, lease: input.lease })
        : new AgentProviderSessionCleanupError(ownership);
      throw associateAgentSessionCleanupError(retained, input.openingInput);
    }
    throw error;
  }
}
