// ------------------------------------------------------------------------------------------------
//                foundationSessions.test.ts - IDs, JSON, binding, and session contract coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  AgentProtocolValidationError,
  compareStringsByUnicodeCodePoint,
  matchesAgentSessionBinding,
  parseAgentJsonValue,
  parseAgentProviderKey,
  parseAgentSessionId,
  parseAgentSessionOpenInput,
  safeParseAgentJsonValue,
  safeParseAgentProviderRefs,
  safeParseAgentProviderKey,
  safeParseAgentSessionConfiguration,
  safeParseAgentSessionId,
  safeParseAgentSessionOpenInput,
} from '../src/public/index.js';
import { AgentJsonValueSchema } from '../src/zod/index.js';

test('canonical string ordering compares Unicode code points instead of UTF-16 units', () => {
  const privateUseCharacter = '\uE000';
  const supplementaryCharacter = '\u{10000}';

  assert.ok(
    compareStringsByUnicodeCodePoint(
      privateUseCharacter,
      supplementaryCharacter,
    ) < 0,
  );
  assert.ok(compareStringsByUnicodeCodePoint('a', 'aa') < 0);
  assert.equal(compareStringsByUnicodeCodePoint('same', 'same'), 0);
  assert.deepEqual(
    [supplementaryCharacter, 'z', privateUseCharacter].sort(
      compareStringsByUnicodeCodePoint,
    ),
    ['z', privateUseCharacter, supplementaryCharacter],
  );
});

