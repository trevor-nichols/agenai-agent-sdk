// ------------------------------------------------------------------------------------------------
//                events.test.ts - Event taxonomy, strictness, bytes, and round-trip coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_EVENT_TYPES,
  AGENT_PROTOCOL_EVENT_BYTES_LIMIT,
  AGENT_PROTOCOL_VERSION,
  agentProtocolSerializedJsonBytes,
  parseAgentEvent,
  safeParseAgentEvent,
} from '../src/public/index.js';
import { eventFixtureCorpus, protocolTimestamp } from './fixtures.js';

test('provider retry observations preserve absent counters and validate reported retry ordinals', () => {
  const event = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId: 'session:retry',
    turnId: 'turn:retry',
    occurredAt: protocolTimestamp,
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
  } as const;
  assert.deepEqual(parseAgentEvent(event), event);
  for (const counters of [
    { attempt: 1 },
    { maxAttempts: 2 },
    { attempt: 2, maxAttempts: 2, delayMs: 0 },
    { attempt: Number.MAX_SAFE_INTEGER, maxAttempts: Number.MAX_SAFE_INTEGER, delayMs: Number.MAX_SAFE_INTEGER },
  ]) {
    const input = { ...event, payload: { ...event.payload, ...counters } };
    assert.deepEqual(parseAgentEvent(input), input);
  }
  for (const counters of [
    { attempt: 0 },
    { attempt: -1 },
    { attempt: 1.5 },
    { attempt: Number.MAX_SAFE_INTEGER + 1 },
    { maxAttempts: -1 },
    { maxAttempts: 0 },
    { maxAttempts: 1.5 },
    { maxAttempts: Number.MAX_SAFE_INTEGER + 1 },
    { attempt: 1, maxAttempts: 0 },
    { attempt: 3, maxAttempts: 2 },
    { delayMs: -1 },
    { delayMs: 0.5 },
    { delayMs: Number.POSITIVE_INFINITY },
    { delayMs: Number.MAX_SAFE_INTEGER + 1 },
    { owner: 'host' },
    { requestId: 'native-request' },
  ]) {
    assert.equal(safeParseAgentEvent({ ...event, payload: { ...event.payload, ...counters } }).success, false);
  }
  const { turnId: _turnId, ...sessionOnly } = event;
  assert.equal(safeParseAgentEvent(sessionOnly).success, false);
});

test('the fixture corpus covers every provider-observed event discriminant', () => {
  assert.deepEqual(
    eventFixtureCorpus.map((event) => event.type).sort(),
    [...AGENT_EVENT_TYPES].sort(),
  );
  for (const fixture of eventFixtureCorpus) {
    const parsed = parseAgentEvent(fixture);
    const serialized = JSON.stringify(parsed);
    const roundTripped = parseAgentEvent(JSON.parse(serialized));
    assert.equal(JSON.stringify(roundTripped), serialized, fixture.type);
  }
});

test('events reject unsupported versions, unknown fields, and product coordinates', () => {
  const base = eventFixtureCorpus[0];
  for (const invalid of [
    { ...base, protocolVersion: 10 },
    { ...base, protocolVersion: 9 },
    { ...base, protocolVersion: 8 },
    { ...base, protocolVersion: 2 },
    { ...base, protocolVersion: 1 },
    { ...base, unexpected: true },
    { ...base, teamId: 1 },
    { ...base, workspaceId: 2 },
    { ...base, assignedUserId: 3 },
    { ...base, providerInstanceId: 4 },
    { ...base, visibility: 'member' },
    { ...base, sequence: 1 },
    { ...base, type: 'runtime.warning', payload: { code: 'warning', message: 'Warning.', retryable: true } },
    {
      ...base,
      type: 'runtime.error',
      payload: { error: { code: 'turn_failed', message: 'Failed.', retryable: false } },
    },
  ]) {
    assert.equal(safeParseAgentEvent(invalid).success, false);
  }
});

test('events enforce reference, state, terminal, progress, and byte invariants', () => {
  const base = {
    protocolVersion: 11,
    sessionId: 'session:1',
    turnId: 'turn:1',
    occurredAt: protocolTimestamp,
  };
  for (const invalid of [
    { ...eventFixtureCorpus[0], providerRefs: {} },
    {
      ...base,
      type: 'turn.state_changed',
      payload: { state: 'waiting_for_request' },
    },
    {
      ...base,
      type: 'turn.completed',
      payload: { outcome: 'failed' },
    },
    {
      ...base,
      type: 'progress.updated',
      payload: {
        progressId: 'progress:1',
        kind: 'task',
        phase: 'updated',
        current: 2,
        total: 1,
      },
    },
    {
      ...base,
      type: 'content.delta',
      payload: {
        itemId: 'item:1',
        streamKind: 'assistant_text',
        delta: 'x'.repeat(AGENT_PROTOCOL_EVENT_BYTES_LIMIT),
      },
    },
  ]) {
    assert.equal(safeParseAgentEvent(invalid).success, false);
  }

  const valid = parseAgentEvent(eventFixtureCorpus[6]);
  assert.ok(
    agentProtocolSerializedJsonBytes(valid) < AGENT_PROTOCOL_EVENT_BYTES_LIMIT,
  );
});

