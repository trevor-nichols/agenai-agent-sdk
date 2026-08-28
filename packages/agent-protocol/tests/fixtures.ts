// ------------------------------------------------------------------------------------------------
//                fixtures.ts - Shared valid protocol fixture corpus
// ------------------------------------------------------------------------------------------------

export const protocolTimestamp = '2026-08-03T20:00:00.000Z';

const unsupportedInput = {
  text: true,
  images: { kind: 'unsupported' },
} as const;

const supportedInput = {
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

export const providerCapabilityFixtures = {
  fixture: {
    protocolVersion: 6,
    providerKey: 'fixture',
    sessions: { create: true, resume: true, branch: { kind: 'through_turn' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      steer: { kind: 'supported', input: supportedInput },
    },
    requests: {
      approval: { kind: 'supported', scopes: ['once', 'session'] },
      elicitation: { kind: 'structured' },
    },
    input: supportedInput,
    output: {
      streaming: true,
      plans: true,
      fileChanges: 'structured',
      artifactKinds: ['plan', 'diff'],
    },
    configuration: {
      kind: 'selectable',
      fields: [
        { key: 'mode', optionIds: ['agent'] },
        { key: 'model', optionIds: ['fixture-model'] },
        { key: 'permission_mode', optionIds: ['workspace-write'] },
        { key: 'reasoning_effort', optionIds: ['standard'] },
      ],
    },
    interactionExtensions: {
      slashCommands: true,
      mcp: true,
      subagents: true,
      imageGeneration: true,
    },
    authentication: { kind: 'supported', flows: ['device_code'] },
    versionReporting: true,
  },
  codex: {
    protocolVersion: 6,
    providerKey: 'codex',
    sessions: { create: true, resume: true, branch: { kind: 'through_turn' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      steer: { kind: 'supported', input: unsupportedInput },
    },
    requests: {
      approval: { kind: 'supported', scopes: ['once'] },
      elicitation: { kind: 'structured' },
    },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: true,
      fileChanges: 'structured',
      artifactKinds: ['diff'],
    },
    configuration: { kind: 'managed' },
    interactionExtensions: {
      slashCommands: false,
      mcp: false,
      subagents: false,
      imageGeneration: false,
    },
    authentication: { kind: 'supported', flows: ['device_code'] },
    versionReporting: true,
  },
  claudeCode: {
    protocolVersion: 6,
    providerKey: 'claude_code',
    sessions: { create: true, resume: true, branch: { kind: 'through_turn' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      steer: { kind: 'unsupported' },
    },
    requests: {
      approval: { kind: 'supported', scopes: ['once'] },
      elicitation: { kind: 'structured' },
    },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: false,
      fileChanges: 'final_diff',
      artifactKinds: ['diff'],
    },
    configuration: { kind: 'managed' },
    interactionExtensions: {
      slashCommands: false,
      mcp: true,
      subagents: false,
      imageGeneration: false,
    },
    authentication: { kind: 'supported', flows: ['browser'] },
    versionReporting: true,
  },
  opencode: {
    protocolVersion: 6,
    providerKey: 'opencode',
    sessions: { create: true, resume: true, branch: { kind: 'through_turn' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      steer: { kind: 'unsupported' },
    },
    requests: {
      approval: { kind: 'supported', scopes: ['once'] },
      elicitation: { kind: 'structured' },
    },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: false,
      fileChanges: 'final_diff',
      artifactKinds: ['diff'],
    },
    configuration: { kind: 'managed' },
    interactionExtensions: {
      slashCommands: false,
      mcp: false,
      subagents: false,
      imageGeneration: false,
    },
    authentication: { kind: 'unsupported' },
    versionReporting: true,
  },
  cursor: {
    protocolVersion: 6,
    providerKey: 'cursor_acp',
    sessions: { create: true, resume: true, branch: { kind: 'unsupported' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      steer: { kind: 'unsupported' },
    },
    requests: {
      approval: { kind: 'supported', scopes: ['once'] },
      elicitation: { kind: 'structured' },
    },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: true,
      fileChanges: 'structured',
      artifactKinds: ['plan', 'diff'],
    },
    configuration: { kind: 'managed' },
    interactionExtensions: {
      slashCommands: false,
      mcp: false,
      subagents: false,
      imageGeneration: false,
    },
    authentication: { kind: 'unsupported' },
    versionReporting: true,
  },
  grokBuild: {
    protocolVersion: 6,
    providerKey: 'grok_build',
    sessions: { create: true, resume: true, branch: { kind: 'unsupported' } },
    turns: {
      interactionModes: ['default'],
      interrupt: true,
      steer: { kind: 'unsupported' },
    },
    requests: {
      approval: { kind: 'supported', scopes: ['once'] },
      elicitation: { kind: 'unsupported' },
    },
    input: unsupportedInput,
    output: {
      streaming: true,
      plans: true,
      fileChanges: 'structured',
      artifactKinds: ['diff'],
    },
    configuration: { kind: 'managed' },
    interactionExtensions: {
      slashCommands: false,
      mcp: false,
      subagents: false,
      imageGeneration: false,
    },
    authentication: { kind: 'unsupported' },
    versionReporting: true,
  },
} as const;

const eventBase = {
  protocolVersion: 6,
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
    payload: { outcome: 'completed', reason: 'Done.' },
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
          itemId: 'item:file-change-1',
          title: 'Update README',
        },
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
    payload: { usedTokens: 1_024, totalTokens: 8_192, usedPercent: 12.5 },
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
    type: 'runtime.warning',
    payload: { code: 'partial_output', message: 'Output was truncated.' },
  },
  {
    ...eventBase,
    type: 'runtime.error',
    payload: {
      error: { code: 'turn_failed', message: 'Turn failed.', retryable: true },
    },
  },
  {
    ...eventBase,
    type: 'provider.diagnostic',
    payload: { code: 'native_notice', message: 'Provider emitted a notice.' },
  },
] as const;
