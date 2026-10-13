// ------------------------------------------------------------------------------------------------
//                harness.ts - Registry-backed augmentation of the existing neutral fake provider
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";

import {
  parseAgentConfigurationRevisionId,
  parseAgentProviderConversationId,
  parseAgentProviderHistoryAnchor,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  createAgentProviderRegistry,
  type AgentHostToolInputSchema,
  type AgentHostToolInvocation,
  type AgentHostToolResult,
  type AgentProviderAdapter,
  type AgentProviderCreateSessionInput,
  type AgentProviderDriver,
  type AgentProviderSession,
  type AgentProviderSessionContext,
  type AgentSessionHostBinding,
  type AgentSessionHostBindingSupport,
  type MaybePromise,
} from "../../../src/index.js";
import { createFakeAgentProvider } from "../../../src/testing/index.js";

export const supportedBinding: AgentSessionHostBindingSupport = {
  kind: "supported",
  toolTransport: "callback",
  instructionPlacements: ["system", "developer", "tool_context"],
};

export const emptySchema: AgentHostToolInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false,
};

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function makeBinding(options: {
  readonly schema?: AgentHostToolInputSchema;
  readonly invoke?: (input: AgentHostToolInvocation) => MaybePromise<AgentHostToolResult>;
  readonly release?: () => MaybePromise<void>;
  readonly events?: string[];
} = {}) {
  const invocations: AgentHostToolInvocation[] = [];
  let releaseCount = 0;
  const binding: AgentSessionHostBinding = {
    bindingId: "host-binding",
    tools: [{
      name: "Inspect",
      description: "Inspect host-owned state.",
      inputSchema: options.schema ?? emptySchema,
    }],
    instructions: { placement: "developer", text: "Use tools within host policy." },
    invoke(input) {
      assert.equal(this, binding, "The original host callback receiver must survive wrapping.");
      invocations.push(input);
      return options.invoke?.(input) ?? { kind: "success", value: { accepted: true } };
    },
    release() {
      assert.equal(this, binding, "The original host release receiver must survive wrapping.");
      releaseCount += 1;
      options.events?.push("host_release");
      return options.release?.();
    },
  };
  return { binding, invocations, releaseCount: () => releaseCount };
}

export type OpeningKind = "create" | "resume" | "branch";

export async function createHarness(options: {
  readonly support?: AgentSessionHostBindingSupport | null;
  readonly transformAdapter?: (
    adapter: AgentProviderAdapter,
    capabilities: AgentCapabilities,
  ) => AgentProviderAdapter;
  readonly beforeOpen?: (
    context: AgentProviderSessionContext,
    kind: OpeningKind,
  ) => MaybePromise<void>;
  readonly transformSession?: (
    session: AgentProviderSession,
    context: AgentProviderSessionContext,
    kind: OpeningKind,
  ) => AgentProviderSession;
} = {}) {
  const fake = createFakeAgentProvider();
  const contexts: AgentProviderSessionContext[] = [];
  const candidates: AgentProviderSession[] = [];
  let sequence = 0;
  const driver: AgentProviderDriver = {
    ...fake.driver,
    async materialize(definition) {
      const instance = await fake.driver.materialize(definition);
      const native = instance.adapter;
      assert.equal(native.resumption.kind, "supported");
      assert.equal(native.branching.kind, "through_turn");
      if (native.resumption.kind !== "supported" || native.branching.kind !== "through_turn") {
        throw new Error("The existing fake must support all session opening paths.");
      }
      const nativeResumption = native.resumption;
      const nativeBranching = native.branching;
      const finish = (session: AgentProviderSession, context: AgentProviderSessionContext, kind: OpeningKind) => {
        const candidate = options.transformSession?.(session, context, kind) ?? session;
        candidates.push(candidate);
        return candidate;
      };
      const resumption = {
        kind: "supported" as const,
        async resumeSession(input: Parameters<typeof nativeResumption.resumeSession>[0]) {
          assert.equal(this, resumption, "The native resumption port receiver must survive wrapping.");
          contexts.push(input);
          await options.beforeOpen?.(input, "resume");
          return finish(await nativeResumption.resumeSession(input), input, "resume");
        },
      };
      const branching = {
        kind: "through_turn" as const,
        async branchSession(input: Parameters<typeof nativeBranching.branchSession>[0]) {
          assert.equal(this, branching, "The native branching port receiver must survive wrapping.");
          contexts.push(input);
          await options.beforeOpen?.(input, "branch");
          return finish(await nativeBranching.branchSession(input), input, "branch");
        },
      };
      const adapter: AgentProviderAdapter = {
        ...native,
        ...(options.support === null ? {} : { hostBinding: options.support ?? supportedBinding }),
        resumption,
        branching,
        async createSession(input) {
          assert.equal(this, adapter, "The native adapter receiver must survive wrapping.");
          contexts.push(input);
          await options.beforeOpen?.(input, "create");
          return finish(await native.createSession(input), input, "create");
        },
      };
      return { ...instance, adapter: options.transformAdapter?.(adapter, instance.capabilities) ?? adapter };
    },
  };
  const registry = await createAgentProviderRegistry({
    drivers: [driver], definitions: [fake.definition],
  });
  const adapter = registry.requireInstance(fake.definition.instanceId).adapter;
  const sourceBinding = {
    conversationId: parseAgentProviderConversationId("source-conversation"),
    historyAnchor: parseAgentProviderHistoryAnchor("source-history"),
  };
  const open = (
    kind: OpeningKind,
    hostBinding?: AgentSessionHostBinding,
    overrides: Partial<AgentProviderCreateSessionInput> = {},
  ) => {
    sequence += 1;
    const context: AgentProviderCreateSessionInput = {
      sessionId: parseAgentSessionId(`host-session:${sequence}`),
      workingDirectory: "/host/workspace",
      configuration: {
        kind: "selected", revision: parseAgentConfigurationRevisionId("configuration:1"),
        catalogRevision: 1, selections: [],
      },
      ...(hostBinding === undefined ? {} : { hostBinding }),
      onBindingCreated: () => undefined,
      ...overrides,
    };
    if (kind === "create") return adapter.createSession(context);
    if (kind === "resume") {
      assert.equal(adapter.resumption.kind, "supported");
      if (adapter.resumption.kind !== "supported") throw new Error("Missing resume port.");
      return adapter.resumption.resumeSession({ ...context, binding: sourceBinding });
    }
    assert.equal(adapter.branching.kind, "through_turn");
    if (adapter.branching.kind !== "through_turn") throw new Error("Missing branch port.");
    return adapter.branching.branchSession({
      ...context,
      source: {
        sessionId: parseAgentSessionId("source-session"), binding: sourceBinding,
        throughTurn: {
          turnId: parseAgentTurnId("source-turn"), historyAnchor: sourceBinding.historyAnchor,
        },
      },
    });
  };
  return {
    adapter, registry, fake, contexts, candidates, open,
    facade(index = -1) {
      const binding = contexts.at(index)?.hostBinding;
      assert.ok(binding, "The provider must receive the host binding facade.");
      return binding;
    },
  };
}

export function hasContractCode(code: string) {
  return (error: unknown) => error instanceof AgentProviderContractError && error.code === code;
}

export function invoke(binding: AgentSessionHostBinding, input: Partial<AgentHostToolInvocation> = {}) {
  return Promise.resolve().then(() => binding.invoke({
    invocationId: "invocation:1", toolName: "Inspect", arguments: {}, ...input,
  }));
}
