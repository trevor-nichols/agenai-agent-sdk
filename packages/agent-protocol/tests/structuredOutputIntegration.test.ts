// ------------------------------------------------------------------------------------------------
//                structuredOutputIntegration.test.ts - V13 request and terminal contract coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import { AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY } from '../src/jsonSchema/index.js';
import {
  AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT,
  AGENT_PROTOCOL_VERSION,
  parseAgentSessionOpenInput,
  parseAgentTurnRunInput,
  safeParseAgentCapabilities,
  safeParseAgentEvent,
  safeParseAgentOutputSchema,
  safeParseAgentSessionOpenInput,
  safeParseAgentTurnInputContent,
  safeParseAgentTurnRunInput,
} from '../src/public/index.js';
import { protocolTimestamp, providerCapabilityFixtures } from './fixtures.js';

const output = {
  kind: 'json_schema',
  schema: {
    type: 'object',
    properties: { title: { type: 'string', minLength: 1, maxLength: 60 } },
    required: ['title'],
    additionalProperties: false,
  },
} as const;

const createInput = {
  operation: 'create',
  sessionId: 'session:structured',
  configuration: { kind: 'managed', revision: 'configuration:1' },
} as const;

const turnInput = {
  turnId: 'turn:structured',
  interactionMode: 'default',
  parts: [{ type: 'text', text: 'Generate a short title.' }],
} as const;

const failure = {
  category: 'unknown',
  code: 'generation_failed',
  message: 'Generation failed.',
  recovery: { kind: 'none' },
} as const;

function terminal(payload: unknown) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'turn.completed',
    sessionId: createInput.sessionId,
    turnId: turnInput.turnId,
    occurredAt: protocolTimestamp,
    payload,
  };
}

test('V13 requires explicit structured capability and bounds its native guarantee', () => {
  const fixture = providerCapabilityFixtures.codex;
  const supported = {
    kind: 'supported',
    mechanism: 'native',
    schemaProfile: 'agenai.output-schema.v1',
    scope: 'turn',
    maxSchemaBytes: 16_384,
    maxOutputBytes: 16_384,
    resume: false,
    branch: false,
  } as const;
  const withCapability = (structuredOutput: unknown) => ({
    ...fixture,
    turns: { ...fixture.turns, structuredOutput },
  });

  assert.equal(safeParseAgentCapabilities(withCapability(supported)).success, true);
  assert.equal(safeParseAgentCapabilities(withCapability({ ...supported, scope: 'session' })).success, true);
  const { structuredOutput: _structuredOutput, ...oldTurns } = fixture.turns;
  assert.equal(safeParseAgentCapabilities({ ...fixture, turns: oldTurns }).success, false);
  assert.equal(safeParseAgentCapabilities({ ...fixture, protocolVersion: 12 }).success, false);
  for (const invalid of [
    { ...supported, mechanism: 'prompt' },
    { ...supported, schemaProfile: 'unrecognized' },
    { ...supported, maxSchemaBytes: 0 },
    { ...supported, maxSchemaBytes: 16_385 },
    { ...supported, maxOutputBytes: 1.5 },
    { ...supported, maxOutputBytes: 16_385 },
    { ...supported, resume: true },
    { ...supported, branch: true },
    { kind: 'unsupported', maxSchemaBytes: 1 },
  ]) {
    assert.equal(safeParseAgentCapabilities(withCapability(invalid)).success, false);
  }
});

test('output requests belong to fresh session creation and turn runs', () => {
  const opening = parseAgentSessionOpenInput({ ...createInput, output });
  assert.ok(opening.operation === 'create');
  assert.deepEqual(opening.output, output);
  assert.deepEqual(parseAgentTurnRunInput({ ...turnInput, output }).output, output);
  assert.equal(safeParseAgentTurnInputContent({ parts: turnInput.parts, output }).success, false);

  for (const restoration of [
    {
      ...createInput,
      operation: 'resume',
      binding: { conversationId: 'conversation:1' },
    },
    {
      ...createInput,
      operation: 'branch',
      source: {
        sessionId: 'session:source',
        binding: { conversationId: 'conversation:1' },
        throughTurn: { turnId: 'turn:source', historyAnchor: 'history:1' },
      },
    },
  ]) {
    assert.equal(safeParseAgentSessionOpenInput(restoration).success, true);
    assert.equal(safeParseAgentSessionOpenInput({ ...restoration, output }).success, false);
  }
});

test('structured turn requests retain the independent complete content allowance', () => {
  const parts = Array.from({ length: 17 }, (_value, index) => ({
    type: 'text' as const,
    text: index < 16 ? 'x'.repeat(64_000) : 'x',
  }));
  const remainingBytes = AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT
    - Buffer.byteLength(JSON.stringify({ parts }), 'utf8');
  parts[16] = { type: 'text', text: 'x'.repeat(remainingBytes + 1) };
  assert.equal(safeParseAgentTurnRunInput({ ...turnInput, parts, output }).success, true);
  parts[16] = { type: 'text', text: `${parts[16]?.text}x` };
  assert.equal(safeParseAgentTurnRunInput({ ...turnInput, parts, output }).success, false);
});

