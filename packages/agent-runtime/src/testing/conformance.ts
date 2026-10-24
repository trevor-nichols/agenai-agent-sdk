// ------------------------------------------------------------------------------------------------
//                conformance.ts - Reusable provider SPI conformance runner - Dependencies: runtime
// ------------------------------------------------------------------------------------------------

import { isDeepStrictEqual } from "node:util";

import {
  matchesAgentSessionBinding,
  parseAgentEnvironmentId,
  parseAgentRequestResolutionFor,
  parseAgentTurnId,
  type AgentCollaborationSpawnInput,
  type AgentJsonObject,
  type AgentOutputSchema,
  type AgentStructuredOutputCapability,
  type AgentConfigurationSelectionInput,
  type AgentEnvironmentId,
  type AgentEnvironmentInvalidation,
  type AgentEvent,
  type AgentGeneratedResourceId,
  type AgentOperationInvocation,
  type AgentRequest,
  type AgentRequestResolution,
  type AgentSessionBinding,
  type AgentSessionBranchSource,
  type AgentSessionConfiguration,
  type AgentSessionId,
  type AgentTurnId,
  type AgentTurnInputContent,
} from "@agen-ai/agent-protocol";

import { isAgentOperationAbortError } from "../foundation.js";
import { AgentProviderContractError } from "../contractErrors.js";
import {
  createAgentProviderRegistry,
  AgentProviderRegistryError,
} from "../providerInstanceRegistry.js";
import type {
  AgentProviderDriver,
  AgentProviderInstanceDefinition,
} from "../providerDriver.js";
import type { AgentProviderOutput } from "../outputs.js";
import type {
  AgentProviderOperationResult,
  AgentProviderStartTurnInput,
  AgentProviderSession,
  AgentProviderTurnExecution,
  AgentValidatedProviderAdapter,
} from "../sessions.js";

// ------------------------------------------------------------------------------------------------
//                Conformance Contracts
// ------------------------------------------------------------------------------------------------

export interface AgentProviderConformanceScenario {
  readonly driver: AgentProviderDriver;
  readonly definition: AgentProviderInstanceDefinition;
  readonly workingDirectory: string;
  readonly configuration: AgentSessionConfiguration;
  readonly configurationSelection?: AgentConfigurationSelectionInput;
  readonly operationInvocation?: AgentOperationInvocation;
  readonly collaborationSpawn?: AgentCollaborationSpawnInput;
  readonly generatedResourceId?: AgentGeneratedResourceId;
  readonly environmentId?: AgentEnvironmentId;
  readonly createSessionId: AgentSessionId;
  readonly resumeSessionId: AgentSessionId;
  readonly branchSessionId?: AgentSessionId;
  readonly abortedSessionId: AgentSessionId;
  readonly interruptionSessionId: AgentSessionId;
  readonly turn: AgentProviderStartTurnInput;
  readonly interruptionTurn: AgentProviderStartTurnInput;
  readonly resolutionFor: (
    request: AgentRequest,
    context: Readonly<{ signal: AbortSignal }>,
  ) => AgentRequestResolution | undefined | Promise<AgentRequestResolution | undefined>;
  readonly branchSource?: (
    binding: AgentSessionBinding,
    turnId: AgentTurnId,
  ) => AgentSessionBranchSource;
  readonly steeringInput?: AgentTurnInputContent;
  readonly structuredOutput?: AgentStructuredOutputConformanceScenario;
}

export interface AgentStructuredOutputConformanceScenario {
  readonly sessionId: AgentSessionId;
  readonly plainSessionId: AgentSessionId;
  readonly schema: AgentOutputSchema;
  readonly alternateSchema: AgentOutputSchema;
  /** Turn scope uses schema then alternateSchema; session scope uses schema for both turns. */
  readonly turns: readonly [
    Readonly<{ turn: Omit<AgentProviderStartTurnInput, "output">; expectedValue: AgentJsonObject }>,
    Readonly<{ turn: Omit<AgentProviderStartTurnInput, "output">; expectedValue: AgentJsonObject }>,
  ];
  readonly plainTurn: Omit<AgentProviderStartTurnInput, "output">;
}

export interface AgentProviderConformanceReport {
  readonly providerKey: string;
  readonly checks: readonly string[];
}

