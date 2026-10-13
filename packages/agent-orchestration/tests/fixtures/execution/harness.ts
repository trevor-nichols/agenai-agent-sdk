// ------------------------------------------------------------------------------------------------
//                harness.ts - Real managed coordinator over the validated neutral registry
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { createAgentProviderRegistry, type AgentSessionHostBinding } from "@agen-ai/agent-runtime";
import {
  createDelegationCoordinator,
  createInMemoryDelegationStore,
  parseDelegationPolicySnapshot,
  type DelegationHost,
  type DelegationHostRequest,
  type DelegationHostPolicy,
  type DelegationLimits,
  type DelegationParentScope,
  type DelegationPolicySnapshot,
  type DelegationStore,
  type DelegationTarget,
} from "../../../src/index.js";
import { enabledPolicy, makeCatalog, makeTarget } from "../../fixtures.js";
import { createExecutionProvider, type ProviderHooks } from "./provider.js";

export const scope: DelegationParentScope = { parentId: "parent", scopeId: "scope", revision: 1 };
export const textInput = (text = "Perform the delegated task.") => ({ parts: [{ type: "text" as const, text }] });

export async function waitFor(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 3_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await setTimeout(1);
  }
}

export async function createExecutionHarness(options: {
  readonly provider?: ProviderHooks;
  readonly limits?: Partial<DelegationLimits>;
  readonly store?: (store: DelegationStore) => DelegationStore;
  readonly host?: Partial<DelegationHost> | ((base: DelegationHost) => Partial<DelegationHost>);
  readonly targets?: (primary: DelegationTarget) => readonly DelegationTarget[];
  readonly policyForScope?: (requested: DelegationParentScope, current: DelegationHostPolicy) => DelegationHostPolicy;
  readonly binding?: () => AgentSessionHostBinding;
  readonly allowContinuation?: boolean;
} = {}) {
  const provider = createExecutionProvider(options.provider);
  const registry = await createAgentProviderRegistry({ drivers: [provider.driver], definitions: [provider.definition] });
  const target = makeTarget("standard", { instanceId: provider.definition.instanceId, providerKey: provider.definition.providerKey, modelId: "fake-model" });
  const catalog = makeCatalog(options.targets?.(target) ?? [target]);
  let policy: DelegationPolicySnapshot = enabledPolicy();
  let currentScope = scope;
  let resultAccess = true;
  let controlAccess = true;
  let requestAccess = true;
  const requests: DelegationHostRequest[] = [];
  const grants: AbortController[] = [];
  const events: string[] = [];
  const resources: Parameters<DelegationHost["acquireChildResources"]>[0][] = [];
  let grantReleases = 0;
  let resourceReleases = 0;
  const baseStore = createInMemoryDelegationStore({ limits: options.limits });
  const store = options.store?.(baseStore) ?? baseStore;
  const host: DelegationHost = {
    registry,
    currentPolicy: (requested): DelegationHostPolicy => {
      const current = { scope: currentScope, catalog, policy };
      return options.policyForScope?.(requested, current) ?? current;
    },
    assertResultAccess() { if (!resultAccess) throw new Error("Result access revoked"); },
    assertControl() { if (!controlAccess) throw new Error("Control access revoked"); },
    assertRequestAccess() { if (!requestAccess) throw new Error("Request access revoked"); },
    acquireExecution() {
      events.push("execution_acquired");
      const controller = new AbortController();
      grants.push(controller);
      return { signal: controller.signal,
        assertCurrent() { if (controller.signal.aborted) throw controller.signal.reason; },
        release() { grantReleases += 1; events.push("execution_released"); },
      };
    },
    acquireChildResources(input) {
      resources.push(input);
      events.push("resources_acquired");
      const hostBinding = options.binding?.();
      return { workingDirectory: { policy: "isolated", authorizedRef: "directory-authority", path: "/host/delegated" },
        ...(hostBinding === undefined ? {} : { hostBinding }),
        ...(options.allowContinuation ? { continuation: { kind: "resume", allowTargetChange: false } as const } : {}),
        async release() { await hostBinding?.release(); resourceReleases += 1; events.push("resources_released"); },
      };
    },
    verifyAppliedConfiguration({ target: appliedTarget }) {
      events.push("configuration_verified");
      return { target: appliedTarget.reference, configuration: appliedTarget.application.configuration };
    },
    onRequest(input) { requests.push(input); },
  };
  Object.assign(host, typeof options.host === "function" ? options.host({ ...host }) : options.host);
  const coordinator = await createDelegationCoordinator({ host, store, limits: store.limits });
  const client = await coordinator.bindParent({ scope });
  const spawnInput = (text?: string) => ({ operationId: randomUUID(), target: target.reference, expectedPolicyRevision: policy.revision, input: textInput(text) });
  const spawn = (text?: string) => client.spawn(spawnInput(text));
  async function close() {
    const receipt = await coordinator.dispose({ mode: "cancel", timeoutMs: 1_000 });
    await registry.dispose();
    return receipt;
  }
  return { provider, registry, target, catalog, store, baseStore, host, coordinator, client, requests, grants, events, resources, spawnInput, spawn, close,
    setPolicy(value: DelegationPolicySnapshot) { policy = value; },
    disablePolicy() { policy = parseDelegationPolicySnapshot({ revision: policy.revision + 1, developer: { enabled: false, exclusions: [] }, user: { enabled: false } }); },
    setScope(value: DelegationParentScope) { currentScope = value; },
    denyResultAccess() { resultAccess = false; },
    denyControlAccess() { controlAccess = false; },
    denyRequestAccess() { requestAccess = false; },
    grantReleases: () => grantReleases,
    resourceReleases: () => resourceReleases,
  };
}
