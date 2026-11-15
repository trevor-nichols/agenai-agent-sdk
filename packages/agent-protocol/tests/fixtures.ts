// ------------------------------------------------------------------------------------------------
//                fixtures.ts - Shared valid protocol fixture corpus
// ------------------------------------------------------------------------------------------------

export const protocolTimestamp = '2026-08-03T20:00:00.000Z';

const unsupportedInput = {
  contentReferences: { kind: "unsupported" as const },
  text: true,
  images: { kind: 'unsupported' },
} as const;

const supportedInput = {
  contentReferences: { kind: "unsupported" as const },
  text: true,
  images: {
    kind: 'supported',
    sourceKinds: ['url', 'base64', 'local_file'],
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxImages: 6,
    maxBytesPerImage: 10 * 1024 * 1024,
    maxTotalBytes: 25 * 1024 * 1024,
    maxWidthPixels: 6_000,
    maxHeightPixels: 6_000,
    maxPixelsPerImage: 36_000_000,
    supportsImageOnly: true,
  },
} as const;

const onceApproval = {
  kind: 'supported', providerManagedRemembrance: false,
  modes: [{ persistence: 'once', scopeKinds: ['exact_action'] }],
} as const;

const unsupportedContext = {
  usage: { kind: 'unsupported' },
  compaction: { kind: 'unsupported' },
} as const;

const supportedContext = {
  usage: {
    kind: 'supported',
    measurementScopes: ['materialization'],
  },
  compaction: {
    kind: 'supported',
    triggers: ['manual'],
    sameSessionContinuation: true,
  },
} as const;

export const fixtureUsageView = {
  viewId: 'usage-view:materialization',
  authority: 'authoritative',
  accounting: 'snapshot',
  countBasis: { modelCalls: 'unsupported', turns: 'unsupported' },
  population: { descendants: 'unknown', auxiliary: 'unknown' },
} as const;

const supportedTokenUsage = {
  kind: 'supported',
  views: [{
    view: fixtureUsageView,
    scopeKind: 'materialization',
    reportedCounters: [
      'inputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'outputTokens',
    ],
    attribution: ['model', 'mixed'],
  }],
} as const;

const supportedElicitation = {
  kind: 'supported',
  fieldKinds: [
    'text',
    'single_select',
    'multi_select',
    'boolean',
    'confirmation',
  ],
  maxFields: 16,
  sensitiveFields: true,
} as const;

const unsupportedNativeDomains = {
  operations: { kind: 'unsupported' },
  managedContent: { kind: 'unsupported' },
  integrations: { kind: 'unsupported' },
  collaboration: { kind: 'unsupported' },
  generatedResources: { kind: 'unsupported' },
} as const;

const supportedNativeDomains = {
  operations: {
    kind: 'supported',
    operationKinds: [
      'session_control',
      'managed_content_invoke',
      'configuration_select',
      'integration_control',
      'collaboration_control',
      'resource_generate',
    ],
    fieldKinds: [
      'text',
      'boolean',
      'single_select',
      'multi_select',
      'integer',
    ],
    executionModes: ['immediate', 'request_continuation', 'durable_job'],
    maxOperations: 100,
    maxFieldsPerOperation: 16,
  },
  managedContent: {
    kind: 'supported',
    contentKinds: ['skill', 'rule', 'prompt', 'agent_definition'],
    maxEntries: 100,
  },
  integrations: {
    kind: 'supported',
    integrationKinds: ['mcp'],
    maxIntegrations: 32,
    maxServersPerIntegration: 32,
    maxToolsPerServer: 100,
    maxResourcesPerServer: 100,
  },
  collaboration: {
    kind: 'supported',
    roles: ['delegate', 'reviewer', 'researcher', 'specialist'],
    controlActions: ['spawn', 'steer', 'stop', 'close', 'inspect'],
    maxDepth: 8,
    maxChildrenPerNode: 16,
    maxActiveNodes: 64,
  },
  generatedResources: {
    kind: 'supported',
    resourceKinds: ['image', 'document', 'archive'],
    maxResourcesPerTurn: 16,
    maxBytesPerResource: 25 * 1024 * 1024,
  },
} as const;

