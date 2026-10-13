// ------------------------------------------------------------------------------------------------
//                stream.ts - Single output owner, bounded projection and live request routing
// ------------------------------------------------------------------------------------------------

import type { AgentRequest } from "@agen-ai/agent-protocol";
import type { AgentProviderOutput } from "@agen-ai/agent-runtime";
import type { DelegationHostRequestHandle } from "../host/types.js";
import { delegationDataBytes, delegationInputDigest, delegationSubordinateId } from "../shared/identity.js";
import { fitDelegationText } from "../shared/text.js";
import { projectDelegationFailure } from "../tasks/failure.js";
import { parseDelegationResultReference } from "../tasks/parse.js";
import type { DelegationHistoricalRequest, DelegationRunOutcome, DelegationTaskObservation } from "../tasks/types.js";
import { finishRun } from "./finish.js";
import { operationIdentity, operationReceipt } from "./journal.js";
import { now, type CoordinatorState, type LiveRun } from "./state.js";

function accumulate(live: LiveRun, text: string): void {
  const candidate = live.summary + text;
  const bounded = fitDelegationText(candidate, (value) => delegationDataBytes({ text: value, truncated: false, references: live.references }) <= 8_192);
  if (bounded !== candidate) live.truncated = true;
  live.summary = bounded;
}

async function observe(state: CoordinatorState, live: LiveRun, projection: Pick<DelegationTaskObservation, "kind" | "text" | "phase" | "request">): Promise<void> {
  const id = delegationSubordinateId(live.runId, "observations");
  await state.mutate(live.taskId, live.runId, id, delegationInputDigest({ runId: live.runId, kind: "observe" }), (fence, _task, run) => {
    const base = { storeId: state.options.store.storeId, taskId: live.taskId, runId: live.runId, index: run.observationIndex + 1, at: now(), ...projection };
    const text = base.text === undefined ? undefined : fitDelegationText(base.text, (value) => delegationDataBytes({ ...base, text: value }) <= state.options.limits.maxObservationBytes);
    return { ...fence, kind: "observe", observation: { ...base, ...(text === undefined ? {} : { text }) } };
  });
}

export async function markRequest(state: CoordinatorState, live: LiveRun, stateChange: "opened" | "resolution_intended" | "resolved" | "unavailable",
  request: DelegationHistoricalRequest, identity = operationIdentity(live, `request:${request.requestId}:${stateChange}`)): Promise<void> {
  await state.mutate(live.taskId, live.runId, identity.operationId, identity.inputDigest,
    (fence) => ({ ...fence, kind: "request_state", state: stateChange, request, at: now() }));
}

async function routeRequest(state: CoordinatorState, live: LiveRun, request: AgentRequest): Promise<void> {
  const historical: DelegationHistoricalRequest = { requestId: request.requestId, requestKind: request.requestKind, openedAt: now(),
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}), state: "waiting" };
  await markRequest(state, live, "opened", historical);
  live.requestHistory = historical;
  const handle = Object.freeze({}) as DelegationHostRequestHandle;
  const pending = { handle, live, request };
  live.request = pending;
  state.requests.set(handle, pending);
  await observe(state, live, { kind: "request", request: historical });
  const callback = Promise.resolve().then(async () => {
    const [{ task }, run] = await Promise.all([state.task(live.taskId), state.run(live.taskId, live.runId)]);
    if (live.lifetime.signal.aborted || live.request !== pending) return;
    await state.options.host.onRequest({ handle, task, run, request, signal: live.lifetime.signal });
  });
  state.track(callback, live);
  void callback.catch(() => {
    live.uncertain = "request_executor_lost";
    void finishRun(state, live, { kind: "recovery_required", reason: "request_executor_lost" }).catch(() => undefined);
  });
}

interface ProjectedBoundary {
  readonly request?: AgentRequest;
  readonly terminal?: DelegationRunOutcome;
}

async function reduceOutput(state: CoordinatorState, live: LiveRun, output: AgentProviderOutput): Promise<ProjectedBoundary> {
  if (live.observedStart && !live.recordedStart) {
    await operationReceipt(state, live, "delegated", operationIdentity(live, "turn"));
    live.recordedStart = true;
  }
  if (output.kind === "artifact" && state.options.host.publishArtifact && live.references.length < 8) {
    const [{ task }, run] = await Promise.all([state.task(live.taskId), state.run(live.taskId, live.runId)]);
    const reference = parseDelegationResultReference(await state.options.host.publishArtifact({ task, run, candidate: output.candidate, signal: live.lifetime.signal }));
    if (delegationDataBytes(reference) <= 256 && delegationDataBytes({ text: live.summary, truncated: live.truncated, references: [...live.references, reference] }) <= 8_192) live.references.push(reference);
    else live.truncated = true;
  }
  if (output.kind !== "event") return {};
  const event = output.event;
  if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
    accumulate(live, event.payload.delta);
    await observe(state, live, { kind: "text", text: event.payload.delta });
  } else if (event.type === "turn.started") await observe(state, live, { kind: "state", phase: "running" });
  else if (event.type === "request.opened") return { request: event.payload.request };
  else if (event.type === "turn.completed") {
    return { terminal: event.payload.outcome === "completed" ? { kind: "succeeded", result: { text: live.summary, truncated: live.truncated, references: [...live.references] } }
      : event.payload.outcome === "canceled" ? { kind: "canceled", confirmation: "provider_terminal" }
      : { kind: "failed", error: projectDelegationFailure(event.payload.error) } };
  }
  return {};
}

export async function consumeTurn(state: CoordinatorState, live: LiveRun, outputs: AsyncIterable<AgentProviderOutput>): Promise<void> {
  let terminal: DelegationRunOutcome | undefined;
  try {
    for await (const output of outputs) {
      const projected = await reduceOutput(state, live, output);
      if (projected.request || projected.terminal) await live.requestResolution?.catch(() => undefined);
      if (projected.request && !live.uncertain && !live.lifetime.signal.aborted) await routeRequest(state, live, projected.request);
      terminal = projected.terminal ?? terminal;
    }
    live.stream = undefined;
    if (!terminal) terminal = { kind: "recovery_required", reason: live.cancellation ? "cancellation_uncertain" : live.requestHistory ? "request_executor_lost" : "dispatch_uncertain" };
  } catch {
    live.stream = undefined;
    terminal = live.observedStart ? { kind: "recovery_required", reason: live.uncertain ?? (live.cancellation ? "cancellation_uncertain" : "dispatch_uncertain") }
      : { kind: "failed", error: { category: "unknown", code: "turn_rejected", message: "The managed child turn was rejected before provider execution.", recovery: { kind: "unknown" } } };
    if (!live.observedStart) {
      try { await operationReceipt(state, live, "rejected", operationIdentity(live, "turn")); } catch { live.uncertain = "storage_failed"; }
    }
  }
  live.terminal = terminal;
  await finishRun(state, live, terminal);
}
