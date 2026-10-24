// ------------------------------------------------------------------------------------------------
//                zodOutput.test.ts - Finite Zod authoring admission and actual decoder behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod/v4';
import * as core from 'zod/v4/core';

import { AgentProtocolValidationError, validateAgentOutputValue } from '../src/public/index.js';
import { zodOutput } from '../src/zod/index.js';

function rejected(schema: core.$ZodType, message: RegExp): void {
  assert.throws(() => zodOutput(schema), (error: unknown) => error instanceof AgentProtocolValidationError
    && error.issues.some((issue) => message.test(issue.message)));
}

test('Zod output emits the exact finite schema and invokes the supplied parser for decoding', () => {
  const definition = zodOutput(z.strictObject({
    title: z.string(), score: z.number().min(0.25).min(0).max(0.75), count: z.int().min(1).max(3),
    active: z.boolean(), status: z.literal(['ready', 'done']),
    details: z.strictObject({ note: z.string().nullable(), labels: z.array(z.enum(['alpha', 'beta'])) }),
    empty: z.null(),
  }));
  assert.deepEqual(definition.schema, {
    type: 'object', properties: {
      title: { type: 'string' }, score: { type: 'number', minimum: 0.25, maximum: 0.75 },
      count: { type: 'integer', minimum: 1, maximum: 3 }, active: { type: 'boolean' },
      status: { type: 'string', enum: ['ready', 'done'] },
      details: { type: 'object', properties: {
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        labels: { type: 'array', items: { type: 'string', enum: ['alpha', 'beta'] } },
      }, required: ['note', 'labels'], additionalProperties: false }, empty: { type: 'null' },
    }, required: ['title', 'score', 'count', 'active', 'status', 'details', 'empty'], additionalProperties: false,
  });
  const value = { title: 'Ready', score: 0.25, count: 3, active: true, status: 'ready', details: { note: null, labels: ['alpha', 'beta'] }, empty: null };
  assert.deepEqual(validateAgentOutputValue(definition.schema, value), { success: true, data: value });
  const decoded = definition.decode(value);
  assert.deepEqual(decoded, { success: true, data: value });
  if (!decoded.success) assert.fail('Expected successful actual Zod parsing.');
  assert.notEqual(decoded.data, value);
  const failure = definition.decode({ ...value, score: 2 });
  if (failure.success) assert.fail('The local Zod parser must reject its violated numeric maximum.');
  assert.deepEqual(failure.issues.map(({ code, path }) => ({ code, path })), [{ code: 'too_big', path: ['score'] }]);
});

