// ------------------------------------------------------------------------------------------------
//                host.ts - Public registry and host composition for durable qualification
// ------------------------------------------------------------------------------------------------

import { parseAgentConfigurationRevisionId, parseAgentIsoDateTime, type AgentTurnId } from "@agen-ai/agent-protocol";
import {
  createAgentEventOutput,
  createAgentProviderRegistry,
  type AgentProviderDriver,
  type AgentProviderOutput,
  type AgentProviderStartTurnInput,
  type AgentProviderSession,
  type AgentProviderTurnExecution,
  type AgentProviderSessionContext,
} from "@agen-ai/agent-runtime";
import { createFakeAgentProvider } from "@agen-ai/agent-runtime/testing";
import {
  parseDelegationPolicySnapshot,
  type DelegationHost,
  type DelegationHostRequest,
  type DelegationParentScope,
  type DelegationTarget,
} from "@agen-ai/agent-orchestration";

export const parent: DelegationParentScope = { parentId: "parent", scopeId: "qualification", revision: 1 };
export const input = { parts: [{ type: "text" as const, text: "Perform the delegated task." }] };

export function eventBase(context: AgentProviderSessionContext, turnId: AgentTurnId) {
  return { protocolVersion: 10 as const, sessionId: context.sessionId, turnId, occurredAt: parseAgentIsoDateTime(new Date().toISOString()) };
}

export async function* completedOutputs(context: AgentProviderSessionContext, turnId: AgentTurnId, deltas = ["Durable result."]): AsyncIterable<AgentProviderOutput> {
  const base = eventBase(context, turnId);
  yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
  yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "answer", itemKind: "assistant_message", status: "in_progress" } });
  for (const delta of deltas) yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId: "answer", streamKind: "assistant_text", delta } });
  yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "completed" } });
}

export async function createReferenceHost(options: {
  readonly root: string;
  readonly onInvoke?: () => void | Promise<void>;
  readonly onRequest?: (request: DelegationHostRequest) => void | Promise<void>;
  readonly allowContinuation?: boolean;
  readonly execution?: (session: AgentProviderSession, context: AgentProviderSessionContext, turn: AgentProviderStartTurnInput) => AgentProviderTurnExecution;
  readonly outputs?: (session: AgentProviderSession, context: AgentProviderSessionContext, turn: AgentProviderStartTurnInput) => AsyncIterable<AgentProviderOutput>;
}) {
  const fake = createFakeAgentProvider();
  const driver: AgentProviderDriver = {
    ...fake.driver,
    async materialize(definition) {
      const instance = await fake.driver.materialize(definition);
      const adapter = instance.adapter;
      return { ...instance, adapter: { ...adapter, async createSession(context) {
        const session = await adapter.createSession(context);
        return { ...session, startTurn(turn) {
          let execution: AgentProviderTurnExecution | undefined;
          return { turnId: turn.turnId,
            outputs: (async function* () {
              await options.onInvoke?.();
              execution = options.execution?.(session, context, turn);
              yield* execution?.outputs ?? options.outputs?.(session, context, turn) ?? completedOutputs(context, turn.turnId);
            })(),
            async resolveRequest(input) {
              if (!execution) throw new Error('The scripted reference turn has no answerable request.');
              return execution.resolveRequest(input);
            },
          };
        } };
      } } };
    },
  };
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [fake.definition] });
  const target: DelegationTarget = {
    reference: { catalogId: "catalog", catalogRevision: 1, targetId: "standard", targetRevision: 1, sourceId: "source", sourceRevision: 1 },
    instanceId: fake.definition.instanceId, providerKey: fake.definition.providerKey, modelId: "fake-model",
    label: "Qualification child", options: [], reasoning: { kind: "certified", value: "max" },
    executionMode: { kind: "certified", value: "standard" }, certification: { mappingId: "host-mapping", mappingRevision: 1 },
    availability: { kind: "available" }, limitations: [],
    application: { configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("configuration:1"), catalogRevision: 1, selections: [] }, beforeFirstTurn: [] },
  };
  const policy = parseDelegationPolicySnapshot({ revision: 1, developer: { enabled: true, exclusions: [] }, user: { enabled: true } });
  const host: DelegationHost = {
    registry,
    currentPolicy: (scope) => ({ scope, catalog: { catalogId: "catalog", revision: 1, targets: [target] }, policy }),
    assertResultAccess() {}, assertControl() {}, assertRequestAccess() {},
    acquireExecution: () => ({ signal: new AbortController().signal, assertCurrent() {}, release() {} }),
    acquireChildResources: () => ({ workingDirectory: { policy: "isolated", authorizedRef: "qualification-directory", path: options.root },
      ...(options.allowContinuation ? { continuation: { kind: "resume", allowTargetChange: false } as const } : {}), release() {} }),
    verifyAppliedConfiguration: ({ target: applied }) => ({ target: applied.reference, configuration: applied.application.configuration }),
    onRequest: (request) => options.onRequest?.(request),
  };
  return { host, registry, target, fake };
}
