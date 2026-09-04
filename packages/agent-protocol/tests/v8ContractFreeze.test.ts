// ------------------------------------------------------------------------------------------------
//                v8ContractFreeze.test.ts - V8 public parser proofs - Dependencies: Node test, public protocol API
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAgentApprovalRequest,
  parseAgentApprovalResolution,
  parseAgentCapabilities,
  parseAgentEvent,
  parseAgentItemSnapshot,
  safeParseAgentApprovalRequest,
  safeParseAgentApprovalResolution,
  safeParseAgentCapabilities,
  safeParseAgentEvent,
  safeParseAgentItemSnapshot,
  safeParseAgentRequestResolutionFor,
} from '../src/index.js';
import {
  AgentApprovalCapabilitySchema,
  AgentCapabilitiesSchema,
} from '../src/zod/index.js';

// ------------------------------------------------------------------------------------------------
//                Frozen Positive Examples
// ------------------------------------------------------------------------------------------------

const onceApprovalRequest = {
  requestKind: 'approval',
  requestId: 'request:approval:1',
  prompt: 'Allow this exact edit?',
  subject: {
    kind: 'file_change',
    title: 'Edit the requested file',
    description: 'The agent is waiting to apply one bounded edit.',
    itemId: 'item:file-change:1',
  },
  options: [
    {
      optionId: 'approval:allow-once',
      label: 'Allow once',
      decision: 'approved',
      persistence: 'once',
      scope: { kind: 'exact_action' },
    },
    {
      optionId: 'approval:deny-once',
      label: 'Deny',
      decision: 'denied',
      persistence: 'once',
      scope: { kind: 'exact_action' },
    },
  ],
} as const;

function capabilitiesWithApproval(approval: unknown): unknown {
  return {
    protocolVersion: 8,
    providerKey: 'v8-contract-provider',
    sessions: { create: true, resume: false, branch: { kind: 'unsupported' } },
    turns: {
      interactionModes: ['default'],
      interrupt: false,
      steer: { kind: 'unsupported' },
    },
    requests: {
      approval,
      elicitation: { kind: 'unsupported' },
    },
    context: {
      usage: { kind: 'unsupported' },
      compaction: { kind: 'unsupported' },
    },
    input: { text: true, images: { kind: 'unsupported' } },
    output: {
      streaming: true,
      plans: false,
      fileChanges: 'none',
      artifactKinds: [],
    },
    configuration: { kind: 'managed' },
    operations: { kind: 'unsupported' },
    managedContent: { kind: 'unsupported' },
    integrations: { kind: 'unsupported' },
    collaboration: { kind: 'unsupported' },
    generatedResources: { kind: 'unsupported' },
    authentication: { kind: 'unsupported' },
    versionReporting: false,
  };
}

test('V8 approval capability and request freeze exact bounded once semantics', () => {
  const approvalCapability = {
    kind: 'supported',
    modes: [
      {
        persistence: 'once',
        scopeKinds: ['exact_action'],
      },
    ],
  } as const;
  assert.deepEqual(
    AgentApprovalCapabilitySchema.parse(approvalCapability),
    approvalCapability,
  );
  assert.deepEqual(
    parseAgentCapabilities(capabilitiesWithApproval(approvalCapability))
      .requests.approval,
    approvalCapability,
  );
  assert.deepEqual(parseAgentApprovalRequest(onceApprovalRequest), onceApprovalRequest);
  assert.deepEqual(
    parseAgentApprovalResolution({
      requestKind: 'approval',
      requestId: onceApprovalRequest.requestId,
      disposition: 'selected',
      optionId: 'approval:allow-once',
    }),
    {
      requestKind: 'approval',
      requestId: onceApprovalRequest.requestId,
      disposition: 'selected',
      optionId: 'approval:allow-once',
    },
  );
  assert.equal(
    safeParseAgentRequestResolutionFor(onceApprovalRequest, {
      requestKind: 'approval',
      requestId: onceApprovalRequest.requestId,
      disposition: 'selected',
      optionId: 'approval:not-offered',
    }).success,
    false,
  );
});

test('V8 context usage and compaction examples retain only bounded neutral facts', () => {
  const usage = {
    protocolVersion: 8,
    type: 'context.usage.updated',
    sessionId: 'session:1',
    turnId: 'turn:1',
    occurredAt: '2026-08-29T14:30:00.000Z',
    payload: {
      measurementScope: 'materialization',
      usedTokens: 3_933,
      maxTokens: 500_000,
      cumulative: {
        inputTokens: 3_933,
        outputTokens: 54,
        cachedReadTokens: 512,
        reasoningTokens: 43,
        modelCalls: 1,
        turns: 1,
      },
    },
  } as const;
  assert.deepEqual(parseAgentEvent(usage), usage);

  const compaction = {
    itemKind: 'context_compaction',
    itemId: 'context-compaction:0123456789abcdef:1',
    status: 'completed',
    title: 'Context compacted',
    details: {
      trigger: 'manual',
      beforeTokens: 84_000,
      afterTokens: 31_000,
      durationMs: 1_250,
      summaryPreview: 'Earlier context was compacted for continued work.',
    },
  } as const;
  assert.deepEqual(
    parseAgentItemSnapshot(compaction),
    compaction,
  );
});

