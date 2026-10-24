import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentProtocolValidationError,
  type AgentJsonValue,
} from '../src/foundation/types.js';
import {
  parseAgentOutputSchema,
  safeParseAgentOutputSchema,
  validateAgentOutputValue,
  type AgentOutputSchema,
} from '../src/structuredOutput/index.js';
import {
  AgentOutputSchemaSchema,
  AgentStructuredOutputCapabilitySchema,
  AgentStructuredOutputRequestSchema,
  AgentStructuredOutputResultSchema,
} from '../src/zod/structuredOutput.js';

function objectSchema(properties: Readonly<Record<string, unknown>>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function parsedSchema(properties: Readonly<Record<string, unknown>>): AgentOutputSchema {
  return parseAgentOutputSchema(objectSchema(properties));
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

test('portable schema admission owns canonical closed schemas and validates every supported node', () => {
  const input = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      title: { type: 'string', enum: ['🦊', 'a'], minLength: 1, maxLength: 1 },
      count: { type: 'integer', minimum: 0.5, maximum: 2.5 },
      score: { type: 'number', minimum: -0.5, maximum: 0.5 },
      enabled: { type: 'boolean' },
      empty: { type: 'null' },
      names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
      details: { anyOf: [{ type: 'null' }, objectSchema({ name: { type: 'string' } })] },
    },
    required: ['details', 'names', 'empty', 'enabled', 'score', 'count', 'title'],
    additionalProperties: false,
  };
  const schema = parseAgentOutputSchema(input);
  assert.deepEqual(schema, {
    type: 'object', properties: {
      ...input.properties,
      details: { anyOf: [objectSchema({ name: { type: 'string' } }), { type: 'null' }] },
    },
    required: ['title', 'count', 'score', 'enabled', 'empty', 'names', 'details'], additionalProperties: false,
  });
  input.properties.title.enum[0] = 'changed';
  const candidate = { title: '🦊', count: 2, score: -0.5, enabled: true, empty: null, names: ['one'], details: { name: 'Ada' } };
  const parsed = validateAgentOutputValue(schema, candidate);
  assert.deepEqual(parsed, { success: true, data: candidate });
  assert.equal(Object.isFrozen(schema.properties), true);
  candidate.names.push('two');
  if (!parsed.success) assert.fail('Expected valid structured data.');
  assert.deepEqual(parsed.data.names, ['one']);
  assert.deepEqual(validateAgentOutputValue(schema, { ...candidate, title: 'ab' }), {
    success: false, issues: [
      { code: 'schema_mismatch', path: ['title'], message: 'String code-point length is outside the declared bounds.' },
      { code: 'schema_mismatch', path: ['title'], message: 'String is not one of the declared enum values.' },
    ],
  });
  assert.equal(validateAgentOutputValue(schema, { ...candidate, count: 1.5 }).success, false);
  assert.equal(validateAgentOutputValue(schema, { ...candidate, count: 0 }).success, false);
  assert.equal(validateAgentOutputValue(schema, { ...candidate, details: null }).success, true);
  assert.equal(validateAgentOutputValue(parsedSchema({ value: { type: 'integer' } }), { value: 1e100 }).success, true);
});

