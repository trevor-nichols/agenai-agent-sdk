// ------------------------------------------------------------------------------------------------
//                read.ts - Scoped bounded task views and independent observation subscriptions
// ------------------------------------------------------------------------------------------------

import { z } from "zod/v4";
import { effectiveChoices } from "../execution/authority.js";
import { sameScopeIdentity, type CoordinatorState, type ParentBinding } from "../execution/state.js";
import { captureDelegationRecord } from "../shared/bounds.js";
import { invalidDelegationData } from "../shared/errors.js";
import { freezeDelegationData } from "../shared/immutable.js";
import { failDelegation } from "../shared/operational-errors.js";
import { delegationCursorPrefix, pageDelegationRows } from "../store/pages.js";
import type { DelegationObservationGap, DelegationObservedTaskObservation, DelegationTaskRecord, DelegationTaskView } from "../tasks/types.js";
import { parseCoordinatorInput } from "./parse.js";
import type { DelegationClient } from "./types.js";

const cursor = z.string().min(1).max(512);
const limit = z.number().int().positive().max(100);
const taskId = z.uuid();
const targetQuery = z.strictObject({ cursor: cursor.optional(), limit: limit.optional() });
const inspectQuery = z.strictObject({ taskId, runsCursor: cursor.optional(), limit: limit.optional() });
const observeQuery = z.strictObject({ taskId, after: cursor.optional() });
const waitQuery = z.strictObject({ taskId, timeoutMs: z.number().int().positive().max(2_147_483_647) });
type Observation = DelegationObservedTaskObservation | DelegationObservationGap;

function withSignal<Value extends object>(schema: z.ZodType<Value>, input: unknown): Value & { signal?: AbortSignal } {
  const { signal, ...data } = captureDelegationRecord(input);
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return invalidDelegationData("invalid_data", ["signal"], "A subscription signal must be an AbortSignal.");
  }
  return { ...parseCoordinatorInput(schema, data), ...(signal === undefined ? {} : { signal }) };
}

function assertAccess(state: CoordinatorState, binding: ParentBinding, task?: DelegationTaskRecord): void {
  if (task && !sameScopeIdentity(task.parent, binding.scope)) {
    failDelegation("policy_denied", "The task does not belong to this parent scope.");
  }
  state.options.host.assertResultAccess({ scope: binding.scope, ...(task === undefined ? {} : { task }) });
}

async function inspect(state: CoordinatorState, binding: ParentBinding, input: Parameters<DelegationClient["inspect"]>[0]): Promise<DelegationTaskView> {
  assertAccess(state, binding);
  const result = await state.options.store.read({ kind: "task", taskId: input.taskId,
    ...(input.runsCursor === undefined ? {} : { cursor: input.runsCursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }) });
  if (result.kind !== "task" || !result.view) return failDelegation("request_unavailable", "The managed task is unavailable.");
  assertAccess(state, binding, result.view.task);
  return freezeDelegationData(result.view);
}

function watch(state: CoordinatorState, signal: AbortSignal | undefined, timeoutMs: number) {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  const wake = () => resolve();
  state.waiters.add(wake);
  signal?.addEventListener("abort", wake, { once: true });
  const timer = setTimeout(wake, timeoutMs);
  if (signal?.aborted) wake();
  return { promise, dispose() {
    clearTimeout(timer);
    state.waiters.delete(wake);
    signal?.removeEventListener("abort", wake);
  } };
}

function observationCursor(state: CoordinatorState, task: string, run: string, index: number): string {
  return `observation:${state.options.store.storeId}:${task}:${run}:${index}`;
}

