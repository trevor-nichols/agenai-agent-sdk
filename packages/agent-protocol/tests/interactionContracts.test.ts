// ------------------------------------------------------------------------------------------------
//                interactionContracts.test.ts - V8 interaction domain invariants and correlation
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  safeParseAgentCollaborationControlInput,
  safeParseAgentCollaborationNode,
  safeParseAgentCollaborationSpawnInput,
  safeParseAgentConfigurationCatalog,
  safeParseAgentConfigurationSelectionFor,
  safeParseAgentGeneratedResourceDescriptor,
  safeParseAgentIntegrationCatalog,
  safeParseAgentManagedContentCatalog,
  safeParseAgentOperationCatalog,
  safeParseAgentOperationInvocationFor,
  safeParseAgentOperationResultFor,
} from "../src/public/index.js";

const operation = {
  operationId: "operation:configure",
  revision: 3,
  kind: "configuration_select",
  title: "Configure provider",
  context: "session",
  timing: "idle_session",
  executionMode: "immediate",
  fields: [
    {
      fieldId: "mode",
      fieldKind: "single_select",
      label: "Mode",
      required: true,
      sensitivity: "ordinary",
      options: [
        { optionId: "fast", label: "Fast" },
        { optionId: "thorough", label: "Thorough" },
      ],
    },
  ],
  confirmation: "required",
  idempotency: "required",
  resultKind: "none",
} as const;

const invocation = {
  invocationId: "invocation:1",
  operationId: operation.operationId,
  expectedRevision: operation.revision,
  values: [{
    fieldId: "mode",
    fieldKind: "single_select",
    optionId: "fast",
  }],
} as const;