test('terminal results correlate JSON and errors with the actual native outcome', () => {
  const historicalV12Terminal = {
    protocolVersion: 12,
    type: 'turn.completed',
    sessionId: 'session:1',
    turnId: 'turn:1',
    occurredAt: protocolTimestamp,
    payload: { outcome: 'completed', reason: 'Done.' },
  };
  assert.equal(safeParseAgentEvent(historicalV12Terminal).success, false);

  for (const outcome of ['completed', 'failed', 'canceled', 'expired'] as const) {
    for (const structuredOutput of [
      { kind: 'not_requested' },
      { kind: 'json', value: { title: 'A concise title' } },
      { kind: 'unavailable', reason: 'incomplete' },
    ] as const) {
      const payload = {
        outcome,
        structuredOutput,
        ...(outcome === 'failed' ? { error: failure } : {}),
      };
      assert.equal(
        safeParseAgentEvent(terminal(payload)).success,
        outcome === 'completed' || structuredOutput.kind !== 'json',
        `${outcome}/${structuredOutput.kind}`,
      );
    }
  }

  for (const payload of [
    { outcome: 'completed' },
    { outcome: 'failed', structuredOutput: { kind: 'not_requested' } },
    { outcome: 'completed', error: failure, structuredOutput: { kind: 'not_requested' } },
    { outcome: 'canceled', error: failure, structuredOutput: { kind: 'unavailable', reason: 'incomplete' } },
    { outcome: 'expired', structuredOutput: { kind: 'json', value: {} } },
  ]) {
    assert.equal(safeParseAgentEvent(terminal(payload)).success, false);
  }
});

test('public structured request and event admission reject unsafe graphs before invoking accessors', () => {
  let getterCalls = 0;
  const schemaWithGetter = Object.defineProperty({}, 'type', {
    enumerable: true,
    get() { getterCalls += 1; return 'object'; },
  });
  const unsafeOutput = { kind: 'json_schema', schema: schemaWithGetter };
  assert.equal(safeParseAgentTurnRunInput({ ...turnInput, output: unsafeOutput }).success, false);
  assert.equal(safeParseAgentSessionOpenInput({ ...createInput, output: unsafeOutput }).success, false);

  const valueWithGetter = Object.defineProperty({}, 'title', {
    enumerable: true,
    get() { getterCalls += 1; return 'hidden side effect'; },
  });
  const cyclicValue: Record<string, unknown> = {};
  cyclicValue.self = cyclicValue;
  for (const value of [valueWithGetter, cyclicValue, new Date(), { title: Number.NaN }]) {
    assert.equal(safeParseAgentEvent(terminal({
      outcome: 'completed', structuredOutput: { kind: 'json', value },
    })).success, false);
  }
  assert.equal(getterCalls, 0);
});

test('generated V13 input and terminal schemas enforce placement and outcome correlation', () => {
  const cases = [
    {
      contractId: 'agenai.agent-protocol.output-schema',
      parser: safeParseAgentOutputSchema,
      accepted: {
        type: 'object',
        properties: {
          title: { type: 'string', enum: ['Ready', 'Complete'], minLength: 1 },
          entries: {
            type: 'array',
            items: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0.5, maximum: 9.5 }] },
            minItems: 0,
            maxItems: 10,
          },
          nested: {
            type: 'object',
            properties: { enabled: { type: 'boolean' }, score: { type: 'number' }, empty: { type: 'null' } },
            required: ['enabled', 'score', 'empty'],
            additionalProperties: false,
          },
        },
        required: ['title', 'entries', 'nested'],
        additionalProperties: false,
      },
      rejected: { ...output.schema, properties: { title: { type: 'string', format: 'email' } } },
    },
    {
      contractId: 'agenai.agent-protocol.session-open-input',
      parser: safeParseAgentSessionOpenInput,
      accepted: { ...createInput, output },
      rejected: { ...createInput, operation: 'resume', binding: { conversationId: 'conversation:1' }, output },
    },
    {
      contractId: 'agenai.agent-protocol.turn-run-input',
      parser: safeParseAgentTurnRunInput,
      accepted: { ...turnInput, output },
      rejected: { ...turnInput, output: { kind: 'json_schema', schema: { type: 'string' } } },
    },
    {
      contractId: 'agenai.agent-protocol.event',
      parser: safeParseAgentEvent,
      accepted: terminal({ outcome: 'completed', structuredOutput: { kind: 'json', value: { title: 'Ready' } } }),
      rejected: terminal({ outcome: 'failed', error: failure, structuredOutput: { kind: 'json', value: { title: 'Untrusted' } } }),
    },
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTuples: false, validateFormats: false });
  for (const entry of cases) {
    const artifact = AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.find((candidate) => candidate.contractId === entry.contractId);
    assert.ok(artifact, entry.contractId);
    const validate = ajv.compile(artifact.schema);
    assert.equal(validate(entry.accepted), true, entry.contractId);
    assert.equal(entry.parser(entry.accepted).success, true, entry.contractId);
    assert.equal(validate(entry.rejected), false, entry.contractId);
    assert.equal(entry.parser(entry.rejected).success, false, entry.contractId);
  }
});