async function observeFromCursor(state: CoordinatorState, task: string, after?: string) {
  if (after === undefined) return undefined;
  const parts = after.split(":");
  if (parts.length !== 5 || parts[0] !== "observation" || parts[1] !== state.options.store.storeId
    || parts[2] !== task || !z.uuid().safeParse(parts[3]).success || !/^(?:0|[1-9][0-9]*)$/u.test(parts[4]!)) {
    return failDelegation("stale_revision", "The observation cursor belongs to a different task or store.");
  }
  const run = await state.run(task, parts[3]!);
  const index = Number(parts[4]);
  if (!Number.isSafeInteger(index) || index > run.observationIndex) {
    return failDelegation("stale_revision", "The observation cursor is beyond the retained run.");
  }
  return { runId: run.runId, index, ordinal: run.ordinal };
}

async function* observations(state: CoordinatorState, binding: ParentBinding,
  input: { taskId: string; after?: string; signal: AbortSignal }): AsyncGenerator<Observation> {
  assertAccess(state, binding);
  let position = await observeFromCursor(state, input.taskId, input.after);
  for (;;) {
    input.signal.throwIfAborted();
    const update = watch(state, input.signal, state.options.limits.maxWaitMs);
    try {
      let runsCursor: string | undefined;
      let view: DelegationTaskView;
      let hasUnsettledRuns = false;
      let currentRunActive = false;
      do {
        view = await inspect(state, binding, { taskId: input.taskId,
          ...(runsCursor === undefined ? {} : { runsCursor }) });
        for (const run of view.runs.items) {
          if (run.phase !== "settled") hasUnsettledRuns = true;
          if (position && run.ordinal < position.ordinal) continue;
          if (!position || position.runId !== run.runId) position = { runId: run.runId, index: 0, ordinal: run.ordinal };
          let more: string | undefined;
          do {
            input.signal.throwIfAborted();
            assertAccess(state, binding, view.task);
            const prefix = delegationCursorPrefix(state.options.store.storeId,
              { kind: "observations", taskId: input.taskId, runId: run.runId });
            const page = await state.options.store.read({ kind: "observations", taskId: input.taskId, runId: run.runId,
              ...(position.index === 0 ? {} : { cursor: `${prefix}${String(position.index).padStart(16, "0")}` }) });
            if (page.kind !== "observations") return failDelegation("store_failed", "The store returned a mismatched observation page.");
            assertAccess(state, binding, view.task);
            for (const observation of page.page.items) {
              input.signal.throwIfAborted();
              assertAccess(state, binding, view.task);
              if (observation.index > position.index + 1) {
                position.index = observation.index - 1;
                yield freezeDelegationData({ kind: "gap", storeId: state.options.store.storeId, taskId: input.taskId,
                  runId: run.runId, cursor: observationCursor(state, input.taskId, run.runId, position.index) });
                input.signal.throwIfAborted();
                assertAccess(state, binding, view.task);
              }
              position.index = observation.index;
              yield freezeDelegationData({ ...observation, cursor: observationCursor(state, input.taskId, run.runId, position.index) });
            }
            more = page.page.cursor;
            if (more === undefined && page.latestIndex > position.index) {
              position.index = page.latestIndex;
              input.signal.throwIfAborted();
              assertAccess(state, binding, view.task);
              yield freezeDelegationData({ kind: "gap", storeId: state.options.store.storeId, taskId: input.taskId,
                runId: run.runId, cursor: observationCursor(state, input.taskId, run.runId, position.index) });
            }
          } while (more !== undefined);
          if (run.phase !== "settled") { currentRunActive = true; break; }
        }
        runsCursor = currentRunActive ? undefined : view.runs.cursor;
      } while (runsCursor !== undefined);
      if (view.task.state === "settled" || view.task.state === "retired") return;
      if (view.task.state === "recovery_required" && !hasUnsettledRuns) return;
      if (state.failed || state.released) failDelegation("owner_lost", "The managed executor is unavailable; inspect its retained history.");
      await update.promise;
    } finally { update.dispose(); }
  }
}