test('schema admission rejects unsupported semantics and contradictory constraints before value validation', () => {
  const invalidNodes: readonly unknown[] = [
    { type: 'string', format: 'email' }, { type: 'string', pattern: '.*' },
    { type: 'string', default: 'x' }, { type: 'string', minLength: 1.5 },
    { type: 'string', minLength: -1 }, { type: 'string', maxLength: 16_385 },
    { type: 'string', minLength: 2, maxLength: 1 },
    { type: 'string', enum: [] }, { type: 'string', enum: ['a', 'a'] },
    { type: 'string', enum: ['🦊'], maxLength: 0 },
    { type: 'number', minimum: Infinity }, { type: 'number', minimum: 2, maximum: 1 },
    { type: 'integer', minimum: 0.1, maximum: 0.9 },
    { type: 'array', items: [{ type: 'string' }] }, { type: 'array' },
    { type: 'array', items: { type: 'null' }, minItems: 101 },
    { type: 'string', $schema: 'https://json-schema.org/draft/2020-12/schema' },
    { $ref: '#/$defs/reused' }, { type: ['string', 'null'] },
    { anyOf: [{ type: 'string' }, { type: 'number' }] },
    { anyOf: [{ type: 'null' }, { type: 'null' }] },
    { anyOf: [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, { type: 'null' }] },
    { type: 'object', properties: {}, required: [], additionalProperties: true },
    { type: 'object', properties: { a: { type: 'null' } }, required: [], additionalProperties: false },
    { type: 'object', properties: { a: { type: 'null' } }, required: ['a', 'a'], additionalProperties: false },
    { type: 'object', properties: {}, additionalProperties: false },
  ];
  for (const node of invalidNodes) assert.equal(safeParseAgentOutputSchema(objectSchema({ value: node })).success, false, JSON.stringify(node));
  assert.equal(safeParseAgentOutputSchema({ type: 'string' }).success, false);
  assert.equal(safeParseAgentOutputSchema({ ...objectSchema({}), $schema: 'http://json-schema.org/draft-07/schema#' }).success, false);
  assert.deepEqual(parseAgentOutputSchema(objectSchema({})), { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.throws(() => parseAgentOutputSchema({ type: 'string' }), AgentProtocolValidationError);
  for (const name of ['__proto__', 'constructor', 'prototype', '', 'x'.repeat(129)]) {
    assert.equal(safeParseAgentOutputSchema(objectSchema(Object.fromEntries([[name, { type: 'null' }]]))).success, false, name);
  }
  const astralName = '🦊'.repeat(128);
  const unicodeSchema = parsedSchema({ [astralName]: { type: 'string' } });
  assert.deepEqual(validateAgentOutputValue(unicodeSchema, { [astralName]: 'valid' }), { success: true, data: { [astralName]: 'valid' } });
  assert.equal(AgentOutputSchemaSchema.safeParse(objectSchema({ [astralName]: { type: 'string' } })).success, true);
});

test('schema byte, semantic-node, property and depth limits are inclusive and reject impossible required values', () => {
  const descriptions = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`p${index}`, { type: 'string', description: 'x'.repeat(2_000) }]));
  const byteBoundSchema = { ...objectSchema(descriptions), description: '' };
  const padding = 16_384 - jsonBytes(byteBoundSchema);
  assert.equal(padding >= 0 && padding <= 2_000, true);
  byteBoundSchema.description = 'x'.repeat(padding);
  assert.equal(safeParseAgentOutputSchema(byteBoundSchema).success, true);
  assert.equal(safeParseAgentOutputSchema({ ...byteBoundSchema, description: `${byteBoundSchema.description}x` }).success, false);

  const nullableNodes = Object.fromEntries(Array.from({ length: 85 }, (_, index) => [`p${index}`, { anyOf: [{ type: 'string' }, { type: 'null' }] }]));
  assert.equal(safeParseAgentOutputSchema(objectSchema(nullableNodes)).success, true);
  assert.equal(safeParseAgentOutputSchema(objectSchema({ ...nullableNodes, extra: { type: 'boolean' } })).success, false);
  assert.equal(safeParseAgentOutputSchema(objectSchema(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`p${index}`, { type: 'null' }])))).success, true);
  assert.equal(safeParseAgentOutputSchema(objectSchema(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`p${index}`, { type: 'null' }])))).success, false);

  let deep: unknown = { type: 'string' };
  for (let depth = 0; depth < 7; depth += 1) deep = objectSchema({ value: deep });
  assert.equal(safeParseAgentOutputSchema(deep).success, true);
  assert.equal(safeParseAgentOutputSchema(objectSchema({ value: deep })).success, false);
  assert.equal(safeParseAgentOutputSchema(objectSchema({ value: { type: 'string', minLength: 16_384 } })).success, false);
  assert.equal(safeParseAgentOutputSchema(objectSchema({ value: { type: 'array', minItems: 100, items: { type: 'array', minItems: 100, items: { type: 'null' } } } })).success, false);
});

