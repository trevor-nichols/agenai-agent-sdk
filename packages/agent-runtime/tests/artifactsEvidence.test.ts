// ------------------------------------------------------------------------------------------------
//                artifactsEvidence.test.ts - Bounded evidence and artifact candidate coverage
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PROTOCOL_ID_MAX_LENGTH,
  agentProtocolSerializedJsonBytes,
  parseAgentArtifactId,
  type AgentJsonValue,
} from "@agen-ai/agent-protocol";

import {
  AgentArtifactCandidateError,
  createAgentAuthenticationOutput,
  createAgentArtifactCandidate,
  createAgentEventOutput,
  createAgentEvidenceOutput,
  createAgentProviderEvidence,
  createAgentProviderRequestContext,
  createAgentProviderReadiness,
  createBoundedAgentProviderData,
  redactAgentProviderData,
  validateBoundedAgentProviderData,
  validateAgentProviderOutput,
  validateAgentProviderReadiness,
} from "../src/index.js";
import { serializedAgentJsonValueBytes } from "../src/internal/serializedJsonBytes.js";

test("provider data is JSON-safe, secret-redacted, cycle-safe, and bounded", () => {
  const cyclic: Record<string, unknown> = {
    apiKey: "secret-value",
    nested: { password: "also-secret" },
  };
  cyclic.self = cyclic;

  const redactedCyclic = {
    apiKey: "[REDACTED]",
    nested: { password: "[REDACTED]" },
    self: "[Circular]",
  };
  assert.deepEqual(redactAgentProviderData(cyclic), redactedCyclic);

  const boundedCyclic = createBoundedAgentProviderData(cyclic);
  assert.deepEqual(boundedCyclic.data, redactedCyclic);
  assert.equal(boundedCyclic.truncated, true);
  assert.equal(
    boundedCyclic.truncationReason,
    "structural_limit_exceeded",
  );
  assert.equal(boundedCyclic.originalDataBytes, null);
  assert.deepEqual(
    validateBoundedAgentProviderData(boundedCyclic),
    boundedCyclic,
  );

  const accessorBacked: Record<string, unknown> = {};
  Object.defineProperty(accessorBacked, "value", {
    enumerable: true,
    get: () => "must-not-be-invoked",
  });
  const boundedAccessor = createBoundedAgentProviderData(accessorBacked);
  assert.deepEqual(boundedAccessor.data, { value: "[Accessor]" });
  assert.equal(boundedAccessor.truncated, true);
  assert.equal(
    boundedAccessor.truncationReason,
    "structural_limit_exceeded",
  );
  assert.equal(boundedAccessor.originalDataBytes, null);
  assert.deepEqual(
    validateBoundedAgentProviderData(boundedAccessor),
    boundedAccessor,
  );

  const symbolBacked = { visible: "preserved" };
  Object.defineProperty(symbolBacked, Symbol("evidence"), {
    enumerable: true,
    value: "not-json-portable",
  });
  const boundedSymbolKey = createBoundedAgentProviderData(symbolBacked);
  assert.deepEqual(boundedSymbolKey.data, { visible: "preserved" });
  assert.equal(boundedSymbolKey.truncated, true);
  assert.equal(
    boundedSymbolKey.truncationReason,
    "structural_limit_exceeded",
  );
  assert.equal(boundedSymbolKey.originalDataBytes, null);
  assert.deepEqual(
    validateBoundedAgentProviderData(boundedSymbolKey),
    boundedSymbolKey,
  );

  for (const extraKey of ["metadata", Symbol("evidence")]) {
    const arrayWithExtraProperty = ["preserved"];
    Object.defineProperty(arrayWithExtraProperty, extraKey, {
      enumerable: true,
      value: "not-json-portable",
    });
    const boundedArray = createBoundedAgentProviderData(arrayWithExtraProperty);
    assert.deepEqual(boundedArray.data, ["preserved"]);
    assert.equal(boundedArray.truncated, true);
    assert.equal(
      boundedArray.truncationReason,
      "structural_limit_exceeded",
    );
    assert.equal(boundedArray.originalDataBytes, null);
    assert.deepEqual(
      validateBoundedAgentProviderData(boundedArray),
      boundedArray,
    );
  }

  const uninspectable = new Proxy({}, {
    ownKeys() {
      throw new TypeError("must-not-escape-normalization");
    },
  });
  const boundedUninspectable = createBoundedAgentProviderData(uninspectable);
  assert.equal(boundedUninspectable.data, "[Uninspectable]");
  assert.equal(boundedUninspectable.truncated, true);
  assert.equal(
    boundedUninspectable.truncationReason,
    "structural_limit_exceeded",
  );
  assert.equal(boundedUninspectable.originalDataBytes, null);

  const unsupportedValues = [
    { value: Number.NaN, marker: "[NonFiniteNumber]" },
    { value: 1n, marker: "[Unsupported:bigint]" },
    { value: Symbol("evidence"), marker: "[Unsupported:symbol]" },
    { value: () => true, marker: "[Unsupported:function]" },
    { value: new Date(0), marker: "[Unsupported:Date]" },
  ] as const;
  for (const { value, marker } of unsupportedValues) {
    const boundedUnsupported = createBoundedAgentProviderData(value);
    assert.equal(boundedUnsupported.data, marker);
    assert.equal(boundedUnsupported.truncated, true);
    assert.equal(
      boundedUnsupported.truncationReason,
      "structural_limit_exceeded",
    );
    assert.equal(boundedUnsupported.originalDataBytes, null);
    assert.deepEqual(
      validateBoundedAgentProviderData(boundedUnsupported),
      boundedUnsupported,
    );
  }

  const sparse = new Array<unknown>(2);
  sparse[1] = "present";
  assert.deepEqual(redactAgentProviderData(sparse), [null, "present"]);

  const unsafeKeys = JSON.parse(
    '{"":"empty","constructor":"constructor","prototype":"prototype","__proto__":"proto"}',
  ) as Record<string, unknown>;
  unsafeKeys["x".repeat(129)] = "long";
  unsafeKeys.truncated_key_4 = "preserved";
  const normalizedKeys = createBoundedAgentProviderData(unsafeKeys);
  assert.equal(normalizedKeys.truncated, true);
  assert.equal(
    normalizedKeys.truncationReason,
    "structural_limit_exceeded",
  );
  assert.equal(normalizedKeys.originalDataBytes, null);
  assert.equal(
    Object.keys(normalizedKeys.data as Record<string, unknown>).length,
    6,
  );
  assert.deepEqual(
    new Set(Object.values(normalizedKeys.data as Record<string, unknown>)),
    new Set(["empty", "constructor", "prototype", "proto", "long", "preserved"]),
  );
  assert.deepEqual(
    validateBoundedAgentProviderData(normalizedKeys),
    normalizedKeys,
  );

  const escaped = redactAgentProviderData({
    controls: "\u0000\b\t\n\f\r",
    punctuation: "\"\\",
    unicode: "é😀\ud800",
  });
  const escapedBounded = createBoundedAgentProviderData(escaped);
  assert.equal(
    escapedBounded.dataBytes,
    agentProtocolSerializedJsonBytes(escaped),
  );

  const bounded = createBoundedAgentProviderData(
    { value: "x".repeat(30_000) },
    1_024,
  );
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.truncationReason, "byte_limit_exceeded");
  assert.ok(bounded.originalDataBytes > bounded.dataBytes);
  assert.deepEqual(bounded.data, {
    truncated: true,
    reason: "byte_limit_exceeded",
    originalDataBytes: bounded.originalDataBytes,
  });

  const veryLarge = createBoundedAgentProviderData({
    value: "x".repeat(100_000),
  });
  assert.equal(veryLarge.truncated, true);
  assert.deepEqual(validateBoundedAgentProviderData(veryLarge), veryLarge);
  assert.throws(
    () =>
      validateBoundedAgentProviderData({
        ...veryLarge,
        dataBytes: veryLarge.dataBytes + 1,
      }),
    TypeError,
  );

  const structurallyTruncated = createBoundedAgentProviderData(
    Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`key-${index}`, index]),
    ),
  );
  assert.equal(structurallyTruncated.truncated, true);
  assert.equal(
    structurallyTruncated.truncationReason,
    "structural_limit_exceeded",
  );
  assert.equal(structurallyTruncated.originalDataBytes, null);
  assert.equal(
    Object.keys(structurallyTruncated.data as Record<string, unknown>).length,
    100,
  );
  assert.deepEqual(
    validateBoundedAgentProviderData(structurallyTruncated),
    structurallyTruncated,
  );

  const structurallyAndByteTruncated = createBoundedAgentProviderData(
    Array.from({ length: 101 }, () => "x".repeat(100)),
    1_024,
  );
  assert.equal(structurallyAndByteTruncated.truncated, true);
  assert.equal(
    structurallyAndByteTruncated.truncationReason,
    "byte_and_structural_limits_exceeded",
  );
  assert.equal(structurallyAndByteTruncated.originalDataBytes, null);

  const depthTruncated = createBoundedAgentProviderData({
    level1: {
      level2: {
        level3: {
          level4: {
            level5: {
              level6: {
                level7: {
                  level8: { level9: "omitted" },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(depthTruncated.truncated, true);
  assert.equal(depthTruncated.truncationReason, "structural_limit_exceeded");
  assert.equal(depthTruncated.originalDataBytes, null);
});

test("provider JSON byte accounting does not require serialized payload materialization", () => {
  const representativeValues = [
    null,
    false,
    true,
    -0,
    1.25,
    1e21,
    "\u0000\b\t\n\f\r\"\\é😀\ud800\udc00",
    [null, false, "value"],
    { "quoted\"key": "value", nested: [1, true] },
  ] satisfies readonly AgentJsonValue[];
  for (const value of representativeValues) {
    assert.equal(
      serializedAgentJsonValueBytes(value),
      agentProtocolSerializedJsonBytes(value),
    );
  }

  const oversized = { value: "x".repeat(100_000) };
  assert.equal(
    serializedAgentJsonValueBytes(oversized),
    agentProtocolSerializedJsonBytes(oversized),
  );

  const bounded = createBoundedAgentProviderData(oversized);
  assert.equal(bounded.truncated, true);
  assert.equal(
    bounded.originalDataBytes,
    serializedAgentJsonValueBytes(oversized),
  );
});

test("authentication progress has strict status, error, URL, and ID invariants", () => {
  const providerLoginPrefix = "provider/login:";
  const providerLoginId = `${providerLoginPrefix}${"x".repeat(
    AGENT_PROTOCOL_ID_MAX_LENGTH - providerLoginPrefix.length,
  )}`;
  const completed = createAgentAuthenticationOutput({
    attemptId: "attempt:external",
    status: "completed",
    occurredAt: "2026-08-04T00:00:00.000Z",
    providerLoginId,
    verificationUrl: "https://example.com/device-login",
    userCode: "ABCD-EFGH",
    accountLabel: "Provider account",
  });
  assert.equal(completed.kind, "authentication");
  assert.equal(completed.progress.providerLoginId, providerLoginId);
  assert.equal(
    completed.progress.verificationUrl,
    "https://example.com/device-login",
  );

  assert.throws(
    () =>
      createAgentAuthenticationOutput({
        attemptId: "attempt:external",
        status: "failed",
        occurredAt: "2026-08-04T00:00:00.000Z",
      }),
    TypeError,
  );
  for (const progress of [
    { userCode: "   " },
    { userCode: "x".repeat(81) },
    { accountLabel: "   " },
    { accountLabel: "\u0085provider account" },
  ]) {
    assert.throws(
      () =>
        createAgentAuthenticationOutput({
          attemptId: "attempt:external",
          status: "completed",
          occurredAt: "2026-08-04T00:00:00.000Z",
          ...progress,
        }),
      TypeError,
    );
  }
  assert.throws(
    () =>
      createAgentAuthenticationOutput({
        attemptId: "attempt:external",
        status: "completed",
        occurredAt: "2026-08-04T00:00:00.000Z",
        verificationUrl: "http://example.com/device-login",
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createAgentAuthenticationOutput({
        attemptId: "attempt:external",
        status: "completed",
        occurredAt: "2026-08-04T00:00:00.000Z",
        verificationUrl: "https://user:password@example.com/device-login",
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createAgentAuthenticationOutput({
        attemptId: "attempt:external",
        status: "completed",
        occurredAt: "2026-08-04T00:00:00.000Z",
        verificationUrl: `https://example.com/${"x".repeat(2_048)}`,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createAgentAuthenticationOutput({
        attemptId: "attempt:external",
        status: "completed",
        occurredAt: "2026-08-04T00:00:00.000Z",
        verificationUrl: "file:///tmp/login",
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createAgentAuthenticationOutput({
        attemptId: " attempt:external ",
        status: "completed",
        occurredAt: "2026-08-04T00:00:00.000Z",
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createAgentAuthenticationOutput({
        attemptId: "attempt\u0085external",
        status: "completed",
        occurredAt: "2026-08-04T00:00:00.000Z",
      }),
    TypeError,
  );
});

test("provider evidence and readiness carry bounded technical data only", () => {
  const evidence = createAgentProviderEvidence({
    category: "provider_event",
    source: "native.turn.updated",
    data: { authorization: "Bearer private", state: "running" },
  });
  assert.equal(evidence.source, "native.turn.updated");
  assert.deepEqual(evidence.data, {
    authorization: "[REDACTED]",
    state: "running",
  });
  const unsafeEvidenceData = {
    authorization: "Bearer private",
    state: "running",
  };
  const unsafeEvidenceBytes = agentProtocolSerializedJsonBytes(
    unsafeEvidenceData,
  );
  assert.throws(
    () =>
      validateAgentProviderOutput({
        kind: "evidence",
        evidence: {
          category: "diagnostic",
          source: "native.turn.updated",
          data: unsafeEvidenceData,
          dataBytes: unsafeEvidenceBytes,
          originalDataBytes: unsafeEvidenceBytes,
          truncated: false,
          truncationReason: null,
          redacted: true,
        },
      }),
    /canonically normalized and redacted/u,
  );
  assert.throws(
    () =>
      createAgentProviderEvidence({
        category: "diagnostic",
        source: " invalid ",
        data: {},
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createAgentProviderEvidence({
        category: "diagnostic",
        source: "provider\u0085event",
        data: {},
      }),
    TypeError,
  );

  const readiness = createAgentProviderReadiness({
    status: "ready",
    checkedAt: "2026-08-04T00:00:00.000Z",
    version: "2.4.0",
    diagnostics: { token: "private", transport: "stdio" },
  });
  assert.equal(readiness.status, "ready");
  assert.deepEqual(readiness.diagnostics.data, {
    token: "[REDACTED]",
    transport: "stdio",
  });

  const readyWithReason = {
    ...readiness,
    reason: {
      code: "unexpected_warning",
      message: "Ready state cannot carry a failure reason.",
      retryable: false,
    },
  };
  assert.throws(
    () => createAgentProviderReadiness(readyWithReason),
    TypeError,
  );
  assert.throws(
    () => validateAgentProviderReadiness(readyWithReason),
    TypeError,
  );

  assert.throws(
    () =>
      validateAgentProviderReadiness({
        ...readiness,
        version: 42,
      } as never),
    TypeError,
  );
  for (const invalidVersion of [
    " ",
    " 2.4.0",
    "2.4.0 ",
    "2.4\n0",
  ]) {
    assert.throws(
      () => createAgentProviderReadiness({
        ...readiness,
        version: invalidVersion,
      }),
      TypeError,
    );
    assert.throws(
      () => validateAgentProviderReadiness({
        ...readiness,
        version: invalidVersion,
      }),
      TypeError,
    );
  }
  assert.throws(
    () =>
      validateAgentProviderOutput({
        kind: "lifecycle",
        lifecycle: {
          type: "process.ready",
          occurredAt: "2026-08-04T00:00:00.000Z",
          message: 42,
        },
      }),
    TypeError,
  );
});

test("provider source evidence is atomic with its event and standalone evidence is diagnostic", () => {
  const sourceEvidence = createAgentProviderEvidence({
    category: "provider_event",
    source: "native.turn.started",
    data: { state: "running" },
  });
  const eventOutput = createAgentEventOutput(
    {
      protocolVersion: 6,
      type: "turn.started",
      sessionId: "session:external",
      turnId: "turn:external",
      occurredAt: "2026-08-04T00:00:00.000Z",
      payload: {},
    },
    { evidence: sourceEvidence },
  );
  assert.equal(eventOutput.evidence?.category, "provider_event");

  const requestOutput = createAgentEventOutput(
    {
      protocolVersion: 6,
      type: "request.opened",
      sessionId: "session:external",
      turnId: "turn:external",
      occurredAt: "2026-08-04T00:00:00.000Z",
      payload: {
        request: {
          requestKind: "approval",
          requestId: "request:external",
          prompt: "Approve?",
          subject: { kind: "other", title: "External operation" },
        },
      },
    },
    {
      requestContext: createAgentProviderRequestContext({
        providerResponseId: 0,
      }),
    },
  );
  assert.deepEqual(requestOutput.requestContext?.data, {
    providerResponseId: 0,
  });
  assert.throws(
    () => createAgentProviderRequestContext({ token: "private" }),
    TypeError,
  );
  assert.throws(
    () =>
      createAgentProviderRequestContext({
        value: "x".repeat(20_000),
      }),
    RangeError,
  );
  const unsafeContextData = { token: "private" };
  const unsafeContextBytes = new TextEncoder().encode(
    JSON.stringify(unsafeContextData),
  ).byteLength;
  assert.throws(
    () =>
      validateAgentProviderOutput({
        ...requestOutput,
        requestContext: {
          data: unsafeContextData,
          dataBytes: unsafeContextBytes,
          originalDataBytes: unsafeContextBytes,
          truncated: false,
          truncationReason: null,
          redacted: true,
        },
      }),
    TypeError,
  );
  const oversizedContextData = { value: "x".repeat(20_000) };
  const oversizedContextBytes = new TextEncoder().encode(
    JSON.stringify(oversizedContextData),
  ).byteLength;
  assert.throws(
    () =>
      validateAgentProviderOutput({
        ...requestOutput,
        requestContext: {
          data: oversizedContextData,
          dataBytes: oversizedContextBytes,
          originalDataBytes: oversizedContextBytes,
          truncated: false,
          truncationReason: null,
          redacted: true,
        },
      }),
    RangeError,
  );

  const diagnosticOutput = createAgentEvidenceOutput({
    category: "diagnostic",
    source: "provider.stderr",
    data: { message: "diagnostic" },
  });
  assert.equal(diagnosticOutput.evidence.category, "diagnostic");
  assert.throws(
    () => validateAgentProviderOutput({ kind: "evidence", evidence: sourceEvidence }),
    /Standalone agent evidence must be diagnostic/u,
  );
});

test("event outputs reject Agent V4 and malformed V5 item variants before yielding", () => {
  const eventBase = {
    protocolVersion: 6,
    type: "item.completed",
    sessionId: "session:external",
    turnId: "turn:external",
    occurredAt: "2026-08-04T00:00:00.000Z",
  } as const;

  for (const event of [
    {
      ...eventBase,
      protocolVersion: 4,
      payload: {
        itemId: "item:command",
        itemKind: "command_execution",
        status: "completed",
      },
    },
    {
      ...eventBase,
      payload: {
        itemId: "item:command",
        itemKind: "command_execution",
        status: "completed",
        attributes: { commandSummary: "Retired V2 shape" },
      },
    },
    {
      ...eventBase,
      payload: {
        itemId: "item:assistant",
        itemKind: "assistant_message",
        status: "completed",
        details: { actionSummary: "Cross-kind detail" },
      },
    },
    {
      ...eventBase,
      payload: {
        itemId: "item:review",
        itemKind: "review",
        status: "completed",
      },
    },
  ]) {
    assert.throws(() => createAgentEventOutput(event), TypeError);
  }
});

test("byte artifact candidates are immutable, integrity checked, and enriched", () => {
  const source = new TextEncoder().encode("artifact body");
  const candidate = createAgentArtifactCandidate({
    descriptor: {
      artifactId: parseAgentArtifactId("artifact:diff-1"),
      kind: "diff",
      displayName: "working-tree.diff",
      mediaType: "text/x-diff",
    },
    source: { kind: "bytes", bytes: source },
    delivery: "best_effort",
  });
  source.fill(0);

  assert.equal(candidate.source.kind, "bytes");
  if (candidate.source.kind === "bytes") {
    assert.equal(
      new TextDecoder().decode(candidate.source.bytes),
      "artifact body",
    );
  }
  assert.equal(candidate.descriptor.byteSize, 13);
  assert.match(candidate.descriptor.digest?.value ?? "", /^[a-f0-9]{64}$/u);

  assert.throws(
    () =>
      createAgentArtifactCandidate({
        descriptor: {
          artifactId: parseAgentArtifactId("artifact:diff-2"),
          kind: "diff",
          displayName: "bad.diff",
          byteSize: 99,
        },
        source: { kind: "bytes", bytes: new Uint8Array([1]) },
        delivery: "best_effort",
      }),
    (error: unknown) =>
      error instanceof AgentArtifactCandidateError &&
      error.code === "byte_size_mismatch",
  );
});

test("plan candidates require pre-reference delivery and file paths stay technical", () => {
  assert.throws(
    () =>
      createAgentArtifactCandidate({
        descriptor: {
          artifactId: parseAgentArtifactId("artifact:plan-1"),
          kind: "plan",
          displayName: "plan.md",
        },
        source: { kind: "file", filePath: "/tmp/plan.md" },
        delivery: "best_effort",
      }),
    (error: unknown) =>
      error instanceof AgentArtifactCandidateError &&
      error.code === "invalid_delivery",
  );

  const candidate = createAgentArtifactCandidate({
    descriptor: {
      artifactId: parseAgentArtifactId("artifact:plan-1"),
      kind: "plan",
      displayName: "plan.md",
    },
    source: { kind: "file", filePath: "/host-resolved/session/plan.md" },
    delivery: "required_before_reference",
  });
  assert.equal(candidate.source.kind, "file");

  assert.throws(
    () =>
      createAgentArtifactCandidate({
        descriptor: {
          artifactId: parseAgentArtifactId("artifact:plan-c1"),
          kind: "plan",
          displayName: "plan.md",
        },
        source: {
          kind: "file",
          filePath: "/host-resolved/session/plan\u0085draft.md",
        },
        delivery: "required_before_reference",
      }),
    (error: unknown) =>
      error instanceof AgentArtifactCandidateError &&
      error.code === "invalid_source",
  );
});
