// ------------------------------------------------------------------------------------------------
//                providerRegistry.test.ts - Registry identity, cleanup, and lookup coverage
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentCapabilities,
  parseAgentInstanceId,
  parseAgentProviderKey,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderRegistryError,
  createAgentProviderReadiness,
  createAgentProviderRegistry,
  defineAgentProviderDriver,
  type AgentProviderAdapter,
  type AgentProviderDriver,
} from "../src/index.js";
import { createFakeAgentProvider } from "../src/testing/index.js";

test("registry exposes deterministic catalogs, readiness, lookup, and idempotent cleanup", async () => {
  const first = createFakeAgentProvider({
    providerKey: "z-provider",
    instanceId: "instance:z",
  });
  const second = createFakeAgentProvider({
    providerKey: "a-provider",
    instanceId: "instance:a",
  });
  const registry = await createAgentProviderRegistry({
    drivers: [first.driver, second.driver],
    definitions: [first.definition, second.definition],
  });

  assert.deepEqual(
    registry.listProviderCatalogEntries().map((entry) => entry.providerKey),
    ["a-provider", "z-provider"],
  );
  assert.deepEqual(
    registry.listInstanceCatalogEntries().map((entry) => entry.instanceId),
    ["instance:a", "instance:z"],
  );
  assert.equal(
    (await registry.checkReadiness(parseAgentInstanceId("instance:a"))).status,
    "ready",
  );
  assert.equal(registry.hasInstance(parseAgentInstanceId("instance:z")), true);

  await registry.dispose();
  await registry.dispose();
  assert.deepEqual(registry.listInstances(), []);
  assert.equal(first.snapshot().instanceDisposeCount, 1);
  assert.equal(second.snapshot().instanceDisposeCount, 1);
});

test("registry rejects duplicate providers and instance definitions before materialization", async () => {
  const fake = createFakeAgentProvider();
  await assert.rejects(
    createAgentProviderRegistry({
      drivers: [fake.driver, fake.driver],
      definitions: [],
    }),
    (error: unknown) =>
      error instanceof AgentProviderRegistryError &&
      error.code === "duplicate_provider",
  );
  await assert.rejects(
    createAgentProviderRegistry({
      drivers: [fake.driver],
      definitions: [fake.definition, fake.definition],
    }),
    (error: unknown) =>
      error instanceof AgentProviderRegistryError &&
      error.code === "duplicate_instance",
  );
  assert.equal(fake.snapshot().materializationCount, 0);
});

test("registry rejects malformed raw drivers before catalog publication", async () => {
  const fake = createFakeAgentProvider();
  const invalidDrivers = [
    { ...fake.driver, providerKey: "INVALID KEY" },
    { ...fake.driver, supportsMultipleInstances: "yes" },
    { ...fake.driver, materialize: null },
  ];

  for (const invalidDriver of invalidDrivers) {
    await assert.rejects(
      createAgentProviderRegistry({
        drivers: [invalidDriver as unknown as AgentProviderDriver],
        definitions: [],
      }),
      (error: unknown) =>
        error instanceof AgentProviderRegistryError &&
        error.code === "invalid_driver",
    );
  }
  assert.equal(fake.snapshot().materializationCount, 0);
});

test("registry validates materialized instance identity and capability ownership", async () => {
  const providerKey = parseAgentProviderKey("mismatch-provider");
  const instanceId = parseAgentInstanceId("mismatch-instance");
  const adapter: AgentProviderAdapter = {
    createSession: () => {
      throw new Error("not used");
    },
    resumption: { kind: "unsupported" },
    branching: { kind: "unsupported" },
    authentication: { kind: "unsupported" },
  };
  let disposeCount = 0;
  const driver = defineAgentProviderDriver({
    providerKey,
    supportsMultipleInstances: true,
    parseConfiguration: () => ({}),
    createInstance: () => ({
      instanceId: parseAgentInstanceId("another-instance"),
      capabilities: parseAgentCapabilities({
        protocolVersion: 8,
        providerKey,
        sessions: {
          create: true,
          resume: false,
          branch: { kind: "unsupported" },
        },
        turns: {
          interactionModes: ["default"],
          interrupt: false,
          steer: { kind: "unsupported" },
        },
        requests: {
          approval: { kind: "unsupported" },
          elicitation: { kind: "unsupported" },
        },
        context: {
          usage: { kind: "unsupported" },
          compaction: { kind: "unsupported" },
        },
        input: { text: true, images: { kind: "unsupported" } },
        output: {
          streaming: false,
          plans: false,
          fileChanges: "none",
          artifactKinds: [],
        },
        configuration: { kind: "managed" },
        operations: { kind: "unsupported" },
        managedContent: { kind: "unsupported" },
        integrations: { kind: "unsupported" },
        collaboration: { kind: "unsupported" },
        generatedResources: { kind: "unsupported" },
        authentication: { kind: "unsupported" },
        versionReporting: false,
      }),
      adapter,
      checkReadiness: () =>
        createAgentProviderReadiness({
          status: "ready",
          checkedAt: "2026-08-04T00:00:00.000Z",
        }),
      dispose: async () => {
        disposeCount += 1;
      },
    }),
  });

  await assert.rejects(
    createAgentProviderRegistry({
      drivers: [driver],
      definitions: [{ providerKey, instanceId, driverConfiguration: {} }],
    }),
    (error: unknown) =>
      error instanceof AgentProviderRegistryError &&
      error.code === "instance_contract_mismatch",
  );
  assert.equal(disposeCount, 1);
});