test('schema admission accounts for exact numeric serialization when required values exceed output capacity', () => {
  function numericRows(type: 'number' | 'integer', minimum: number, maximum: number, count = 100) {
    const properties = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, { type, minimum, maximum }]));
    return objectSchema({ values: { type: 'array', minItems: count, maxItems: count, items: objectSchema(properties) } });
  }

  function candidate(value: number, count = 100) {
    return { values: Array.from({ length: count }, () => Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, value]))) };
  }

  const fixed = 1.2345678901234567e100;
  assert.equal(jsonBytes(candidate(fixed)), 26_312);
  for (const [type, minimum, maximum, value] of [
    ['number', fixed, fixed, fixed],
    ['integer', fixed, fixed, fixed],
    ['integer', 999_999_999_999.75, 1_000_000_000_000.25, 1_000_000_000_000],
  ] as const) {
    const schema = numericRows(type, minimum, maximum);
    assert.equal(jsonBytes(schema) < 16_384, true);
    assert.equal(jsonBytes(candidate(value)) > 16_384, true);
    assert.deepEqual(safeParseAgentOutputSchema(schema), {
      success: false,
      issues: [{ code: 'invalid_output_schema', path: [], message: 'Schema cannot produce a value within the profile capacity limits.' }],
    });
  }

  const satisfiable = candidate(fixed, 62);
  assert.equal(jsonBytes(satisfiable), 16_318);
  assert.deepEqual(validateAgentOutputValue(parseAgentOutputSchema(numericRows('number', fixed, fixed, 62)), satisfiable), { success: true, data: satisfiable });
  assert.equal(safeParseAgentOutputSchema(numericRows('number', fixed, fixed, 63)).success, false);

  for (const [type, minimum, maximum, value] of [
    ['number', -0, 0, -0],
    ['number', 1e-7, 1e-7, 1e-7],
    ['integer', -0.75, 0.75, 0],
  ] as const) {
    const schema = parseAgentOutputSchema(numericRows(type, minimum, maximum));
    assert.deepEqual(validateAgentOutputValue(schema, candidate(value)), { success: true, data: candidate(value) });
  }
});

test('schema admission applies lower provider output limits to provably required values before native work', () => {
  for (const [properties, candidate, exactBytes] of [
    [{ title: { type: 'string', minLength: 8 } }, { title: 'xxxxxxxx' }, 20],
    [{ value: { type: 'number', minimum: 1e100, maximum: 1e100 } }, { value: 1e100 }, 16],
    [{ title: { type: 'string', enum: ['🦊'] } }, { title: '🦊' }, 16],
  ] as const) {
    const schema = parseAgentOutputSchema(objectSchema(properties));
    assert.equal(jsonBytes(candidate), exactBytes);
    assert.deepEqual(validateAgentOutputValue(parseAgentOutputSchema(schema, { maxOutputBytes: exactBytes }), candidate),
      { success: true, data: candidate });
    assert.deepEqual(safeParseAgentOutputSchema(schema, { maxOutputBytes: exactBytes - 1 }), {
      success: false,
      issues: [{ code: 'invalid_output_schema', path: [], message: 'Schema cannot produce a value within the configured output byte limit.' }],
    });
  }
});

