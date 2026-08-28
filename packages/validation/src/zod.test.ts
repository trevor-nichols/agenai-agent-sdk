// ------------------------------------------------------------------------------------------------
//                zod.test.ts - Schema-aware normalization coverage - Dependencies: node:test, Zod 4
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod/v4';

import { normalizeZodValidationError } from './zod.js';

function normalizedFailure(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  assert.equal(result.success, false);
  if (result.success) return [];
  return normalizeZodValidationError(schema, result.error, input);
}

test('distinguishes single-option enums from literals', () => {
  const providerSchema = z.enum(['digitalocean']);
  const confirmationSchema = z.literal('confirm');

  assert.deepEqual(normalizedFailure(providerSchema, 'aws'), [
    {
      code: 'invalid_enum_value',
      path: [],
      message:
        "Invalid enum value. Expected 'digitalocean', received 'aws'",
    },
  ]);
  assert.deepEqual(normalizedFailure(providerSchema, undefined), [
    {
      code: 'invalid_type',
      path: [],
      message: 'Required',
    },
  ]);
  assert.deepEqual(normalizedFailure(confirmationSchema, 'reject'), [
    {
      code: 'invalid_literal',
      path: [],
      message: 'Invalid literal value, expected "confirm"',
    },
  ]);
});

test('resolves nested enum and literal schema context', () => {
  const schema = z.object({
    providers: z.array(
      z.object({
        id: z.enum(['digitalocean']),
        confirmation: z.literal('confirm'),
      }),
    ),
  });
  const input = {
    providers: [{ id: 'aws', confirmation: 'reject' }],
  };

  assert.deepEqual(normalizedFailure(schema, input), [
    {
      code: 'invalid_enum_value',
      path: ['providers', 0, 'id'],
      message:
        "Invalid enum value. Expected 'digitalocean', received 'aws'",
    },
    {
      code: 'invalid_literal',
      path: ['providers', 0, 'confirmation'],
      message: 'Invalid literal value, expected "confirm"',
    },
  ]);
});