// ------------------------------------------------------------------------------------------------
//                Frozen Negative Examples
// ------------------------------------------------------------------------------------------------

test('V8 approval freeze rejects ambiguous correlation, choices, and legacy decisions', () => {
  const invalidRequests = [
    {
      ...onceApprovalRequest,
      subject: {
        kind: 'file_change',
        title: 'Missing item correlation',
      },
    },
    {
      ...onceApprovalRequest,
      subject: {
        kind: 'plan',
        title: 'Wrong plan correlation',
        itemId: 'item:plan:1',
      },
    },
    {
      ...onceApprovalRequest,
      options: [],
    },
    {
      ...onceApprovalRequest,
      options: [onceApprovalRequest.options[0], onceApprovalRequest.options[0]],
    },
    {
      ...onceApprovalRequest,
      options: [
        {
          ...onceApprovalRequest.options[0],
          persistence: 'forever',
        },
      ],
    },
    {
      ...onceApprovalRequest,
      options: [
        {
          ...onceApprovalRequest.options[0],
          nativeRule: 'allow every matching provider request',
        },
      ],
    },
  ];
  for (const request of invalidRequests) {
    assert.equal(safeParseAgentApprovalRequest(request).success, false);
  }

  assert.equal(
    safeParseAgentApprovalResolution({
      requestKind: 'approval',
      requestId: 'request:approval:1',
      decision: 'approved',
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentApprovalResolution({
      requestKind: 'approval',
      requestId: 'request:approval:1',
      disposition: 'canceled',
      optionId: 'approval:allow-once',
    }).success,
    false,
  );
});

test('V8 capability freeze rejects duplicate and noncanonical modes/scopes', () => {
  const invalidCapabilities = [
    { kind: 'supported', modes: [] },
    {
      kind: 'supported',
      modes: [
        { persistence: 'once', scopeKinds: ['exact_action'] },
        { persistence: 'once', scopeKinds: ['exact_action'] },
      ],
    },
    {
      kind: 'supported',
      modes: [
        { persistence: 'session', scopeKinds: ['tool'] },
        { persistence: 'once', scopeKinds: ['exact_action'] },
      ],
    },
    {
      kind: 'supported',
      modes: [
        {
          persistence: 'session',
          scopeKinds: ['tool', 'exact_action'],
        },
      ],
    },
    {
      kind: 'supported',
      modes: [
        {
          persistence: 'once',
          scopeKinds: ['exact_action', 'exact_action'],
        },
      ],
    },
  ];
  for (const capability of invalidCapabilities) {
    const standalone = AgentApprovalCapabilitySchema.safeParse(capability);
    const embedded = AgentCapabilitiesSchema.safeParse(
      capabilitiesWithApproval(capability),
    );
    assert.equal(standalone.success, false);
    assert.equal(embedded.success, false);
    assert.equal(
      safeParseAgentCapabilities(capabilitiesWithApproval(capability)).success,
      false,
    );
    if (standalone.success || embedded.success) continue;
    assert.deepEqual(
      embedded.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.slice(2),
        message: issue.message,
      })),
      standalone.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      })),
    );
  }
});

test('V8 context freeze rejects impossible usage and compaction measurements', () => {
  const usageBase = {
    protocolVersion: 8,
    type: 'context.usage.updated',
    sessionId: 'session:1',
    turnId: 'turn:1',
    occurredAt: '2026-08-29T14:30:00.000Z',
    payload: {
      measurementScope: 'session',
      usedTokens: 10,
      maxTokens: 100,
    },
  } as const;
  const invalidUsage = [
    { ...usageBase, protocolVersion: 7 },
    {
      ...usageBase,
      payload: { ...usageBase.payload, usedTokens: 101 },
    },
    {
      ...usageBase,
      payload: {
        ...usageBase.payload,
        cumulative: {},
      },
    },
    {
      ...usageBase,
      payload: {
        ...usageBase.payload,
        compaction: { state: 'approaching', thresholdTokens: 101 },
      },
    },
    {
      ...usageBase,
      payload: {
        ...usageBase.payload,
        costUsd: 0.01,
      },
    },
  ];
  for (const usage of invalidUsage) {
    assert.equal(safeParseAgentEvent(usage).success, false);
  }

  const compactionBase = {
    itemKind: 'context_compaction',
    itemId: 'context-compaction:1',
    status: 'completed',
    details: {
      trigger: 'manual',
      beforeTokens: 100,
      afterTokens: 50,
    },
  } as const;
  const invalidCompactions = [
    {
      ...compactionBase,
      details: { trigger: 'manual', beforeTokens: 100 },
    },
    {
      ...compactionBase,
      details: {
        trigger: 'manual',
        beforeTokens: 100,
        afterTokens: 101,
      },
    },
    {
      ...compactionBase,
      details: {
        ...compactionBase.details,
        durationMs: 3_600_001,
      },
    },
    {
      ...compactionBase,
      details: {
        ...compactionBase.details,
        rawProviderSummary: 'private provider content',
      },
    },
  ];
  for (const compaction of invalidCompactions) {
    assert.equal(
      safeParseAgentItemSnapshot(compaction).success,
      false,
    );
  }
});