test('numeric interval admission accounts for signs, decimal magnitude and JSON notation thresholds', () => {
  for (const [type, minimum, maximum, value, exactBytes] of [
    ['integer', 10, 99, 10, 8],
    ['integer', -99, -10, -10, 9],
    ['integer', 10.1, 99.9, 11, 8],
    ['integer', -99.9, -10.1, -11, 9],
    ['number', 0.1, 0.9, 0.1, 9],
    ['number', -0.9, -0.1, -0.1, 10],
    ['number', 1.1, 1.9, 1.5, 9],
    ['number', -1.9, -1.1, -1.5, 10],
    ['number', 1e-7, 9e-7, 1e-7, 10],
    ['number', 1e-6, 9e-6, 1e-6, 14],
    ['number', 1e-7, 1e-6, 1e-7, 10],
    ['number', 1e20, 9e20, 1e20, 27],
    ['number', 1e20, 1e21, 1e21, 11],
    ['number', 1e21, 9e21, 1e21, 11],
    ['number', -9e21, -1e21, -1e21, 12],
    ['number', Number.MIN_VALUE, 1e-323, Number.MIN_VALUE, 12],
    ['number', 1e-100, 9e-100, 1e-100, 12],
    ['number', 1e99, 9e99, 1e99, 11],
    ['number', 1e100, 9e100, 1e100, 12],
    ['integer', -0.25, 0.25, 0, 7],
    ['number', -1, 1, 0, 7],
    ['integer', 10, undefined, 10, 8],
    ['integer', undefined, -10, -10, 9],
    ['number', 1e20, undefined, 1e21, 11],
  ] as const) {
    const input = objectSchema({ n: {
      type,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    } });
    const candidate = { n: value };
    assert.equal(jsonBytes(candidate), exactBytes);
    assert.deepEqual(validateAgentOutputValue(parseAgentOutputSchema(input, { maxOutputBytes: exactBytes }), candidate),
      { success: true, data: candidate });
    assert.deepEqual(safeParseAgentOutputSchema(input, { maxOutputBytes: exactBytes - 1 }), {
      success: false,
      issues: [{ code: 'invalid_output_schema', path: [], message: 'Schema cannot produce a value within the configured output byte limit.' }],
    }, JSON.stringify(input));
  }
});

test('numeric interval size estimates never exceed serialized admitted samples across finite floating-point ranges', () => {
  let state = 0x61c88647;
  const bits = new DataView(new ArrayBuffer(8));
  const nextUint32 = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state; };
  const nextFinite = () => {
    let value: number;
    do {
      bits.setUint32(0, nextUint32());
      bits.setUint32(4, nextUint32());
      value = bits.getFloat64(0);
    } while (!Number.isFinite(value));
    return value;
  };
  for (let index = 0; index < 400; index += 1) {
    const type = index % 2 === 0 ? 'integer' : 'number';
    const sign = index % 4 < 2 ? 1 : -1;
    const first = sign * Math.abs(nextFinite());
    const nearby = first * 1.1;
    const second = index % 3 === 0 && Number.isFinite(nearby) ? nearby : sign * Math.abs(nextFinite());
    const samples = [first, second, first / 2 + second / 2].map((value) => type === 'integer' ? Math.trunc(value) : value);
    const minimum = Math.min(...samples);
    const maximum = Math.max(...samples);
    const input = objectSchema({ n: { type, minimum, maximum } });
    for (const n of samples) {
      const candidate = { n };
      const parsed = safeParseAgentOutputSchema(input, { maxOutputBytes: jsonBytes(candidate) });
      assert.equal(parsed.success, true, JSON.stringify({ input, candidate, parsed }));
      if (!parsed.success) assert.fail('A known satisfying value must fit its own serialized byte limit.');
      assert.deepEqual(validateAgentOutputValue(parsed.data, candidate), { success: true, data: candidate });
    }
  }
});