export const providerCapabilityFixtures = {
  fixture: {
    environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
    protocolVersion: 14,
    providerKey: 'fixture',
    sessions: { create: true, resume: true, branch: { kind: 'through_turn' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      structuredOutput: { kind: 'unsupported' },
      steer: { kind: 'supported', input: supportedInput },
    },
    requests: { approval: onceApproval, elicitation: supportedElicitation },
    context: supportedContext,
    tokenUsage: supportedTokenUsage,
    input: supportedInput,
    output: {
      streaming: true,
      plans: true,
      fileChanges: 'structured',
      artifactKinds: ['plan', 'diff'],
    },
    configuration: {
      kind: 'selectable',
      fieldKinds: [
        'boolean',
        'single_select',
        'bounded_integer',
        'bounded_text',
      ],
      maxFields: 100,
    },
    ...supportedNativeDomains,
    authentication: { kind: 'supported', flows: ['device_code'] },
    versionReporting: true,
  },
  codex: {
    environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
    protocolVersion: 14,
    providerKey: 'codex',
    sessions: { create: true, resume: true, branch: { kind: 'through_turn' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      structuredOutput: { kind: 'unsupported' },
      steer: { kind: 'supported', input: unsupportedInput },
    },
    requests: { approval: onceApproval, elicitation: supportedElicitation },
    context: unsupportedContext,
    tokenUsage: { kind: 'unsupported' },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: true,
      fileChanges: 'structured',
      artifactKinds: ['diff'],
    },
    configuration: { kind: 'managed' },
    ...unsupportedNativeDomains,
    authentication: { kind: 'supported', flows: ['device_code'] },
    versionReporting: true,
  },
  claudeCode: {
    environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
    protocolVersion: 14,
    providerKey: 'claude_code',
    sessions: { create: true, resume: true, branch: { kind: 'through_turn' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      structuredOutput: { kind: 'unsupported' },
      steer: { kind: 'unsupported' },
    },
    requests: { approval: onceApproval, elicitation: supportedElicitation },
    context: unsupportedContext,
    tokenUsage: { kind: 'unsupported' },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: false,
      fileChanges: 'final_diff',
      artifactKinds: ['diff'],
    },
    configuration: { kind: 'managed' },
    ...unsupportedNativeDomains,
    authentication: { kind: 'supported', flows: ['browser'] },
    versionReporting: true,
  },
  opencode: {
    environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
    protocolVersion: 14,
    providerKey: 'opencode',
    sessions: { create: true, resume: true, branch: { kind: 'through_turn' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      structuredOutput: { kind: 'unsupported' },
      steer: { kind: 'unsupported' },
    },
    requests: { approval: onceApproval, elicitation: supportedElicitation },
    context: unsupportedContext,
    tokenUsage: { kind: 'unsupported' },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: false,
      fileChanges: 'final_diff',
      artifactKinds: ['diff'],
    },
    configuration: { kind: 'managed' },
    ...unsupportedNativeDomains,
    authentication: { kind: 'unsupported' },
    versionReporting: true,
  },
  cursor: {
    environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
    protocolVersion: 14,
    providerKey: 'cursor_acp',
    sessions: { create: true, resume: true, branch: { kind: 'unsupported' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      structuredOutput: { kind: 'unsupported' },
      steer: { kind: 'unsupported' },
    },
    requests: { approval: onceApproval, elicitation: supportedElicitation },
    context: unsupportedContext,
    tokenUsage: { kind: 'unsupported' },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: true,
      fileChanges: 'structured',
      artifactKinds: ['plan', 'diff'],
    },
    configuration: { kind: 'managed' },
    ...unsupportedNativeDomains,
    authentication: { kind: 'unsupported' },
    versionReporting: true,
  },
  grokBuild: {
    environment: { instance: { kind: "unsupported" as const }, session: { kind: "unsupported" as const } },
    protocolVersion: 14,
    providerKey: 'grok_build',
    sessions: { create: true, resume: true, branch: { kind: 'unsupported' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      structuredOutput: { kind: 'unsupported' },
      steer: { kind: 'unsupported' },
    },
    requests: { approval: onceApproval, elicitation: { kind: 'unsupported' } },
    context: supportedContext,
    tokenUsage: { kind: 'unsupported' },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: true,
      fileChanges: 'structured',
      artifactKinds: ['diff'],
    },
    configuration: { kind: 'managed' },
    ...unsupportedNativeDomains,
    authentication: { kind: 'unsupported' },
    versionReporting: true,
  },
} as const;

const eventBase = {
  protocolVersion: 14,
  sessionId: 'session:external-42',
  turnId: 'turn:external-9',
  occurredAt: protocolTimestamp,
} as const;

export const eventFixtureCorpus = [
  { ...eventBase, type: 'turn.started', payload: { message: 'Started.' } },
  {
    ...eventBase,
    type: 'turn.state_changed',
    payload: { state: 'waiting_for_request', requestId: 'request:1' },
  },
  {
    ...eventBase,
    type: 'turn.completed',
    payload: { outcome: 'completed', structuredOutput: { kind: 'not_requested' }, reason: 'Done.' },
  },
  {
    ...eventBase,
    type: 'item.started',
    payload: {
      itemId: 'item:1',
      itemKind: 'assistant_message',
      status: 'in_progress',
    },
  },
  {
    ...eventBase,
    type: 'item.updated',
    payload: {
      itemId: 'item:1',
      itemKind: 'assistant_message',
      status: 'in_progress',
      summary: 'Working.',
    },
  },
  {
    ...eventBase,
    type: 'item.completed',
    payload: {
      itemId: 'item:1',
      itemKind: 'assistant_message',
      status: 'completed',
    },
  },
  {
    ...eventBase,
    type: 'content.delta',
    payload: {
      itemId: 'item:1',
      streamKind: 'assistant_text',
      delta: 'Hello.',
    },
  },
  {
    ...eventBase,
    type: 'turn.plan.updated',
    payload: {
      explanation: 'Implementation plan',
      steps: [{
        stepId: 'step:1',
        text: 'Inspect files',
        status: 'completed',
        priority: 'high',
      }],
    },
  },
  {
    ...eventBase,
    type: 'turn.plan.proposed',
    payload: { artifactId: 'artifact:plan-1', requestId: 'request:plan-1' },
  },
  {
    ...eventBase,
    type: 'turn.diff.updated',
    payload: { summary: 'Changed one file.', fileCount: 1, byteSize: 120 },
  },
  {
    ...eventBase,
    type: 'request.opened',
    payload: {
      request: {
        requestKind: 'approval',
        requestId: 'request:1',
        prompt: 'Apply the change?',
        subject: {
          kind: 'file_change',
          title: 'Update README',
          itemId: 'item:1',
        },
        options: [
          {
            optionId: 'approval:allow-once',
            label: 'Allow once',
            decision: 'approved',
            consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } },
          },
          {
            optionId: 'approval:deny-once',
            label: 'Deny',
            decision: 'denied',
            consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } },
          },
        ],
      },
    },
  },
  {
    ...eventBase,
    type: 'progress.updated',
    payload: {
      progressId: 'progress:1',
      kind: 'task',
      phase: 'updated',
      current: 1,
      total: 2,
    },
  },
  {
    ...eventBase,
    type: 'context.usage.updated',
    payload: {
      measurementScope: 'materialization',
      usedTokens: 3_933,
      maxTokens: 500_000,
      compaction: { state: 'idle' },
    },
  },
  {
    ...eventBase,
    type: 'usage.observed',
    payload: {
      observationId: 'usage:materialization-1:result-0',
      view: fixtureUsageView,
      scope: { scopeId: 'usage-scope:materialization-1', kind: 'materialization' },
      measurement: {
        kind: 'snapshot',
        epoch: 0,
        revision: 0,
        origin: { kind: 'fresh_zero', cause: 'initial' },
        comparison: {
          inputTokens: { kind: 'stable', populationId: 'population:input' },
          cacheReadInputTokens: { kind: 'stable', populationId: 'population:cache-read' },
          cacheCreationInputTokens: { kind: 'stable', populationId: 'population:cache-creation' },
          cacheCreationFiveMinuteInputTokens: { kind: 'unknown' },
          cacheCreationOneHourInputTokens: { kind: 'unknown' },
          outputTokens: { kind: 'stable', populationId: 'population:output' },
          reasoningOutputTokens: { kind: 'unknown' },
          modelCalls: { kind: 'unknown' },
          turns: { kind: 'unknown' },
        },
        coverage: { kind: 'complete' },
        counters: {
          inputTokens: { kind: 'exact', value: 1_110 },
          cacheReadInputTokens: { kind: 'exact', value: 100 },
          cacheCreationInputTokens: { kind: 'exact', value: 1_000 },
          cacheCreationFiveMinuteInputTokens: { kind: 'unavailable', reasons: ['unsupported'] },
          cacheCreationOneHourInputTokens: { kind: 'unavailable', reasons: ['unsupported'] },
          outputTokens: { kind: 'exact', value: 1 },
          reasoningOutputTokens: { kind: 'unavailable', reasons: ['unsupported'] },
          modelCalls: { kind: 'unavailable', reasons: ['unsupported'] },
          turns: { kind: 'unavailable', reasons: ['unsupported'] },
        },
        attribution: { kind: 'model', model: { modelId: 'model:scripted' } },
      },
      finality: 'open',
    },
  },
  {
    ...eventBase,
    type: 'artifact.referenced',
    payload: {
      artifact: {
        artifactId: 'artifact:1',
        kind: 'diff',
        displayName: 'working-tree.diff',
        mediaType: 'text/x-diff',
        byteSize: 120,
      },
    },
  },
  {
    ...eventBase,
    type: 'operation.updated',
    payload: {
      result: {
        invocationId: 'operation-invocation:1',
        status: 'completed',
      },
    },
  },
  {
    ...eventBase,
    type: 'collaboration.updated',
    payload: {
      node: {
        collaborationId: 'collaboration:1',
        rootCollaborationId: 'collaboration:1',
        role: 'delegate',
        title: 'Implementation inspection',
        status: 'completed',
        objective: 'Inspect the implementation.',
        progress: 'Inspection complete.',
        usage: { kind: 'reference', scopeId: 'usage-scope:materialization-1' },
        outcome: { kind: 'completed' },
        createdAt: protocolTimestamp,
        updatedAt: protocolTimestamp,
        terminalAt: protocolTimestamp,
      },
    },
  },
  {
    ...eventBase,
    type: 'resource.updated',
    payload: {
      resource: {
        resourceId: 'resource:1',
        kind: 'image',
        status: 'available',
        displayName: 'Generated preview',
        producer: { kind: 'turn', turnId: 'turn:1' },
        mediaType: 'image/png',
        byteSize: 120,
        sha256: 'd'.repeat(64),
        widthPixels: 16,
        heightPixels: 16,
        artifactId: 'artifact:generated-1',
        createdAt: protocolTimestamp,
      },
    },
  },
  {
    ...eventBase,
    type: 'runtime.retrying',
    payload: {
      owner: 'provider',
      error: {
        category: 'overloaded',
        code: 'provider_busy',
        message: 'The provider is retrying its request.',
        recovery: { kind: 'retry' },
      },
    },
  },
  {
    ...eventBase,
    type: 'runtime.warning',
    payload: { code: 'partial_output', message: 'Output was truncated.' },
  },
  {
    ...eventBase,
    type: 'runtime.error',
    payload: {
      error: { category: 'unknown', code: 'turn_failed', message: 'Turn failed.', recovery: { kind: 'unknown' } },
    },
  },
  {
    ...eventBase,
    type: 'provider.diagnostic',
    payload: { code: 'native_notice', message: 'Provider emitted a notice.' },
  },
  { ...eventBase, type: 'request.unavailable', payload: { requestId: 'request:1', reason: 'withdrawn' } },
] as const;