test('opaque IDs accept caller-owned canonical strings without assuming UUIDs', () => {
  assert.equal(parseAgentSessionId('customer-runtime/session:42'), 'customer-runtime/session:42');
  assert.equal(parseAgentProviderKey('external.provider-v2'), 'external.provider-v2');

  for (const invalid of [
    '',
    ' session',
    'session ',
    'session\n2',
    '\u0000',
    '\u0000session',
    'session\u007F',
    'session\u0085reference',
  ]) {
    assert.equal(
      safeParseAgentSessionId(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
  assert.equal(safeParseAgentProviderKey('UPPER').success, false);
});

test('JSON values are finite, portable, depth bounded, and byte bounded', () => {
  const accepted = {
    text: 'hello',
    count: 2,
    flags: [true, false, null],
    nested: { state: 'ready' },
  };
  assert.deepEqual(parseAgentJsonValue(accepted), accepted);

  for (const invalid of [
    Number.POSITIVE_INFINITY,
    Number.NaN,
    undefined,
    1n,
    () => undefined,
    new Date('2026-08-03T00:00:00.000Z'),
    new Map([['state', 'ready']]),
    new Set(['ready']),
    { toJSON: () => 'not-the-original-value' },
  ]) {
    assert.equal(safeParseAgentJsonValue(invalid).success, false);
  }

  const nullPrototypeRecord = Object.assign(Object.create(null), {
    state: 'ready',
  });
  assert.deepEqual(parseAgentJsonValue(nullPrototypeRecord), { state: 'ready' });

  const cyclicValue: { self?: unknown } = {};
  cyclicValue.self = cyclicValue;
  assert.equal(safeParseAgentJsonValue(cyclicValue).success, false);
  assert.equal(AgentJsonValueSchema.safeParse(cyclicValue).success, false);

  const accessorBackedValue = Object.defineProperty({}, 'state', {
    enumerable: true,
    get: () => {
      throw new Error('the parser must not invoke input accessors');
    },
  });
  assert.equal(safeParseAgentJsonValue(accessorBackedValue).success, false);

  let tooDeep: unknown = 'leaf';
  for (let depth = 0; depth <= AGENT_PROTOCOL_JSON_DEPTH_LIMIT; depth += 1) {
    tooDeep = { child: tooDeep };
  }
  assert.equal(safeParseAgentJsonValue(tooDeep).success, false);
  assert.equal(safeParseAgentJsonValue('x'.repeat(40_000)).success, false);

  let stackOverflowDepth: unknown = null;
  for (let depth = 0; depth < 5_000; depth += 1) {
    stackOverflowDepth = [stackOverflowDepth];
  }
  assert.equal(safeParseAgentJsonValue(stackOverflowDepth).success, false);
  for (const prohibitedKey of ['__proto__', 'constructor', 'prototype']) {
    const jsonValue = JSON.parse(`{"${prohibitedKey}":"unsafe"}`) as unknown;
    assert.equal(safeParseAgentJsonValue(jsonValue).success, false, prohibitedKey);
  }
});

test('provider references are explicit, strict, and non-empty', () => {
  assert.deepEqual(
    safeParseAgentProviderRefs({ conversationId: 'native-session-1' }),
    {
      success: true,
      data: { conversationId: 'native-session-1' },
    },
  );
  assert.equal(safeParseAgentProviderRefs({}).success, false);
  assert.equal(
    safeParseAgentProviderRefs({ conversationId: 'native', extra: true }).success,
    false,
  );
  for (const conversationId of [
    '\u0000native',
    'native\u007F',
    'native\u009Freference',
  ]) {
    assert.equal(
      safeParseAgentProviderRefs({ conversationId }).success,
      false,
      JSON.stringify(conversationId),
    );
  }
});

test('session open operations preserve opaque binding and exact branch boundary', () => {
  const configuration = {
    kind: 'selected',
    revision: 'config:7',
    catalogRevision: 4,
    selections: [
      {
        key: 'model',
        fieldRevision: 2,
        value: { fieldKind: 'single_select', optionId: 'provider-model' },
      },
    ],
  } as const;
  const binding = {
    conversationId: 'provider-conversation:9',
    historyAnchor: 'provider-message:22',
  };

  assert.equal(
    parseAgentSessionOpenInput({
      operation: 'create',
      sessionId: 'session:1',
      configuration,
    }).operation,
    'create',
  );
  assert.equal(
    parseAgentSessionOpenInput({
      operation: 'resume',
      sessionId: 'session:1',
      binding,
      configuration,
    }).operation,
    'resume',
  );
  assert.equal(
    parseAgentSessionOpenInput({
      operation: 'branch',
      sessionId: 'session:2',
      source: {
        sessionId: 'session:1',
        binding,
        throughTurn: {
          turnId: 'turn:4',
          historyAnchor: 'provider-message:18',
        },
      },
      configuration,
    }).operation,
    'branch',
  );
  assert.equal(
    safeParseAgentSessionOpenInput({
      operation: 'branch',
      sessionId: 'session:1',
      source: {
        sessionId: 'session:1',
        binding,
        throughTurn: {
          turnId: 'turn:4',
          historyAnchor: 'provider-message:18',
        },
      },
      configuration,
    }).success,
    false,
  );
  assert.equal(matchesAgentSessionBinding(binding, { ...binding }), true);
  assert.equal(
    matchesAgentSessionBinding(binding, { ...binding, historyAnchor: 'other' }),
    false,
  );
});

test('session configuration is closed, bounded, unique, and canonically ordered', () => {
  const unknown = safeParseAgentSessionConfiguration({
    kind: 'managed',
    revision: 'config:1',
    extra: true,
  });
  assert.equal(unknown.success, false);

  const oversized = safeParseAgentSessionConfiguration({
    kind: 'selected',
    revision: 'config:1',
    catalogRevision: 1,
    selections: [{
      key: 'prompt',
      fieldRevision: 1,
      value: { fieldKind: 'bounded_text', value: 'x'.repeat(4_001) },
    }],
  });
  assert.equal(oversized.success, false);
  if (!oversized.success) {
    assert.deepEqual(oversized.issues[0]?.path, [
      'selections',
      0,
      'value',
      'value',
    ]);
  }

  const noncanonical = {
    kind: 'selected',
    revision: 'config:1',
    catalogRevision: 1,
    selections: [
      {
        key: 'zeta',
        fieldRevision: 1,
        value: { fieldKind: 'boolean', value: true },
      },
      {
        key: 'alpha',
        fieldRevision: 1,
        value: { fieldKind: 'boolean', value: false },
      },
    ],
  };
  assert.equal(safeParseAgentSessionConfiguration(noncanonical).success, false);

  assert.throws(
    () => parseAgentSessionId(''),
    (error: unknown) => error instanceof AgentProtocolValidationError,
  );
});