test('invalid output admission limits fail before schema traversal and cannot raise the portable ceiling', () => {
  let reads = 0;
  const input = Object.defineProperty({}, 'type', { enumerable: true, get() { reads += 1; return 'object'; } });
  for (const maxOutputBytes of [0, -1, 1.5, 16_385, Infinity, NaN]) {
    assert.deepEqual(safeParseAgentOutputSchema(input, { maxOutputBytes }), {
      success: false,
      issues: [{ code: 'invalid_output_limits', path: ['maxOutputBytes'], message: 'Output byte limit must be a positive integer within the portable profile ceiling.' }],
    });
  }
  assert.deepEqual(safeParseAgentOutputSchema(input, {
    get maxOutputBytes() { reads += 1; return 16_384; },
  }), {
    success: false,
    issues: [{ code: 'invalid_output_limits', path: ['maxOutputBytes'], message: 'Output byte limit must be a positive integer within the portable profile ceiling.' }],
  });
  assert.equal(reads, 0);
  assert.throws(() => parseAgentOutputSchema(objectSchema({}), { maxOutputBytes: 0 }), AgentProtocolValidationError);
  assert.deepEqual(parseAgentOutputSchema(objectSchema({}), { maxOutputBytes: 2 }),
    { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(parseAgentOutputSchema(objectSchema({}), { maxOutputBytes: undefined }),
    { type: 'object', properties: {}, required: [], additionalProperties: false });
});

test('schema and value admission reject executable or non-JSON graphs without invoking input methods', () => {
  const schema = parsedSchema({ value: { type: 'string' } });
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => { invoked += 1; return 'unsafe'; } });
  const toJSON = { value: 'valid', toJSON: () => { invoked += 1; return {}; } };
  const cycle: Record<string, unknown> = {};
  cycle.value = cycle;
  const hidden = Object.defineProperty({ value: 'valid' }, 'hidden', { value: true });
  const symbol = { value: 'valid', [Symbol('hidden')]: true };
  class Value { readonly value = 'valid'; }
  const hostile: unknown[] = [accessor, toJSON, cycle, hidden, symbol, new Value(), { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }];
  for (const input of hostile) {
    const parsed = validateAgentOutputValue(schema, input);
    assert.equal(parsed.success, false);
    assert.equal(AgentStructuredOutputResultSchema.safeParse({ kind: 'json', value: input }).success, false);
  }
  const cyclicSchema: Record<string, unknown> = { type: 'array' };
  cyclicSchema.items = cyclicSchema;
  for (const input of [objectSchema({ value: accessor }), objectSchema({ value: cyclicSchema }), accessor, toJSON, new Value()]) {
    assert.equal(safeParseAgentOutputSchema(input).success, false);
    assert.equal(AgentOutputSchemaSchema.safeParse(input).success, false);
    assert.equal(AgentStructuredOutputRequestSchema.safeParse({ kind: 'json_schema', schema: input }).success, false);
  }
  assert.equal(invoked, 0);
  const arraySchema = parsedSchema({ value: { type: 'array', items: { type: 'null' } } });
  const sparse = new Array<null>(1);
  const extra = Object.assign([null], { note: true });
  for (const value of [sparse, extra]) assert.equal(validateAgentOutputValue(arraySchema, { value }).success, false);
  assert.deepEqual(validateAgentOutputValue(schema, Object.assign(Object.create(null), { value: 'owned' })), { success: true, data: { value: 'owned' } });
});

test('value byte and node bounds account for actual UTF-8 JSON bytes before schema matching', () => {
  const schema = parsedSchema({ value: { type: 'string' } });
  assert.deepEqual(validateAgentOutputValue(schema, { value: 42 }, { maxOutputBytes: 11 }), {
    success: false,
    issues: [{ code: 'output_limit_exceeded', path: ['value'], message: 'JSON data exceeds the serialized UTF-8 byte limit.' }],
  });
  assert.deepEqual(validateAgentOutputValue(schema, { value: 42 }, { maxOutputBytes: 12 }), {
    success: false,
    issues: [{ code: 'schema_mismatch', path: ['value'], message: 'Value does not have the declared JSON type.' }],
  });
  assert.deepEqual(validateAgentOutputValue(schema, { value: 'valid' }, { maxOutputBytes: 0 }), {
    success: false,
    issues: [{ code: 'invalid_output_limits', path: ['maxOutputBytes'], message: 'Output byte limit must be a positive integer within the portable profile ceiling.' }],
  });
  const exact = { value: 'x'.repeat(16_372) };
  assert.deepEqual(validateAgentOutputValue(schema, exact), { success: true, data: exact });
  assert.equal(validateAgentOutputValue(schema, { value: `${exact.value}x` }).success, false);
  const unicode = { value: '🦊'.repeat(4_093) };
  assert.deepEqual(validateAgentOutputValue(schema, unicode), { success: true, data: unicode });
  assert.equal(validateAgentOutputValue(schema, { value: `${unicode.value}x` }).success, false);
  const escaped = { value: '\u0000'.repeat(2_728) };
  assert.equal(validateAgentOutputValue(schema, escaped).success, true);
  assert.equal(validateAgentOutputValue(schema, { value: `${escaped.value}\u0000` }).success, false);
  const loneSurrogates = { value: '\ud800'.repeat(2_728) };
  assert.equal(validateAgentOutputValue(schema, loneSurrogates).success, true);
  assert.equal(validateAgentOutputValue(schema, { value: `${loneSurrogates.value}\ud800` }).success, false);

  const properties = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`p${index}`, { type: 'array', items: { type: 'string' } }]));
  const nodeSchema = parsedSchema(properties);
  const nodeValue = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`p${index}`, Array.from({ length: index === 10 ? 12 : 100 }, () => '')]));
  assert.deepEqual(validateAgentOutputValue(nodeSchema, nodeValue), { success: true, data: nodeValue });
  nodeValue.p10?.push('');
  assert.equal(validateAgentOutputValue(nodeSchema, nodeValue).success, false);
  assert.equal(validateAgentOutputValue(parsedSchema({ value: { type: 'array', items: { type: 'null' } } }), { value: Array.from({ length: 101 }, () => null) }).success, false);
});