test('safe integers retain their native constraints and plain arrays preserve all admitted lengths', () => {
  const definition = zodOutput(z.strictObject({ a: z.int(), b: z.number().int(), rows: z.array(z.boolean()) }));
  assert.deepEqual(definition.schema, {
    type: 'object', properties: {
      a: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      b: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      rows: { type: 'array', items: { type: 'boolean' } },
    }, required: ['a', 'b', 'rows'], additionalProperties: false,
  });
  const value = { a: Number.MIN_SAFE_INTEGER, b: Number.MAX_SAFE_INTEGER, rows: [false, true] };
  assert.deepEqual(definition.decode(value), { success: true, data: value });
  assert.equal(validateAgentOutputValue(definition.schema, { ...value, a: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.deepEqual(definition.decode({ ...value, rows: [] }), { success: true, data: { ...value, rows: [] } });
});

test('unsupported semantics fail before refinement, transformation or lazy callbacks run', () => {
  let refinementCalls = 0;
  let transformCalls = 0;
  let lazyCalls = 0;
  const cases: readonly (readonly [core.$ZodType, RegExp])[] = [
    [z.string().refine(() => { refinementCalls += 1; return true; }), /string checks/],
    [z.strictObject({ value: z.string() }).refine(() => { refinementCalls += 1; return true; }), /object checks/],
    [z.string().superRefine(() => { refinementCalls += 1; }), /string checks/],
    [z.string().overwrite((value) => { transformCalls += 1; return value; }), /string checks/],
    [z.string().trim(), /string checks/], [z.string().toLowerCase(), /string checks/],
    [z.coerce.string(), /coercion/], [z.coerce.number(), /coercion/], [z.coerce.boolean(), /coercion/],
    [z.string().default('fallback'), /unsupported/], [z.string().prefault('fallback'), /unsupported/],
    [z.string().catch('fallback'), /unsupported/],
    [z.string().transform((value) => { transformCalls += 1; return value.length; }), /unsupported/],
    [z.string().optional(), /unsupported/], [z.string().optional().nullable(), /unsupported/],
    [z.lazy(() => { lazyCalls += 1; return z.string(); }), /unsupported/],
    [z.email(), /string formats/], [z.string().regex(/a/u), /string checks/],
    [z.number().gt(1), /inclusive numeric/], [z.number().multipleOf(2), /inclusive numeric/],
    [z.float32(), /safe-integer/], [z.int32(), /safe-integer/],
    [z.enum({ one: 1, two: 2 }), /Only string enum/], [z.literal(1), /Only string enum/],
    [z.union([z.string(), z.null()]), /unsupported/], [z.tuple([z.string()]), /unsupported/],
    [z.record(z.string(), z.string()), /unsupported/], [z.unknown(), /unsupported/],
    [z.string().readonly(), /unsupported/], [z.string().nullable().nullable(), /Nullable output/],
    [z.null().nullable(), /Nullable output/],
    [z.object({ value: z.string() }), /must be strict/], [z.looseObject({ value: z.string() }), /must be strict/],
  ];
  for (const [schema, message] of cases) rejected(z.strictObject({ nested: schema }), message);
  rejected(z.string(), /root must be/);
  assert.deepEqual({ refinementCalls, transformCalls, lazyCalls }, { refinementCalls: 0, transformCalls: 0, lazyCalls: 0 });
});

test('UTF-16 string bounds are rejected with neutral code-point guidance', () => {
  for (const schema of [z.string().min(1), z.string().max(1), z.string().length(1)]) {
    rejected(z.strictObject({ title: schema }), /createAgentOutputDefinition.*minLength\/maxLength/);
  }
  assert.deepEqual(zodOutput(z.strictObject({ title: z.string() })).decode({ title: '😀' }), { success: true, data: { title: '😀' } });
});

test('standard and conditional core array length checks fail without invoking their conditions', () => {
  let conditionalCalls = 0;
  const conditional = new core.$ZodCheckMinLength({
    check: 'min_length', minimum: 1, when: () => { conditionalCalls += 1; return false; },
  });
  for (const schema of [z.array(z.string()).min(1), z.array(z.string()).max(1), z.array(z.string()).length(1), z.array(z.string()).check(conditional)]) {
    rejected(z.strictObject({ rows: schema }), /createAgentOutputDefinition.*minItems\/maxItems/);
  }
  assert.equal(conditionalCalls, 0);
});

test('conditional numeric core checks cannot narrow the native schema by hiding a skipped local bound', () => {
  let conditionalCalls = 0;
  const when = () => { conditionalCalls += 1; return false; };
  const bound = new core.$ZodCheckGreaterThan({ check: 'greater_than', value: 1, inclusive: true, when });
  const integer = new core.$ZodNumberFormat({ type: 'number', check: 'number_format', format: 'safeint', when });
  for (const value of [z.number().check(bound), integer]) {
    rejected(z.strictObject({ value }), /Conditional numeric checks/);
  }
  assert.equal(conditionalCalls, 0);
});

test('metadata and clone parent graphs do not participate in finite output admission', () => {
  let metadataReads = 0;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  Object.defineProperty(cyclic, 'description', { enumerable: true, get() { metadataReads += 1; throw new Error('Metadata is not portable schema authority.'); } });
  let child = z.string().meta({ type: 'number', nested: cyclic });
  for (let index = 0; index < 1_000; index += 1) child = child.clone();
  const definition = zodOutput(z.strictObject({ title: child }).describe('Ignored annotation'));
  assert.deepEqual(definition.schema, {
    type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false,
  });
  assert.deepEqual(definition.decode({ title: 'Ready' }), { success: true, data: { title: 'Ready' } });
  assert.equal(metadataReads, 0);
});

test('Zod traversal bounds recursive graphs, expanded reuse, source checks, depth and string budgets', () => {
  const recursive = z.strictObject({ get child() { return recursive; } });
  rejected(recursive, /Recursive Zod/);
  let expanded: core.$ZodType = z.string();
  for (let index = 0; index < 6; index += 1) expanded = z.strictObject({ a: expanded, b: expanded, c: expanded });
  rejected(expanded, /schema node limit/);
  let deep: core.$ZodType = z.string();
  for (let index = 0; index < 8; index += 1) deep = z.strictObject({ nested: deep });
  rejected(deep, /depth limit/);
  rejected(z.strictObject({ value: z.number().check(...Array.from({ length: 257 }, () => z.gte(0))) }), /source check limit/);
  rejected(z.strictObject(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`p${index}`, z.null()]))), /property limit/);
  rejected(z.strictObject({ value: z.enum(Array.from({ length: 101 }, (_, index) => `v${index}`)) }), /entry limit/);
  rejected(z.strictObject({ value: z.enum(Array.from({ length: 100 }, (_, index) => `${index}${'x'.repeat(200)}`)) }), /byte limit/);
  rejected(z.strictObject({ value: z.literal('x'.repeat(16_385)) }), /byte limit/);
  rejected(z.strictObject({ value: z.number().min(2).max(1) }), /contradictory/);
  const nullable = Object.fromEntries(Array.from({ length: 85 }, (_, index) => [`p${index}`, z.string().nullable()]));
  const definition = zodOutput(z.strictObject(nullable));
  const value = Object.fromEntries(Array.from({ length: 85 }, (_, index) => [`p${index}`, null]));
  assert.deepEqual(definition.decode(value), { success: true, data: value });
  rejected(z.strictObject({ ...nullable, extra: z.boolean() }), /schema node limit/);
});