export class AgentProviderConformanceError extends Error {
  constructor(
    readonly check: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentProviderConformanceError";
  }
}

// ------------------------------------------------------------------------------------------------
//                Conformance Helpers
// ------------------------------------------------------------------------------------------------

function requireCheck(
  condition: unknown,
  check: string,
  message: string,
): asserts condition {
  if (!condition) throw new AgentProviderConformanceError(check, message);
}

async function checkEnvironmentWatch(input: {
  readonly iterator: AsyncIterator<AgentEnvironmentInvalidation>;
  readonly controller: AbortController;
  readonly environmentId: AgentEnvironmentId;
  readonly check: string;
}): Promise<void> {
  const pending = input.iterator.next();
  // An idle native watch is valid. Cancel the pending observation instead of
  // requiring a provider to fabricate a change for conformance.
  await Promise.resolve();
  input.controller.abort(new DOMException('Conformance watch complete.', 'AbortError'));
  try {
    const next = await pending;
    requireCheck(next.done || next.value.environmentId === input.environmentId,
      input.check, 'Environment watch returned a different identity.');
  } catch (error) {
    if (!isAgentOperationAbortError(error)) throw error;
  } finally {
    await input.iterator.return?.();
  }
}

interface StartedAgentProviderTurn {
  readonly session: AgentProviderSession;
  readonly execution: AgentProviderTurnExecution;
  readonly iterator: AsyncIterator<AgentProviderOutput>;
  readonly outputs: AgentProviderOutput[];
}

async function advanceToStartedTurn(
  session: AgentProviderSession,
  input: AgentProviderStartTurnInput,
): Promise<StartedAgentProviderTurn> {
  const execution = session.startTurn(input);
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const outputs: AgentProviderOutput[] = [];
  try {
    for (;;) {
      const next = await iterator.next();
      requireCheck(
        !next.done,
        "turn_order",
        "Turn ended before emitting turn.started.",
      );
      outputs.push(next.value);
      if (
        next.value.kind === "event" &&
        next.value.event.type === "turn.started"
      ) {
        return { session, execution, iterator, outputs };
      }
    }
  } catch (error) {
    const closing = session.close({ reason: "contract_rejected" });
    const settled = await Promise.allSettled([closing, iterator.return?.()]);
    const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError([error, ...failures], "Conformance opening and cleanup failed.", { cause: error });
    throw error;
  }
}