test("operation catalogs and invocations enforce canonical identity, revision, and fields", () => {
  assert.equal(
    safeParseAgentOperationCatalog({ revision: 1, operations: [operation] })
      .success,
    true,
  );
  assert.equal(safeParseAgentOperationInvocationFor(operation, invocation).success, true);
  assert.equal(
    safeParseAgentOperationInvocationFor(operation, {
      ...invocation,
      expectedRevision: 2,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentOperationInvocationFor(operation, {
      ...invocation,
      values: [{ ...invocation.values[0], optionId: "unoffered" }],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentOperationCatalog({ revision: 1, operations: [operation, operation] })
      .success,
    false,
  );
  assert.equal(
    safeParseAgentOperationResultFor(operation, invocation, {
      invocationId: "invocation:other",
      status: "completed",
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentOperationResultFor(operation, invocation, {
      invocationId: invocation.invocationId,
      status: "completed",
      outputText: "Unexpected output for a no-result operation.",
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentOperationResultFor(
      { ...operation, resultKind: "canonical_output" },
      invocation,
      {
        invocationId: invocation.invocationId,
        status: "completed",
        outputText: "Configuration updated.",
      },
    ).success,
    true,
  );
});

test("configuration selections are catalog-bound, revisioned, typed, and mutable", () => {
  const catalog = {
    revision: 5,
    fields: [{
      key: "model",
      revision: 2,
      label: "Model",
      scope: "session",
      applicationTiming: "next_session",
      mutable: true,
      fieldKind: "single_select",
      currentValue: "small",
      options: [
        { optionId: "large", label: "Large" },
        { optionId: "small", label: "Small" },
      ],
    }],
  } as const;
  const selection = {
    key: "model",
    expectedCatalogRevision: 5,
    expectedFieldRevision: 2,
    value: { fieldKind: "single_select", optionId: "large" },
  } as const;

  assert.equal(safeParseAgentConfigurationCatalog(catalog).success, true);
  assert.equal(safeParseAgentConfigurationSelectionFor(catalog, selection).success, true);
  assert.equal(
    safeParseAgentConfigurationSelectionFor(catalog, {
      ...selection,
      expectedCatalogRevision: 4,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentConfigurationSelectionFor(catalog, {
      ...selection,
      value: { fieldKind: "single_select", optionId: "unoffered" },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentConfigurationSelectionFor({
      ...catalog,
      fields: [{ ...catalog.fields[0], mutable: false }],
    }, selection).success,
    false,
  );
});

test("managed content and integration inventories are strict, ordered, and secret-free", () => {
  const content = {
    contentId: "content:review",
    revision: 1,
    kind: "skill",
    source: "team",
    status: "available",
    name: "Review",
    byteSize: 128,
    digest: { algorithm: "sha256", value: "a".repeat(64) },
    invocation: { kind: "provider_materialization" },
  } as const;
  assert.equal(
    safeParseAgentManagedContentCatalog({ revision: 1, entries: [content] }).success,
    true,
  );
  assert.equal(
    safeParseAgentManagedContentCatalog({ revision: 1, entries: [content, content] })
      .success,
    false,
  );
  assert.equal(
    safeParseAgentManagedContentCatalog({
      revision: 1,
      entries: [{ ...content, path: "/provider/private/skill.md" }],
    }).success,
    false,
  );

  const integration = {
    integrationId: "integration:mcp",
    revision: 1,
    kind: "mcp",
    name: "MCP",
    status: "ready",
    servers: [{
      serverId: "server:primary",
      name: "Primary",
      status: "ready",
      tools: [{ toolId: "tool:search", name: "Search" }],
      resources: [],
    }],
  } as const;
  assert.equal(
    safeParseAgentIntegrationCatalog({
      revision: 1,
      observedAt: "2026-08-31T12:00:00.000Z",
      integrations: [integration],
    })
      .success,
    true,
  );
  assert.equal(
    safeParseAgentIntegrationCatalog({
      revision: 1,
      observedAt: "2026-08-31T12:00:00.000Z",
      integrations: [{
        ...integration,
        servers: [{ ...integration.servers[0], token: "secret" }],
      }],
    }).success,
    false,
  );
});

test("collaboration and generated-resource shapes enforce lifecycle invariants", () => {
  const timestamp = "2026-08-31T12:00:00.000Z";
  assert.equal(
    safeParseAgentCollaborationSpawnInput({
      collaborationId: "collaboration:1",
      parentCollaborationId: "collaboration:1",
      role: "reviewer",
      title: "Implementation review",
      objective: "Review the change.",
      createdAt: timestamp,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCollaborationNode({
      collaborationId: "collaboration:1",
      rootCollaborationId: "collaboration:1",
      role: "reviewer",
      title: "Implementation review",
      status: "failed",
      objective: "Review the change.",
      usage: { kind: "unavailable" },
      createdAt: timestamp,
      updatedAt: timestamp,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCollaborationNode({
      collaborationId: "collaboration:1",
      rootCollaborationId: "collaboration:1",
      role: "reviewer",
      title: "Implementation review",
      status: "completed",
      objective: "Review the change.",
      usage: { kind: "reported" },
      outcome: { kind: "completed" },
      createdAt: timestamp,
      updatedAt: timestamp,
      terminalAt: timestamp,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCollaborationControlInput({
      action: "close",
      collaborationId: "collaboration:1",
      providerHandle: "native:1",
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentGeneratedResourceDescriptor({
      resourceId: "resource:1",
      kind: "image",
      status: "available",
      displayName: "Preview",
      producer: { kind: "session", sessionId: "session:1" },
      createdAt: timestamp,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentGeneratedResourceDescriptor({
      resourceId: "resource:1",
      kind: "image",
      status: "available",
      displayName: "Preview",
      producer: { kind: "session", sessionId: "session:1" },
      artifactId: "artifact:1",
      mediaType: "image/png",
      byteSize: 1024,
      sha256: "b".repeat(64),
      widthPixels: 32,
      heightPixels: 32,
      createdAt: timestamp,
    }).success,
    true,
  );
  assert.equal(
    safeParseAgentGeneratedResourceDescriptor({
      resourceId: "resource:missing-dimensions",
      kind: "image",
      status: "available",
      displayName: "Preview",
      producer: { kind: "session", sessionId: "session:1" },
      artifactId: "artifact:missing-dimensions",
      mediaType: "image/png",
      byteSize: 1024,
      sha256: "b".repeat(64),
      createdAt: timestamp,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentGeneratedResourceDescriptor({
      resourceId: "resource:expired-without-expiry",
      kind: "document",
      status: "expired",
      displayName: "Expired report",
      producer: { kind: "session", sessionId: "session:1" },
      createdAt: timestamp,
    }).success,
    false,
  );
});
