// ------------------------------------------------------------------------------------------------
//                prepare.ts - Registry-owned exact child creation and configuration
// ------------------------------------------------------------------------------------------------

import { parseAgentConfigurationSelectionFor } from "@agen-ai/agent-protocol";
import { isAgentProviderSessionCleanupErrorFor } from "@agen-ai/agent-runtime";
import { delegationCanonicalJson } from "../shared/identity.js";
import { failDelegation } from "../shared/operational-errors.js";
import { assertRunDispatch, sameTarget } from "./authority.js";
import { finishRun } from "./finish.js";
import { dispatchIntent, operationIdentity, operationReceipt } from "./journal.js";
import type { CoordinatorState, LiveRun } from "./state.js";
import { consumeTurn } from "./stream.js";

export async function prepareRun(state: CoordinatorState, live: LiveRun,
  revoke: () => void): Promise<void> {
  const run = await state.run(live.taskId, live.runId);
  const { task } = await state.task(live.taskId);
  const prepare = operationIdentity(live, "prepare");
  const gate = () => assertRunDispatch(state, live, run.admittedPolicyRevision, run.admittedOriginPolicyRevision);
  let preparationCompleted = false;
  let openingInput: object | undefined;
  try {
    if (run.cancelRequested) failDelegation("recovery_required", "The run was canceled before preparation acquired execution authority.");
    gate();
    live.execution = await state.options.host.acquireExecution({ scope: live.scope, task, run,
      target: live.target, signal: live.lifetime.signal });
    const revoked = () => { revoke(); };
    live.execution.signal.addEventListener("abort", revoked, { once: true });
    live.removeRevocation = () => live.execution?.signal.removeEventListener("abort", revoked);
    if (live.execution.signal.aborted) revoke();
    gate();
    const continuation = run.previousRunId ? state.continuations.get(live.taskId) : undefined;
    if (run.previousRunId && (!continuation || continuation.runId !== run.previousRunId)) {
      failDelegation("unsupported_operation", "The exact previous conversation is unavailable for continuation.");
    }
    live.resources = await state.options.host.acquireChildResources({ scope: live.scope, task, run, target: live.target,
      ...(continuation ? { continuation } : {}), signal: live.lifetime.signal });
    gate();
    if (continuation && (live.resources.continuation?.kind !== "resume"
      || ((!sameTarget(continuation.target.reference, live.target.reference)) && !live.resources.continuation.allowTargetChange)
      || continuation.target.instanceId !== live.target.instanceId || continuation.target.providerKey !== live.target.providerKey)) {
      failDelegation("unsupported_operation", "The host has not authorized this exact conversation continuation.");
    }
    const instance = state.options.host.registry.requireInstance(live.target.instanceId);
    if (instance.capabilities.providerKey !== live.target.providerKey) failDelegation("stale_target", "The registered provider does not match the admitted target.");
    const readiness = await state.options.host.registry.checkReadiness(live.target.instanceId, { signal: live.lifetime.signal });
    if (readiness.status !== "ready") failDelegation("target_unavailable", "The selected provider is not ready.");
    gate();
    if (state.options.host.registry.requireInstance(live.target.instanceId) !== instance) failDelegation("target_unavailable", "The prepared provider instance is no longer registered.");
    const context = { sessionId: live.sessionId, workingDirectory: live.resources.workingDirectory.path,
      configuration: live.target.application.configuration, signal: live.lifetime.signal,
      ...(live.resources.hostBinding ? { hostBinding: live.resources.hostBinding } : {}) };
    if (continuation) {
      if (instance.adapter.resumption.kind !== "supported") failDelegation("unsupported_operation", "The registered provider cannot resume this conversation.");
      const input = { ...context, binding: continuation.binding };
      openingInput = input;
      live.session = await instance.adapter.resumption.resumeSession(input);
    } else {
      const input = { ...context, onBindingCreated: () => undefined };
      openingInput = input;
      live.session = await instance.adapter.createSession(input);
    }
    gate();
    const configuration = live.session.configuration;
    let observedConfiguration;
    if (configuration.kind === "selectable") observedConfiguration = await configuration.listConfiguration({ signal: live.lifetime.signal });
    for (const [index, selection] of live.target.application.beforeFirstTurn.entries()) {
      if (configuration.kind !== "selectable" || !observedConfiguration) failDelegation("unsupported_operation", "The admitted configuration is not selectable on this session.");
      parseAgentConfigurationSelectionFor(observedConfiguration, selection);
      const field = observedConfiguration.fields.find((entry) => entry.key === selection.key);
      if (!field?.mutable || field.scope !== "session" || field.applicationTiming !== "immediate") {
        failDelegation("unsupported_operation", "Managed child configuration must be immediate and local to its owned session.");
      }
      const identity = operationIdentity(live, `configure:${index}`);
      await dispatchIntent(state, live, "configure", identity);
      gate();
      let invoked = false;
      try {
        const result = await configuration.applyConfigurationSelection({ selection, signal: live.lifetime.signal,
          onProviderExecutionStarted() { gate(); invoked = true; } });
        await operationReceipt(state, live, result.status === "completed" ? "completed" : "uncertain", identity);
        if (result.status !== "completed") failDelegation("recovery_required", "Configuration application did not complete definitively.");
      } catch (error) {
        if (invoked) live.uncertain = "dispatch_uncertain";
        else await operationReceipt(state, live, "rejected", identity);
        throw error;
      }
      gate();
      observedConfiguration = await configuration.listConfiguration({ signal: live.lifetime.signal });
    }
    gate();
    const applied = await state.options.host.verifyAppliedConfiguration({ task, run, target: live.target,
      session: live.session, ...(observedConfiguration ? { observedConfiguration } : {}), signal: live.lifetime.signal });
    if (!sameTarget(applied.target, live.target.reference)
      || delegationCanonicalJson(applied.configuration) !== delegationCanonicalJson(live.target.application.configuration)) {
      failDelegation("stale_target", "The host did not attest the exact admitted configuration and source.");
    }
    gate();
    await operationReceipt(state, live, "completed", prepare);
    preparationCompleted = true;
    await dispatchIntent(state, live, "turn", operationIdentity(live, "turn"), { appliedTarget: live.target.reference });
    gate();
    live.turn = live.session.startTurn({ turnId: live.turnId, interactionMode: "default",
      ...run.input, deadlineAt: run.deadlineAt, signal: live.lifetime.signal,
      onProviderExecutionStarted() { gate(); live.observedStart = true; } });
    const stream = consumeTurn(state, live, live.turn.outputs);
    live.stream = stream;
    await stream;
  } catch (error) {
    if (openingInput && isAgentProviderSessionCleanupErrorFor(error, openingInput)) {
      live.rejectedOpening = error;
    }
    if (!preparationCompleted) {
      try { await operationReceipt(state, live, live.rejectedOpening || live.uncertain ? "uncertain" : "rejected", prepare); }
      catch { live.uncertain = "storage_failed"; }
    }
    await finishRun(state, live, live.observedStart || live.rejectedOpening || live.uncertain
      ? { kind: "recovery_required", reason: live.uncertain ?? "dispatch_uncertain" }
      : { kind: "failed", error: { category: "unknown", code: "preparation_rejected", message: "The managed child could not start under its admitted authority.", recovery: { kind: "unknown" } } });
  }
}