async function collectRemainingOutputs(
  started: StartedAgentProviderTurn,
  resolutionFor?: AgentProviderConformanceScenario["resolutionFor"],
  beforeClose?: () => Promise<void>,
  closeOnSuccess = true,
): Promise<Readonly<{ outputs: readonly AgentProviderOutput[]; deliveredRequests: number }>> {
  const requests = new Map<AgentRequest["requestId"], AbortController>();
  const tasks: Promise<void>[] = [];
  let acceptingRequests = true;
  let deliveredRequests = 0;
  let failTask!: (error: unknown) => void;
  const taskFailure = new Promise<never>((_resolve, reject) => { failTask = reject; });
  const abortRequests = () => {
    for (const controller of requests.values()) {
      controller.abort(new DOMException("Conformance request is no longer answerable.", "AbortError"));
    }
  };
  const resolve = async (request: AgentRequest, signal: AbortSignal) => {
    if (!resolutionFor) return;
    let resolution: AgentRequestResolution | undefined;
    try {
      resolution = await resolutionFor(request, { signal });
    } catch (error) {
      if (signal.aborted && isAgentOperationAbortError(error)) return;
      throw error;
    }
    if (resolution === undefined || signal.aborted) return;
    const receipt = await started.execution.resolveRequest({
      resolution: parseAgentRequestResolutionFor(request, resolution),
    });
    requireCheck(receipt.status === "delivered", "request_resolution",
      "Matching request answer was not accepted by the provider handler.");
    deliveredRequests += 1;
  };
  const reader = (async () => {
    for (;;) {
      const next = await started.iterator.next();
      if (next.done || !acceptingRequests) return;
      started.outputs.push(next.value);
      if (next.value.kind !== "event") continue;
      const event = next.value.event;
      if (event.type === "request.opened" && resolutionFor) {
        const request = event.payload.request;
        const controller = new AbortController();
        requests.set(request.requestId, controller);
        const task = resolve(request, controller.signal);
        tasks.push(task);
        void task.catch((error: unknown) => { acceptingRequests = false; failTask(error); });
      } else if (event.type === "request.unavailable") {
        requests.get(event.payload.requestId)?.abort(
          new DOMException("The provider retired this conformance request.", "AbortError"),
        );
        requests.delete(event.payload.requestId);
      } else if (event.type === "turn.completed") {
        abortRequests();
      }
    }
  })();
  const checked = reader.then(async () => {
    if (acceptingRequests) await beforeClose?.();
  });
  const failures = new Set<unknown>();
  try {
    await Promise.race([checked, taskFailure]);
  } catch (error) {
    failures.add(error);
  }
  acceptingRequests = false;
  abortRequests();
  const closing = failures.size > 0 || closeOnSuccess
    ? started.session.close({ reason: failures.size > 0 ? "contract_rejected" : "idle" })
    : Promise.resolve();
  const [closed, read, inspected, returned] = await Promise.allSettled([closing, reader, checked, started.iterator.return?.()]);
  if (closed?.status === "rejected") failures.add(closed.reason);
  for (const result of [read, inspected]) {
    if (result?.status === "rejected" && !(failures.size > 0 && isAgentOperationAbortError(result.reason))) failures.add(result.reason);
  }
  if (returned?.status === "rejected") failures.add(returned.reason);
  const joined = await Promise.allSettled(tasks);
  for (const result of joined) {
    if (result.status === "rejected") failures.add(result.reason);
  }
  if (failures.size === 1) throw failures.values().next().value;
  if (failures.size > 1) throw new AggregateError(failures, "Conformance and owned cleanup failed.", { cause: failures.values().next().value });
  return { outputs: started.outputs, deliveredRequests };
}

function requireOperationStatus(
  result: AgentProviderOperationResult,
  statuses: readonly AgentProviderOperationResult["status"][],
  check: string,
  message: string,
): void {
  requireCheck(statuses.includes(result.status), check, message);
}

function semanticEvents(outputs: readonly AgentProviderOutput[]) {
  return outputs.flatMap((output) =>
    output.kind === "event" ? [output.event] : [],
  );
}

function hasStableTurnBoundary(events: readonly AgentEvent[]): boolean {
  const boundary = events.findLast((event) =>
    event.type === "turn.completed" || event.type === "turn.state_changed",
  );
  return boundary?.type === "turn.completed"
    || (boundary?.type === "turn.state_changed"
      && boundary.payload.state === "waiting_for_request");
}

async function requireStructuredRejection(operation: () => unknown, code: "structured_output_unsupported" | "structured_output_scope_mismatch") {
  let rejected = false;
  try { await operation(); } catch (error) {
    requireCheck(error instanceof AgentProviderContractError && error.code === code,
      "structured_output", "Structured output rejection did not preserve its admission classification.");
    rejected = true;
  }
  requireCheck(rejected, "structured_output", "Unsupported structured output was admitted.");
}

