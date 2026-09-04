// ------------------------------------------------------------------------------------------------
//                conformance.ts - Reusable provider SPI conformance runner - Dependencies: runtime
// ------------------------------------------------------------------------------------------------

import {
  matchesAgentSessionBinding,
  parseAgentRequestResolutionFor,
  type AgentCollaborationSpawnInput,
  type AgentConfigurationSelectionInput,
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
  AgentProviderRunTurnInput,
  AgentProviderSession,
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
  readonly createSessionId: AgentSessionId;
  readonly resumeSessionId: AgentSessionId;
  readonly branchSessionId?: AgentSessionId;
  readonly abortedSessionId: AgentSessionId;
  readonly interruptionSessionId: AgentSessionId;
  readonly turn: AgentProviderRunTurnInput;
  readonly interruptionTurn: AgentProviderRunTurnInput;
  readonly resolutionFor: (request: AgentRequest) => AgentRequestResolution;
  readonly branchSource?: (
    binding: AgentSessionBinding,
    turnId: AgentTurnId,
  ) => AgentSessionBranchSource;
  readonly steeringInput?: AgentTurnInputContent;
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

interface StartedAgentProviderTurn {
  readonly iterator: AsyncIterator<AgentProviderOutput>;
  readonly outputs: AgentProviderOutput[];
}

async function advanceToStartedTurn(
  session: AgentProviderSession,
  input: AgentProviderRunTurnInput,
): Promise<StartedAgentProviderTurn> {
  const iterator = session.runTurn(input)[Symbol.asyncIterator]();
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
        return { iterator, outputs };
      }
    }
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}

async function collectRemainingOutputs(
  started: StartedAgentProviderTurn,
): Promise<readonly AgentProviderOutput[]> {
  for (;;) {
    const next = await started.iterator.next();
    if (next.done) return started.outputs;
    started.outputs.push(next.value);
  }
}

async function collectOutputs(
  outputs: AsyncIterable<AgentProviderOutput>,
): Promise<readonly AgentProviderOutput[]> {
  const collected: AgentProviderOutput[] = [];
  for await (const output of outputs) collected.push(output);
  return collected;
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

    const startedTurn = await advanceToStartedTurn(created, scenario.turn);
    let turnOutputs: readonly AgentProviderOutput[];
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
      turnOutputs = await collectRemainingOutputs(startedTurn);
    } catch (error) {
      await startedTurn.iterator.return?.();
      await created.close({ reason: "contract_rejected" });
      throw error;
    }
    const events = semanticEvents(turnOutputs);
    requireCheck(
      events[0]?.type === "turn.started",
      "turn_order",
      "Turn did not start first.",
    );
    const lastEvent = events.at(-1);
    requireCheck(
      lastEvent?.type === "turn.completed" ||
        (lastEvent?.type === "turn.state_changed" &&
          lastEvent.payload.state === "waiting_for_request"),
      "turn_order",
      "Turn did not terminate or enter a waiting state.",
    );
    checks.push("turn_order");

    const openedRequest = events.find(
      (event) => event.type === "request.opened",
    );
    if (openedRequest?.type === "request.opened") {
      const resolution = parseAgentRequestResolutionFor(
        openedRequest.payload.request,
        scenario.resolutionFor(openedRequest.payload.request),
      );
      const resolutionOutputs = await collectOutputs(
        created.resolveRequest({ resolution }),
      );
      const resolutionBoundary = semanticEvents(resolutionOutputs).at(-1);
      requireCheck(
        resolutionBoundary?.type === "turn.completed" ||
          (resolutionBoundary?.type === "turn.state_changed" &&
            resolutionBoundary.payload.state === "waiting_for_request"),
        "request_resolution",
        "Matching request resolution did not reach a stable turn boundary.",
      );
      checks.push("request_resolution");
    }

    checks.push("steering");

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
      } finally {
        await liveTurn?.iterator.return?.();
        await interrupted.close({ reason: "other" });
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

    if (instance.capabilities.integrations.kind === "supported") {
      requireCheck(
        created.integrations.kind === "supported",
        "integrations",
        "Supported integrations have no observation port.",
      );
      await created.integrations.observeIntegrations();
    } else {
      requireCheck(
        created.integrations.kind === "unsupported",
        "integrations",
        "Unsupported integrations exposed an observation port.",
      );
    }
    checks.push("integrations");

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
  } finally {
    await createdSession?.close({ reason: "contract_rejected" });
    if (!disposed) await registry.dispose();
  }
}
