import {
  AgentProtocolValidationError, type AgentJsonObject, type AgentStructuredOutputResult,
} from "@agen-ai/agent-protocol";

import { AgentProviderContractError, AgentProviderSessionCleanupError } from "../contractErrors.js";
import { isAgentOperationAbortError } from "../foundation.js";
import type { AgentProviderSession } from "../sessions.js";
import { createGenerationCleanupOwner } from "./cleanup.js";
import { captureGenerationCandidate, decodeGenerationCandidate } from "./decoding.js";
import { AGENT_GENERATION_OBSERVER_TIMEOUT_MS, createGenerationDeadline, waitForBoundedGenerationWork, waitForGenerationWork } from "./deadline.js";
import { AgentGenerationCleanupError, AgentGenerationError } from "./errors.js";
import { preflightGeneration } from "./preflight.js";
import { createGenerationRequests } from "./requests.js";
import type { AgentGeneratedObject, AgentGenerateObjectInput } from "./types.js";

function unavailableFailure(output: AgentStructuredOutputResult): AgentGenerationError {
  return new AgentGenerationError("generation_failed", "Object generation did not complete with a structured object.", output.kind === "unavailable" ? {
    reason: output.reason,
    ...(output.reason !== "schema_mismatch" || output.issues === undefined ? {} : {
      issues: Object.freeze(output.issues.map((issue) => Object.freeze({ ...issue, path: Object.freeze([...issue.path]) }))),
    }),
  } : undefined);
}

function executionFailure(cause: unknown): unknown {
  if (cause instanceof AgentGenerationError || cause instanceof AgentProtocolValidationError
    || cause instanceof AgentProviderContractError || isAgentOperationAbortError(cause)) return cause;
  return new AgentGenerationError("generation_failed", "Object generation execution failed.", { cause });
}

export async function generateObject<T>(input: AgentGenerateObjectInput<T>): Promise<AgentGeneratedObject<T>> {
  const admitted = preflightGeneration(input);
  const deadline = createGenerationDeadline(admitted.deadlineAt, input.signal);
  let primary: unknown;
  let failed = false;
  let result: AgentGeneratedObject<T> | undefined;
  let stopRequests = () => {};
  const owner = createGenerationCleanupOwner({ turnId: admitted.turn.turnId, stopCallbacks: () => stopRequests() });
  let shutdown: Promise<void> | undefined;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    primary = error;
    // Native interruption and close begin before aborting or joining entered callback work.
    shutdown = owner.cleanup(true);
    void shutdown.catch(() => {});
    deadline.stop(error);
  };
  const aborted = () => fail(deadline.signal.reason);
  deadline.signal.addEventListener("abort", aborted, { once: true });
  let opening: Promise<AgentProviderSession> | undefined;
  let opened = false;
  try {
    const output = Object.freeze({ kind: "json_schema" as const, schema: admitted.schema });
    let bindingSeen = false;
    opening = Promise.resolve().then(() => input.instance.adapter.createSession({
      ...admitted.session,
      signal: deadline.signal,
      ...(admitted.capability.scope === "session" ? { output } : {}),
      onBindingCreated() { bindingSeen = true; },
    }));
    owner.setOpening(opening);
    const session = await waitForGenerationWork(opening, deadline.signal);
    opened = true;
    deadline.check();
    if (!bindingSeen) throw new AgentProviderContractError(input.instance.capabilities.providerKey, "binding_callback_missing", "Object generation opening did not report its session binding.");
    const execution = session.startTurn({
      ...admitted.turn,
      signal: deadline.signal,
      ...(admitted.capability.scope === "turn" ? { output } : {}),
      onProviderExecutionStarted: owner.markEntered,
    });
    const requests = createGenerationRequests({
      handler: input.onRequest, execution, signal: deadline.signal, deadlineAt: admitted.deadlineAt,
      owner, fail, checkDeadline: deadline.check,
    });
    stopRequests = requests.stop;
    let terminal: Readonly<{ outcome: "completed"; candidate: AgentJsonObject }> | Readonly<{ outcome: "failed"; error: AgentGenerationError }> | undefined;
    const reader = (async () => {
      // This is the only acquired reader; terminal capture precedes application observation.
      for await (const outputEvent of execution.outputs) {
        if (outputEvent.kind === "event") {
          const event = outputEvent.event;
          if (event.type === "turn.completed") {
            owner.markTerminal();
            terminal = event.payload.outcome === "completed" && event.payload.structuredOutput.kind === "json"
              ? { outcome: "completed", candidate: captureGenerationCandidate(admitted.schema, event.payload.structuredOutput.value, admitted.capability.maxOutputBytes) }
              : { outcome: "failed", error: unavailableFailure(event.payload.structuredOutput) };
          }
          requests.observe(event);
        }
        if (!failed && input.onOutput) {
          const observer = input.onOutput;
          const callback = owner.retain(Promise.resolve().then(() => { if (!failed) return observer(outputEvent); }));
          try {
            await waitForBoundedGenerationWork(callback, deadline.signal, AGENT_GENERATION_OBSERVER_TIMEOUT_MS,
              new AgentGenerationError("observer_failed", "Object output observer exceeded its deadline."));
            deadline.check();
          } catch (cause) {
            try { deadline.check(); } catch (error) { fail(error); }
            if (!failed) fail(cause instanceof AgentGenerationError ? cause : new AgentGenerationError("observer_failed", "Object output observer failed.", { cause }));
          }
        }
      }
    })();
    owner.retain(reader);
    await waitForGenerationWork(reader, deadline.signal);
    if (failed) throw primary;
    deadline.check();
    if (!terminal || terminal.outcome !== "completed") {
      throw terminal?.outcome === "failed" ? terminal.error : new AgentGenerationError("generation_failed", "Object generation stream ended without a terminal result.");
    }
    const value = decodeGenerationCandidate({ schema: admitted.schema, decode: admitted.decode }, terminal.candidate, admitted.capability.maxOutputBytes);
    deadline.check();
    result = Object.freeze({ value, sessionId: admitted.session.sessionId, turnId: admitted.turn.turnId });
  } catch (cause) {
    // Existing failed-opening errors retain their exact provider cleanup owner.
    if (!opened && cause instanceof AgentProviderSessionCleanupError && !failed) throw cause;
    fail(executionFailure(cause));
  } finally {
    deadline.signal.removeEventListener("abort", aborted);
    deadline.dispose();
  }
  try {
    await (shutdown ?? owner.cleanup(failed));
  } catch (cleanupError) {
    throw new AgentGenerationCleanupError({
      providerKey: input.instance.capabilities.providerKey,
      errors: failed ? [primary, cleanupError] : [cleanupError],
      retryCleanup: () => owner.cleanup(failed),
      ...(failed ? { primaryError: primary } : {}),
      ...(result === undefined ? {} : { result }),
    });
  }
  if (failed) throw primary;
  if (!result) throw new AgentGenerationError("generation_failed", "Object generation returned no validated result.");
  return result;
}