test("registry rejects missing materialized instance ports before publication", async () => {
  for (const missingPort of ["checkReadiness", "dispose"] as const) {
    const fake = createFakeAgentProvider({
      providerKey: `missing-${missingPort.toLowerCase()}-provider`,
      instanceId: `missing-${missingPort.toLowerCase()}-instance`,
    });
    const malformedDriver = {
      ...fake.driver,
      async materialize(definition: Parameters<AgentProviderDriver["materialize"]>[0]) {
        const instance = await fake.driver.materialize(definition);
        return { ...instance, [missingPort]: undefined };
      },
    } as unknown as AgentProviderDriver;

    await assert.rejects(
      createAgentProviderRegistry({
        drivers: [malformedDriver],
        definitions: [fake.definition],
      }),
      (error: unknown) =>
        error instanceof AgentProviderRegistryError
        && error.code === "instance_contract_mismatch",
      missingPort,
    );
  }
});

test("registry cleans earlier instances when a rejected instance also fails cleanup", async () => {
  const first = createFakeAgentProvider({
    providerKey: "first-provider",
    instanceId: "first-instance",
  });
  const providerKey = parseAgentProviderKey("cleanup-failure-provider");
  const instanceId = parseAgentInstanceId("cleanup-failure-instance");
  const driver = defineAgentProviderDriver({
    providerKey,
    supportsMultipleInstances: true,
    parseConfiguration: () => ({}),
    createInstance: () => ({
      instanceId: parseAgentInstanceId("wrong-instance"),
      capabilities: parseAgentCapabilities({
        protocolVersion: 8,
        providerKey,
        sessions: {
          create: true,
          resume: false,
          branch: { kind: "unsupported" },
        },
        turns: {
          interactionModes: ["default"],
          interrupt: false,
          steer: { kind: "unsupported" },
        },
        requests: {
          approval: { kind: "unsupported" },
          elicitation: { kind: "unsupported" },
        },
        context: {
          usage: { kind: "unsupported" },
          compaction: { kind: "unsupported" },
        },
        input: { text: true, images: { kind: "unsupported" } },
        output: {
          streaming: false,
          plans: false,
          fileChanges: "none",
          artifactKinds: [],
        },
        configuration: { kind: "managed" },
        operations: { kind: "unsupported" },
        managedContent: { kind: "unsupported" },
        integrations: { kind: "unsupported" },
        collaboration: { kind: "unsupported" },
        generatedResources: { kind: "unsupported" },
        authentication: { kind: "unsupported" },
        versionReporting: false,
      }),
      adapter: {
        createSession: () => {
          throw new Error("not used");
        },
        resumption: { kind: "unsupported" },
        branching: { kind: "unsupported" },
        authentication: { kind: "unsupported" },
      },
      checkReadiness: () =>
        createAgentProviderReadiness({
          status: "ready",
          checkedAt: "2026-08-04T00:00:00.000Z",
        }),
      dispose: async () => {
        throw new Error("cleanup failed");
      },
    }),
  });

  await assert.rejects(
    createAgentProviderRegistry({
      drivers: [first.driver, driver],
      definitions: [
        first.definition,
        { providerKey, instanceId, driverConfiguration: {} },
      ],
    }),
    (error: unknown) =>
      error instanceof AgentProviderRegistryError &&
      error.code === "instance_contract_mismatch" &&
      error.cleanupFailureInstanceIds.includes(instanceId),
  );
  assert.equal(first.snapshot().instanceDisposeCount, 1);
});
