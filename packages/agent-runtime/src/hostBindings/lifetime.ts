// ------------------------------------------------------------------------------------------------
//                lifetime.ts - Single-use host binding invocation and cleanup ownership
// ------------------------------------------------------------------------------------------------

import { type AgentProviderKey } from "@agen-ai/agent-protocol";
import { AgentProviderContractError, AgentProviderHostBindingCleanupError } from "../contractErrors.js";
import { throwIfAgentOperationAborted, type MaybePromise } from "../foundation.js";
import type { AgentProviderSession } from "../sessions.js";
import { associateAgentSessionCleanupError } from "../sessionCleanup.js";
import { dataRecord } from "./schema.js";
import { hostBindingEnvelope, validateAgentHostToolInvocation, validateAgentHostToolResult, validateAgentSessionHostBinding } from "./validation.js";
import type { AgentHostInstructionPlacement, AgentHostToolInvocation, AgentHostToolResult, AgentSessionHostBinding, AgentSessionHostBindingSupport } from "./types.js";

const claimedBindings = new WeakSet<object>();
const cleanupLeases = new WeakMap<AgentProviderHostBindingCleanupError, AgentHostBindingLease>();

export interface AgentHostBindingLease {
  readonly binding: AgentSessionHostBinding;
  readonly initialize: (support: AgentSessionHostBindingSupport) => void;
  readonly stop: () => void;
  readonly release: () => Promise<void>;
}

export function createAgentHostBindingCleanupError(input: Readonly<{
  providerKey: AgentProviderKey;
  lease: AgentHostBindingLease;
  errors: readonly unknown[];
  retryCleanup: () => MaybePromise<void>;
}>): AgentProviderHostBindingCleanupError {
  const error = new AgentProviderHostBindingCleanupError(input);
  cleanupLeases.set(error, input.lease);
  return error;
}

function claimBinding(providerKey: AgentProviderKey, input: AgentSessionHostBinding): AgentHostBindingLease {
  const fail = (code: ConstructorParameters<typeof AgentProviderContractError>[1], message: string): never => {
    throw new AgentProviderContractError(providerKey, code, message);
  };
  let original: AgentSessionHostBinding;
  try {
    original = hostBindingEnvelope(input);
  } catch {
    return fail("invalid_host_binding", "Host binding requires a valid identity and callable ownership ports.");
  }
  if (claimedBindings.has(original)) fail("host_binding_reused", "Host binding is already claimed by a session opening.");
  claimedBindings.add(original);
  const releaseCallback = original.release.bind(original);
  const lifetime = new AbortController();
  const invocations = new Map<string, Promise<AgentHostToolResult>>();
  let facade: AgentSessionHostBinding | undefined;
  let released = false;
  let releasePromise: Promise<void> | null = null;

  const stop = (): void => {
    lifetime.abort(new DOMException("The host binding was closed.", "AbortError"));
  };
  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (releasePromise) return releasePromise;
    stop();
    releasePromise = Promise.resolve().then(async () => {
      await Promise.allSettled(invocations.values());
      await releaseCallback();
      released = true;
    }).finally(() => { releasePromise = null; });
    return releasePromise;
  };

  const initialize = (support: AgentSessionHostBindingSupport): void => {
    if (support.kind === "unsupported") return fail("host_binding_unsupported", "Provider does not support session host bindings.");
    let validated: AgentSessionHostBinding;
    try {
      if (original.instructions !== undefined) {
        const instructions = dataRecord(original.instructions);
        if (!support.instructionPlacements.includes(instructions.placement as AgentHostInstructionPlacement)) {
          fail("host_binding_unsupported", "Provider does not support the requested instruction placement.");
        }
      }
      validated = validateAgentSessionHostBinding({ binding: original, support });
    } catch (error) {
      if (error instanceof AgentProviderContractError) throw error;
      return fail("invalid_host_binding", "Host binding metadata is invalid.");
    }
    const invoke = (input: AgentHostToolInvocation): Promise<AgentHostToolResult> => {
      if (lifetime.signal.aborted) fail("host_binding_closed", "Host binding no longer accepts invocations.");
      let invocation: AgentHostToolInvocation;
      try {
        invocation = validateAgentHostToolInvocation({ binding: validated, invocation: input });
      } catch {
        return fail("host_tool_input_invalid", "Host tool invocation has invalid arguments.");
      }
      const { invocationId } = invocation;
      throwIfAgentOperationAborted(input.signal);
      if (invocations.has(invocationId)) fail("host_tool_input_invalid", "Host tool invocation is already active.");
      if (invocations.size >= 16) fail("host_tool_capacity_exhausted", "Host binding has reached its invocation limit.");
      const signal = input.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, input.signal]);
      const promise = Promise.resolve().then(async (): Promise<AgentHostToolResult> => {
        let result: unknown;
        try {
          throwIfAgentOperationAborted(signal);
          result = await validated.invoke({ ...invocation, signal });
        } catch {
          return Object.freeze({ kind: "error", error: Object.freeze({ category: "unknown", code: "host_tool_failed",
            message: "The host tool did not return a result.", recovery: Object.freeze({ kind: "unknown" }) }) });
        }
        try {
          return validateAgentHostToolResult(result);
        } catch {
          return fail("host_tool_result_invalid", "Host tool returned an invalid or oversized result.");
        }
      }).finally(() => { invocations.delete(invocationId); });
      invocations.set(invocationId, promise);
      return promise;
    };
    facade = Object.freeze({ ...validated, invoke,
      release: () => fail("invalid_host_binding", "Only the session owner may release a host binding.") });
  };
  return {
    get binding() {
      if (!facade) return fail("invalid_host_binding", "Host binding has not been initialized.");
      return facade;
    },
    initialize, stop, release,
  };
}

export async function withAgentSessionHostBinding(input: Readonly<{
  providerKey: AgentProviderKey;
  binding?: AgentSessionHostBinding;
  openingInput?: object;
  support: AgentSessionHostBindingSupport;
  open: (lease?: AgentHostBindingLease) => MaybePromise<AgentProviderSession>;
}>): Promise<AgentProviderSession> {
  let lease: AgentHostBindingLease | undefined;
  try {
    if (input.binding !== undefined) {
      lease = claimBinding(input.providerKey, input.binding);
      lease.initialize(input.support);
    }
    return await input.open(lease);
  } catch (error) {
    if (lease && error instanceof AgentProviderHostBindingCleanupError && cleanupLeases.get(error) === lease) {
      throw input.openingInput ? associateAgentSessionCleanupError(error, input.openingInput) : error;
    }
    if (lease) {
      lease.stop();
      try {
        await lease.release();
      } catch (cleanupError) {
        const retained = createAgentHostBindingCleanupError({ providerKey: input.providerKey, lease,
          errors: [error, cleanupError], retryCleanup: lease.release });
        throw input.openingInput ? associateAgentSessionCleanupError(retained, input.openingInput) : retained;
      }
    }
    throw error;
  }
}