async function checkStructuredOutput(input: {
  readonly adapter: AgentValidatedProviderAdapter;
  readonly capability: AgentStructuredOutputCapability;
  readonly plainSession: AgentProviderSession;
  readonly scenario: AgentProviderConformanceScenario;
}): Promise<readonly string[]> {
  const { adapter, capability, scenario } = input;
  const schema: AgentOutputSchema = scenario.structuredOutput?.schema ?? {
    type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false,
  };
  const request = { kind: "json_schema" as const, schema };
  if (capability.kind === "unsupported") {
    await requireStructuredRejection(async () => {
      const unexpected = await adapter.createSession({ sessionId: scenario.abortedSessionId,
        workingDirectory: scenario.workingDirectory, configuration: scenario.configuration,
        onBindingCreated() {}, output: request });
      await unexpected.close({ reason: "contract_rejected" });
    }, "structured_output_unsupported");
    await requireStructuredRejection(() => input.plainSession.startTurn({ ...scenario.turn, output: request }), "structured_output_unsupported");
    return ["structured_output_unsupported"];
  }
  const fixture = scenario.structuredOutput;
  requireCheck(fixture !== undefined, "structured_output", "Supported structured output requires two schema/result fixtures and an ordinary turn.");
  let bound: AgentProviderSession | undefined;
  let plain: AgentProviderSession | undefined;
  let failure: Readonly<{ error: unknown }> | undefined;
  const open = (sessionId: AgentSessionId, bind: boolean) => adapter.createSession({ sessionId,
    workingDirectory: scenario.workingDirectory, configuration: scenario.configuration,
    onBindingCreated() {}, ...(bind ? { output: request } : {}) });
  try {
    bound = await open(fixture.sessionId, capability.scope === "session");
    for (const [index, turnFixture] of fixture.turns.entries()) {
      const selected = { kind: "json_schema" as const, schema: index === 0 ? schema : fixture.alternateSchema };
      if (capability.scope === "session") {
        await requireStructuredRejection(() => bound!.startTurn({ ...turnFixture.turn, output: selected }), "structured_output_scope_mismatch");
      }
      const started = await advanceToStartedTurn(bound, { ...turnFixture.turn, ...(capability.scope === "turn" ? { output: selected } : {}) });
      const observed = await collectRemainingOutputs(started, scenario.resolutionFor, undefined, false);
      const terminal = semanticEvents(observed.outputs).at(-1);
      requireCheck(terminal?.type === "turn.completed" && terminal.payload.outcome === "completed"
        && terminal.payload.structuredOutput.kind === "json"
        && isDeepStrictEqual(terminal.payload.structuredOutput.value, turnFixture.expectedValue),
      "structured_output", "Structured turn did not finish with the expected schema-valid native value.");
    }
    if (capability.scope === "session") {
      await bound.close({ reason: "idle" });
      plain = await open(fixture.plainSessionId, false);
    } else plain = bound;
    const started = await advanceToStartedTurn(plain, fixture.plainTurn);
    const observed = await collectRemainingOutputs(started, scenario.resolutionFor, undefined, false);
    const terminal = semanticEvents(observed.outputs).at(-1);
    requireCheck(terminal?.type === "turn.completed" && terminal.payload.outcome === "completed"
      && terminal.payload.structuredOutput.kind === "not_requested",
    "structured_output_lifetime", "An ordinary turn inherited a structured output binding.");
    return ["structured_output", "structured_output_lifetime"];
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    const settled = await Promise.allSettled([bound?.close({ reason: "idle" }), plain === bound ? undefined : plain?.close({ reason: "idle" })]);
    const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failure ? [failure.error, ...failures] : failures,
      "Structured conformance cleanup failed.", failure ? { cause: failure.error } : undefined);
  }
}

// ------------------------------------------------------------------------------------------------
//                Conformance Runner
// ------------------------------------------------------------------------------------------------