test('retry, runtime-error, and failed-turn events preserve shared failure refinements', () => {
  const error = {
    category: 'quota_exhausted',
    code: 'allowance_exhausted',
    message: 'The included allowance was exhausted.',
    recovery: {
      kind: 'wait_for_quota',
      quota: { sourceId: 'source:1', poolId: 'pool:1', windowId: 'window:1', observedAt: protocolTimestamp },
    },
  } as const;
  for (const [type, payload] of [
    ['runtime.retrying', { owner: 'provider', error }],
    ['runtime.error', { error }],
    ['turn.completed', { outcome: 'failed', error }],
  ] as const) {
    const event = {
      protocolVersion: 11, sessionId: 'session:1', turnId: 'turn:1',
      occurredAt: protocolTimestamp, type, payload,
    };
    assert.deepEqual(parseAgentEvent(event), event);
    assert.equal(safeParseAgentEvent({
      ...event, payload: { ...payload, error: { ...error, category: 'execution_limit' } },
    }).success, false, type);
  }
});

test('events reject noncanonical identifiers and diagnostic strings', () => {
  const base = {
    protocolVersion: 11,
    sessionId: 'session:1',
    turnId: 'turn:1',
    occurredAt: protocolTimestamp,
  } as const;
  const invalidEvents = [
    {
      ...base,
      type: 'progress.updated',
      payload: {
        progressId: ' progress:1 ',
        kind: 'task',
        phase: 'started',
      },
    },
    {
      ...base,
      type: 'turn.plan.updated',
      payload: {
        steps: [
          { stepId: ' step:1 ', text: 'Inspect files', status: 'pending' },
        ],
      },
    },
    {
      ...base,
      type: 'item.started',
      payload: {
        itemId: 'item:1',
        itemKind: 'mcp_tool_call',
        status: 'in_progress',
        details: { serverName: ' server ' },
      },
    },
    {
      ...base,
      type: 'runtime.warning',
      payload: { code: ' warning ', message: 'Warning.' },
    },
    {
      ...base,
      type: 'runtime.warning',
      payload: { code: 'warning', message: ' Warning. ' },
    },
    {
      ...base,
      type: 'runtime.error',
      payload: {
        error: {
          code: 'turn_failed',
          message: 'Turn failed.',
          category: 'unknown',
          recovery: { kind: 'unknown' },
          context: { operation: ' execute ' },
        },
      },
    },
    {
      ...base,
      type: 'provider.diagnostic',
      payload: { code: ' diagnostic ', message: 'Provider notice.' },
    },
  ] as const;

  for (const invalidEvent of invalidEvents) {
    assert.equal(safeParseAgentEvent(invalidEvent).success, false);
  }
});

test('plan snapshots preserve canceled status and optional canonical priority', () => {
  const base = {
    protocolVersion: 11,
    sessionId: 'session:plan-semantics',
    turnId: 'turn:plan-semantics',
    occurredAt: protocolTimestamp,
    type: 'turn.plan.updated',
  } as const;
  const parsed = parseAgentEvent({
    ...base,
    payload: {
      steps: [
        {
          stepId: 'step:canceled',
          text: 'No longer required',
          status: 'canceled',
          priority: 'low',
        },
        {
          stepId: 'step:unprioritized',
          text: 'Preserve absent priority',
          status: 'pending',
        },
      ],
    },
  });
  assert.equal(parsed.type, 'turn.plan.updated');
  if (parsed.type !== 'turn.plan.updated') return;
  assert.equal(parsed.payload.steps[0]?.status, 'canceled');
  assert.equal(parsed.payload.steps[0]?.priority, 'low');
  assert.equal(parsed.payload.steps[1]?.priority, undefined);

  for (const step of [
    {
      stepId: 'step:cancelled',
      text: 'Reject provider spelling',
      status: 'cancelled',
    },
    {
      stepId: 'step:urgent',
      text: 'Reject provider priority',
      status: 'pending',
      priority: 'urgent',
    },
  ]) {
    assert.equal(
      safeParseAgentEvent({ ...base, payload: { steps: [step] } }).success,
      false,
    );
  }
});