test('portable result envelopes enforce value depth and bounded neutral schema issues', () => {
  let nested: AgentJsonValue = 'leaf';
  for (let depth = 0; depth < 14; depth += 1) nested = [nested];
  const depth16 = { value: nested };
  assert.deepEqual(AgentStructuredOutputResultSchema.parse({ kind: 'json', value: depth16 }), { kind: 'json', value: depth16 });
  assert.equal(AgentStructuredOutputResultSchema.safeParse({ kind: 'json', value: { value: [nested] } }).success, false);

  const properties = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`p${index}`, { type: 'string' }]));
  const mismatch = validateAgentOutputValue(parsedSchema(properties), {});
  assert.equal(mismatch.success, false);
  if (mismatch.success) assert.fail('Expected missing-property issues.');
  assert.equal(mismatch.issues.length, 8);
  assert.deepEqual(mismatch.issues[0], { code: 'schema_mismatch', path: ['p0'], message: 'Object is missing a required property.' });
  assert.equal(jsonBytes(mismatch.issues) <= 4_096, true);
  assert.equal(AgentStructuredOutputResultSchema.safeParse({ kind: 'unavailable', reason: 'schema_mismatch', issues: mismatch.issues }).success, true);
  assert.equal(AgentStructuredOutputResultSchema.safeParse({ kind: 'unavailable', reason: 'refused', issues: mismatch.issues }).success, false);
  assert.equal(AgentStructuredOutputResultSchema.safeParse({ kind: 'unavailable', reason: 'schema_mismatch', issues: [...mismatch.issues, mismatch.issues[0]] }).success, false);
  for (const issues of [
    [{ code: 'c'.repeat(65), path: [], message: 'invalid' }],
    [{ code: `${'c'.repeat(64)}\n`, path: [], message: 'invalid' }],
    [{ code: 'invalid', path: [], message: 'm'.repeat(257) }],
    [{ code: 'invalid', path: [], message: `${'m'.repeat(256)}\n` }],
    [{ code: 'invalid', path: Array.from({ length: 17 }, () => 'x'), message: 'invalid' }],
    [{ code: 'invalid', path: ['x'.repeat(1_024)], message: 'invalid' }],
    Array.from({ length: 8 }, () => ({ code: 'invalid', path: ['x'.repeat(800)], message: 'invalid' })),
  ]) assert.equal(AgentStructuredOutputResultSchema.safeParse({ kind: 'unavailable', reason: 'schema_mismatch', issues }).success, false);
});

test('structured capability limits are positive profile-bounded integers and restoration is explicitly unsupported', () => {
  const capability = { kind: 'supported', mechanism: 'native', schemaProfile: 'agenai.output-schema.v1', scope: 'turn', maxSchemaBytes: 16_384, maxOutputBytes: 16_384, resume: false, branch: false };
  assert.deepEqual(AgentStructuredOutputCapabilitySchema.parse(capability), capability);
  assert.deepEqual(AgentStructuredOutputCapabilitySchema.parse({ kind: 'unsupported' }), { kind: 'unsupported' });
  for (const change of [{ maxSchemaBytes: 0 }, { maxSchemaBytes: 16_385 }, { maxOutputBytes: 0.5 }, { maxOutputBytes: Infinity }, { resume: true }, { branch: true }, { mechanism: 'prompt' }, { schemaProfile: 'unknown' }]) {
    assert.equal(AgentStructuredOutputCapabilitySchema.safeParse({ ...capability, ...change }).success, false);
  }
});