export async function runAgentProviderConformance(
  scenario: AgentProviderConformanceScenario,
): Promise<AgentProviderConformanceReport> {
  const checks: string[] = [];

  try {
    await createAgentProviderRegistry({
      drivers: [scenario.driver],
      definitions: [scenario.definition, scenario.definition],
    });
    requireCheck(
      false,
      "duplicate_instance",
      "Duplicate instance definitions were accepted.",
    );
  } catch (error) {
    requireCheck(
      error instanceof AgentProviderRegistryError &&
        error.code === "duplicate_instance",
      "duplicate_instance",
      "Duplicate instance definitions did not fail with the registry contract error.",
    );
    checks.push("duplicate_instance");
  }

  const registry = await createAgentProviderRegistry({
    drivers: [scenario.driver],
    definitions: [scenario.definition],
  });
  let disposed = false;
  let createdSession: AgentProviderSession | null = null;
  let failure: Readonly<{ error: unknown }> | undefined;
  try {
    const instance = registry.requireInstance(scenario.definition.instanceId);
    requireCheck(
      instance.instanceId === scenario.definition.instanceId,
      "instance_identity",
      "Materialized instance identity changed.",
    );
    requireCheck(
      instance.capabilities.providerKey === scenario.definition.providerKey,
      "capabilities",
      "Capabilities identify another provider.",
    );
    requireCheck(
      instance.capabilities.authentication.kind ===
        instance.adapter.authentication.kind,
      "authentication_capability",
      "Authentication capability does not match the adapter port.",
    );
    checks.push(
      "instance_identity",
      "capabilities",
      "authentication_capability",
    );

    const readiness = await registry.checkReadiness(
      scenario.definition.instanceId,
    );
    requireCheck(
      readiness.status === "ready",
      "readiness",
      "Provider is not ready.",
    );
    requireCheck(
      !instance.capabilities.versionReporting || readiness.version !== undefined,
      "version_reporting_capability",
      "Version-reporting capability did not return a runtime version.",
    );
    checks.push("readiness", "version_reporting_capability");

    const quota = instance.accountQuota;
    const quotaAbort = new AbortController();
    quotaAbort.abort();
    const quotaOperations: Array<() => Promise<unknown>> = [];
    if (quota.kind === "query" || quota.kind === "query_and_observe") {
      quotaOperations.push(async () => quota.query({ signal: quotaAbort.signal }));
    }
    if (quota.kind === "observe" || quota.kind === "query_and_observe") {
      quotaOperations.push(async () => quota.observe({ signal: quotaAbort.signal })[Symbol.asyncIterator]().next());
    }
    for (const operation of quotaOperations) {
      let aborted = false;
      try {
        await operation();
      } catch (error) {
        aborted = isAgentOperationAbortError(error);
      }
      requireCheck(aborted, "account_quota", "Pre-aborted quota work must fail with AbortError.");
    }
    checks.push("account_quota");

    const environmentId = scenario.environmentId
      ?? parseAgentEnvironmentId("conformance-environment:instance");
    if (instance.capabilities.environment.instance.kind === "unsupported") {
      requireCheck(
        instance.environment.kind === "unsupported",
        "environment_instance",
        "Unsupported instance environment exposed a discovery port.",
      );
    } else {
      requireCheck(
        instance.environment.kind ===
          instance.capabilities.environment.instance.kind,
        "environment_instance",
        "Instance environment capability has no matching discovery port.",
      );
      const readSignal = new AbortController();
      let executionStarted = 0;
      const snapshot = await instance.environment.readEnvironment({
        signal: readSignal.signal,
        environmentId,
        workingDirectory: scenario.workingDirectory,
        configuration: scenario.configuration,
        onProviderExecutionStarted: () => {
          executionStarted += 1;
        },
      });
      requireCheck(
        snapshot.environmentId === environmentId && executionStarted === 1,
        "environment_instance",
        "Instance environment discovery did not echo its identity and start receipt.",
      );
      if (instance.environment.kind === "read_and_watch") {
        const iterator = instance.environment.watchEnvironment({
          signal: readSignal.signal,
          environmentId,
          workingDirectory: scenario.workingDirectory,
          configuration: scenario.configuration,
        })[Symbol.asyncIterator]();
        await checkEnvironmentWatch({ iterator, controller: readSignal, environmentId, check: 'environment_instance' });
      }
    }
    checks.push("environment_instance");

    let createdBindingCount = 0;
    const created = await instance.adapter.createSession({
      sessionId: scenario.createSessionId,
      workingDirectory: scenario.workingDirectory,
      configuration: scenario.configuration,
      onBindingCreated: () => {
        createdBindingCount += 1;
      },
    });
    createdSession = created;
    requireCheck(
      createdBindingCount === 1,
      "binding_callback",
      "Create session did not report exactly one binding.",
    );
    checks.push("create_session", "binding_callback");

    if (instance.capabilities.environment.session.kind === "unsupported") {
      requireCheck(
        created.environment.kind === "unsupported",
        "environment_session",
        "Unsupported session environment exposed an observation port.",
      );
    } else {
      requireCheck(
        created.environment.kind ===
          instance.capabilities.environment.session.kind,
        "environment_session",
        "Session environment capability has no matching observation port.",
      );
      const readSignal = new AbortController();
      let executionStarted = 0;
      const snapshot = await created.environment.readEnvironment({
        signal: readSignal.signal,
        environmentId,
        onProviderExecutionStarted: () => {
          executionStarted += 1;
        },
      });
      requireCheck(
        snapshot.environmentId === environmentId && executionStarted === 1,
        "environment_session",
        "Session environment observation did not echo its identity and start receipt.",
      );
      if (created.environment.kind === "read_and_watch") {
        const iterator = created.environment.watchEnvironment({
          signal: readSignal.signal,
          environmentId,
        })[Symbol.asyncIterator]();
        await checkEnvironmentWatch({ iterator, controller: readSignal, environmentId, check: 'environment_session' });
      }
    }
    checks.push("environment_session");

    checks.push(...await checkStructuredOutput({ adapter: instance.adapter,
      capability: instance.capabilities.turns.structuredOutput, plainSession: created, scenario }));

    const aborted = new AbortController();
    aborted.abort(new DOMException("Conformance abort.", "AbortError"));
    try {
      await instance.adapter.createSession({
        sessionId: scenario.abortedSessionId,
        workingDirectory: scenario.workingDirectory,
        configuration: scenario.configuration,
        signal: aborted.signal,
        onBindingCreated: () => undefined,
      });
      requireCheck(false, "abort", "Pre-aborted createSession was accepted.");
    } catch (error) {
      requireCheck(
        isAgentOperationAbortError(error),
        "abort",
        "Pre-aborted createSession did not fail with AbortError.",
      );
      checks.push("abort");
    }

    const turnChecksIndex = checks.length;

    if (instance.capabilities.turns.interrupt) {
      let interruptedBindingCount = 0;
      const interrupted = await instance.adapter.createSession({
        sessionId: scenario.interruptionSessionId,
        workingDirectory: scenario.workingDirectory,
        configuration: scenario.configuration,
        onBindingCreated: () => {
          interruptedBindingCount += 1;
        },
      });
      requireCheck(
        interruptedBindingCount === 1 &&
          interrupted.interruption.kind === "supported",
        "interruption",
        "Interruption capability did not open a conforming session handler.",
      );
      let liveTurn: StartedAgentProviderTurn | null = null;
      try {
        liveTurn = await advanceToStartedTurn(
          interrupted,
          scenario.interruptionTurn,
        );
        if (interrupted.interruption.kind !== "supported") {
          throw new AgentProviderConformanceError(
            "interruption",
            "Interruption capability has no handler.",
          );
        }
        const result = await interrupted.interruption.interruptTurn({
          turnId: scenario.interruptionTurn.turnId,
          reason: "user_requested",
        });
        requireOperationStatus(
          result,
          ["accepted", "completed", "canceled"],
          "interruption",
          "Live turn interruption did not succeed.",
        );
        const { outputs } = await collectRemainingOutputs(liveTurn);
        requireCheck(semanticEvents(outputs).some((event) => event.type === "turn.completed"),
          "interruption", "Interrupted turn did not produce native terminal output.");
      } finally {
        const closing = interrupted.close({ reason: "other" });
        await Promise.all([closing, liveTurn?.iterator.return?.()]);
      }
    } else {
      requireCheck(
        created.interruption.kind === "unsupported",
        "interruption",
        "Unsupported interruption exposed a handler.",
      );
    }
    checks.push("interruption");

    if (instance.capabilities.configuration.kind === "selectable") {
      requireCheck(
        created.configuration.kind === "selectable" &&
          scenario.configurationSelection !== undefined,
        "configuration",
        "Selectable configuration requires a handler and selection fixture.",
      );
      const catalog = await created.configuration.listConfiguration();
      requireCheck(
        catalog.fields.some(
          (field) => field.key === scenario.configurationSelection?.key,
        ),
        "configuration",
        "Configuration catalog did not offer the selected field.",
      );
      let executionStarted = 0;
      const result = await created.configuration.applyConfigurationSelection({
        selection: scenario.configurationSelection,
        onProviderExecutionStarted: () => {
          executionStarted += 1;
        },
      });
      requireOperationStatus(
        result,
        ["completed"],
        "configuration",
        "Selectable configuration did not complete atomically.",
      );
      requireCheck(
        executionStarted === 1,
        "configuration",
        "Configuration selection did not report exactly one execution start.",
      );
    } else {
      requireCheck(
        created.configuration.kind === "managed",
        "configuration",
        "Managed configuration exposed a selection handler.",
      );
    }
    checks.push("configuration");

    if (instance.capabilities.operations.kind === "supported") {
      requireCheck(
        created.operations.kind === "supported"
          && scenario.operationInvocation !== undefined,
        "operations",
        "Supported operations require matching ports and an invocation fixture.",
      );
      const catalog = await created.operations.listOperations();
      requireCheck(
        catalog.operations.some(
          (operation) =>
            operation.operationId === scenario.operationInvocation?.operationId,
        ),
        "operations",
        "Operation catalog did not offer the invocation fixture.",
      );
      let executionStarted = 0;
      const result = await created.operations.invokeOperation({
        invocation: scenario.operationInvocation,
        observationTurnId: parseAgentTurnId(
          scenario.operationInvocation.invocationId,
        ),
        onProviderExecutionStarted: () => {
          executionStarted += 1;
        },
      });
      requireCheck(
        result.status === "completed" && executionStarted === 1,
        "operations",
        "Operation invocation did not complete with one execution-start receipt.",
      );
    } else {
      requireCheck(
        created.operations.kind === "unsupported",
        "operations",
        "Unsupported operations exposed callable ports.",
      );
    }
    checks.push("operations");

    if (instance.capabilities.managedContent.kind === "supported") {
      requireCheck(
        created.managedContent.kind === "supported",
        "managed_content",
        "Supported managed content has no inventory port.",
      );
      await created.managedContent.listManagedContent();
    } else {
      requireCheck(
        created.managedContent.kind === "unsupported",
        "managed_content",
        "Unsupported managed content exposed an inventory port.",
      );
    }
    checks.push("managed_content");

    if (instance.capabilities.collaboration.kind === "supported") {
      requireCheck(
        created.collaboration.kind === "supported"
          && scenario.collaborationSpawn !== undefined,
        "collaboration",
        "Supported collaboration requires matching ports and a spawn fixture.",
      );
      let executionStarted = 0;
      const spawned = await created.collaboration.spawnCollaboration({
        spawn: scenario.collaborationSpawn,
        onProviderExecutionStarted: () => {
          executionStarted += 1;
        },
      });
      const stopped = await created.collaboration.controlCollaboration({
        control: {
          action: "stop",
          collaborationId: spawned.collaborationId,
          reason: "user_requested",
        },
        onProviderExecutionStarted: () => {
          executionStarted += 1;
        },
      });
      const closed = await created.collaboration.controlCollaboration({
        control: {
          action: "close",
          collaborationId: stopped.collaborationId,
        },
        onProviderExecutionStarted: () => {
          executionStarted += 1;
        },
      });
      const replayedClose = await created.collaboration.controlCollaboration({
        control: {
          action: "close",
          collaborationId: stopped.collaborationId,
        },
        onProviderExecutionStarted: () => {
          executionStarted += 1;
        },
      });
      requireCheck(
        closed.status === "canceled"
          && closed.outcome?.kind === "canceled"
          && closed.closedAt !== undefined
          && replayedClose === closed
          && executionStarted === 3,
        "collaboration",
        "Collaboration lifecycle did not preserve control and execution receipts.",
      );
    } else {
      requireCheck(
        created.collaboration.kind === "unsupported",
        "collaboration",
        "Unsupported collaboration exposed callable ports.",
      );
    }
    checks.push("collaboration");

    const turnChecks: string[] = [];
    const startedTurn = await advanceToStartedTurn(created, scenario.turn);
    let turnResult: Awaited<ReturnType<typeof collectRemainingOutputs>>;
    try {
      if (instance.capabilities.turns.steer.kind === "supported") {
        requireCheck(
          created.steering.kind === "supported",
          "steering",
          "Steering capability has no handler.",
        );
        const result = await created.steering.steerTurn({
          turnId: scenario.turn.turnId,
          ...(scenario.steeringInput ?? {
            parts: [
              { type: "text", text: "Additional conformance input." },
            ],
          }),
        });
        requireCheck(
          result.status === "delivered",
          "steering",
          "Steering did not deliver to the live turn.",
        );
      } else {
        requireCheck(
          created.steering.kind === "unsupported",
          "steering",
          "Unsupported steering exposed a handler.",
        );
      }
      turnResult = await collectRemainingOutputs(startedTurn, scenario.resolutionFor, async () => {
        if (instance.capabilities.generatedResources.kind === "supported") {
          requireCheck(
            created.generatedResources.kind === "supported"
              && scenario.generatedResourceId !== undefined,
            "generated_resources",
            "Supported generated resources require an access port and fixture.",
          );
          const resource = await created.generatedResources.getGeneratedResource({
            resourceId: scenario.generatedResourceId,
          });
          requireCheck(
            resource.descriptor.resourceId === scenario.generatedResourceId,
            "generated_resources",
            "Generated resource access returned another resource.",
          );
        } else {
          requireCheck(
            created.generatedResources.kind === "unsupported",
            "generated_resources",
            "Unsupported generated resources exposed an access port.",
          );
        }
        checks.push("generated_resources");
      });
    } catch (error) {
      const closing = created.close({ reason: "contract_rejected" });
      const settled = await Promise.allSettled([closing, startedTurn.iterator.return?.()]);
      const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError([error, ...failures], "Conformance turn and cleanup failed.", { cause: error });
      throw error;
    }
    const events = semanticEvents(turnResult.outputs);
    requireCheck(
      events[0]?.type === "turn.started",
      "turn_order",
      "Turn did not start first.",
    );
    requireCheck(
      hasStableTurnBoundary(events),
      "turn_order",
      "Turn did not terminate or enter a waiting state.",
    );
    turnChecks.push("turn_order");

    if (turnResult.deliveredRequests > 0) turnChecks.push("request_resolution");
    if (events.some((event) => event.type === "request.unavailable")) turnChecks.push("request_unavailability");

    turnChecks.push("steering");

    checks.splice(turnChecksIndex, 0, ...turnChecks);

    await created.close({ reason: "idle" });
    await created.close({ reason: "idle" });
    checks.push("idempotent_session_close");

    if (instance.capabilities.sessions.resume) {
      requireCheck(
        instance.adapter.resumption.kind === "supported",
        "resume_session",
        "Resume capability has no adapter port.",
      );
      const resumed = await instance.adapter.resumption.resumeSession({
        sessionId: scenario.resumeSessionId,
        workingDirectory: scenario.workingDirectory,
        configuration: scenario.configuration,
        binding: created.binding,
      });
      requireCheck(
        matchesAgentSessionBinding(resumed.binding, created.binding),
        "resume_session",
        "Resume changed the provider binding.",
      );
      await resumed.close({ reason: "idle" });
    } else {
      requireCheck(
        instance.adapter.resumption.kind === "unsupported",
        "resume_session",
        "Unsupported resume exposed an adapter port.",
      );
    }
    checks.push("resume_session");

    if (instance.capabilities.sessions.branch.kind === "through_turn") {
      requireCheck(
        instance.adapter.branching.kind === "through_turn" &&
          scenario.branchSessionId !== undefined &&
          scenario.branchSource !== undefined,
        "branch_session",
        "Branch capability requires a handler and branch fixtures.",
      );
      let branchBindingCount = 0;
      const branched = await instance.adapter.branching.branchSession({
        sessionId: scenario.branchSessionId,
        workingDirectory: scenario.workingDirectory,
        configuration: scenario.configuration,
        source: scenario.branchSource(created.binding, scenario.turn.turnId),
        onBindingCreated: () => {
          branchBindingCount += 1;
        },
      });
      requireCheck(
        branchBindingCount === 1 &&
          !matchesAgentSessionBinding(branched.binding, created.binding),
        "branch_session",
        "Branch did not report exactly one new provider binding.",
      );
      await branched.close({ reason: "idle" });
    } else {
      requireCheck(
        instance.adapter.branching.kind === "unsupported",
        "branch_session",
        "Unsupported branch exposed an adapter port.",
      );
    }
    checks.push("branch_session");

    await registry.dispose();
    await registry.dispose();
    disposed = true;
    requireCheck(
      registry.listInstances().length === 0,
      "disposal",
      "Disposed registry retained instances.",
    );
    checks.push("idempotent_disposal");

    return Object.freeze({
      providerKey: scenario.definition.providerKey,
      checks: Object.freeze(checks),
    });
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      await createdSession?.close({ reason: "contract_rejected" });
      if (!disposed) await registry.dispose();
    } catch (error) {
      if (failure) throw new AggregateError([failure.error, error], "Conformance and final cleanup failed.", { cause: failure.error });
      throw error;
    }
  }
}