function subscription(state: CoordinatorState, binding: ParentBinding,
  input: ReturnType<typeof withSignal<z.infer<typeof observeQuery>>>): AsyncIterable<Observation> {
  return { [Symbol.asyncIterator]() {
    const lifetime = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal;
    const iterator = observations(state, binding, { ...input, signal });
    let pulling = false;
    return {
      async next() {
        if (pulling) return failDelegation("unsupported_operation", "An observation subscription permits one pending read.");
        pulling = true;
        try { return await iterator.next(); } finally { pulling = false; }
      },
      async return() {
        lifetime.abort(new DOMException("Observation subscription closed.", "AbortError"));
        await iterator.return(undefined);
        return { done: true as const, value: undefined };
      },
    };
  } };
}

export function createReadClient(state: CoordinatorState, binding: ParentBinding): Pick<DelegationClient, "bindingSnapshot" | "targets" | "inspect" | "observe" | "wait"> {
  return {
    async bindingSnapshot() {
      assertAccess(state, binding);
      const choices = await effectiveChoices(state, binding);
      assertAccess(state, binding);
      const { maxInputBytes, maxInputTextCharacters, maxWaitMs, runTimeoutMs, maxPageRecords } = state.options.limits;
      return freezeDelegationData({ enabled: choices.enabled, policyRevision: choices.resolved.policyRevision,
        completionPolicies: state.options.parentDelivery ? ["collect", "next_turn", "automatic"] as const : ["collect"] as const,
        limits: { maxInputBytes, maxInputTextCharacters, maxWaitMs, runTimeoutMs, maxPageRecords } });
    },
    async targets(input = {}) {
      const query = parseCoordinatorInput(targetQuery, input);
      assertAccess(state, binding);
      const choices = await effectiveChoices(state, binding);
      assertAccess(state, binding);
      const page = pageDelegationRows({ storeId: state.options.store.storeId,
        query: { kind: "targets", scope: binding.scope, policyRevision: choices.resolved.policyRevision,
          originPolicyRevision: choices.originPolicyRevision, ceilingId: choices.ceiling.ceilingId },
        rows: choices.targets.map((target, index) => ({ target, index })), key: ({ index }) => String(index).padStart(4, "0"),
        limits: state.options.limits, ...query, envelopeBytes: 64 });
      return freezeDelegationData({ policyRevision: choices.resolved.policyRevision, targets: page.items.map(({ target }) => target),
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        ...(choices.targets.length === 0 ? { emptyReason: choices.enabled ? "no_permitted_targets" as const : "delegation_disabled" as const } : {}) });
    },
    inspect(input) { return inspect(state, binding, parseCoordinatorInput(inspectQuery, input)); },
    observe(input) { return subscription(state, binding, withSignal(observeQuery, input)); },
    async wait(input) {
      const query = withSignal(waitQuery, input);
      if (query.timeoutMs > state.options.limits.maxWaitMs) failDelegation("capacity_exceeded", "The wait exceeds the configured subscription deadline.");
      const deadline = Date.now() + query.timeoutMs;
      for (;;) {
        query.signal?.throwIfAborted();
        const update = watch(state, query.signal, Math.max(1, deadline - Date.now()));
        try {
          const view = await inspect(state, binding, { taskId: query.taskId });
          query.signal?.throwIfAborted();
          if (view.task.state === "settled" || view.task.state === "retired") {
            return freezeDelegationData({ status: "settled" as const, task: view });
          }
          if (view.task.state === "recovery_required") {
            let page = view;
            let active = false;
            let changed = false;
            for (;;) {
              active ||= page.runs.items.some((run) => run.phase !== "settled");
              changed ||= page.task.revision !== view.task.revision;
              if (!page.runs.cursor || active || changed) break;
              page = await inspect(state, binding, { taskId: query.taskId, runsCursor: page.runs.cursor });
            }
            query.signal?.throwIfAborted();
            if (!active && !changed) return freezeDelegationData({ status: "settled" as const, task: view });
          }
          if (Date.now() >= deadline) return freezeDelegationData({ status: "timeout" as const, task: view });
          if (state.failed || state.released) failDelegation("owner_lost", "The managed executor is unavailable; inspect its retained history.");
          await update.promise;
        } finally { update.dispose(); }
      }
    },
  };
}
