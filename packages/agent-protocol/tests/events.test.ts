// ------------------------------------------------------------------------------------------------
//                events.test.ts - Event taxonomy, strictness, bytes, and round-trip coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_EVENT_TYPES,
  AGENT_PROTOCOL_EVENT_BYTES_LIMIT,
  agentProtocolSerializedJsonBytes,
  parseAgentEvent,
  safeParseAgentEvent,
} from '../src/public/index.js';
import { eventFixtureCorpus, protocolTimestamp } from './fixtures.js';

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
    { ...base, protocolVersion: 2 },
    { ...base, protocolVersion: 1 },
    { ...base, unexpected: true },
    { ...base, teamId: 1 },
    { ...base, workspaceId: 2 },
    { ...base, assignedUserId: 3 },
    { ...base, providerInstanceId: 4 },
    { ...base, visibility: 'member' },
    { ...base, sequence: 1 },
  ]) {
    assert.equal(safeParseAgentEvent(invalid).success, false);
  }
});

test('events enforce reference, state, terminal, progress, and byte invariants', () => {
  const base = {
    protocolVersion: 6,
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

test('events reject noncanonical identifiers and diagnostic strings', () => {
  const base = {
    protocolVersion: 6,
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
          retryable: false,
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
    protocolVersion: 6,
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
