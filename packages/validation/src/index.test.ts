// ------------------------------------------------------------------------------------------------
//                index.test.ts - Stable issue-dialect compatibility coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeValidationError,
  normalizeValidationIssues,
} from './index.js';

test('normalizes default invalid-type failures without replacing custom messages', () => {
  assert.deepEqual(
    normalizeValidationIssues(
      [
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['name'],
          message: 'Invalid input: expected string, received undefined',
        },
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['count'],
          message: 'Invalid input: expected string, received number',
        },
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['custom'],
          message: 'Use a text value.',
        },
      ],
      { count: 2, custom: false },
    ),
    [
      { code: 'invalid_type', path: ['name'], message: 'Required' },
      {
        code: 'invalid_type',
        path: ['count'],
        message: 'Expected string, received number',
      },
      {
        code: 'invalid_type',
        path: ['custom'],
        message: 'Use a text value.',
      },
    ],
  );
});

test('normalizes lower and upper bound failures with established wording', () => {
  assert.deepEqual(
    normalizeValidationIssues(
      [
        {
          code: 'too_small',
          origin: 'string',
          minimum: 3,
          inclusive: true,
          path: ['title'],
          message: 'Too small: expected string to have >=3 characters',
        },
        {
          code: 'too_small',
          origin: 'array',
          minimum: 2,
          inclusive: false,
          path: ['items'],
          message: 'Too small: expected array to have >2 items',
        },
        {
          code: 'too_big',
          origin: 'number',
          maximum: 10,
          inclusive: true,
          path: ['count'],
          message: 'Too big: expected number to be <=10',
        },
      ],
      {},
    ),
    [
      {
        code: 'too_small',
        path: ['title'],
        message: 'String must contain at least 3 character(s)',
      },
      {
        code: 'too_small',
        path: ['items'],
        message: 'Array must contain more than 2 element(s)',
      },
      {
        code: 'too_big',
        path: ['count'],
        message: 'Number must be less than or equal to 10',
      },
    ],
  );
});

test('normalizes string formats to the established issue code and messages', () => {
  assert.deepEqual(
    normalizeValidationIssues(
      [
        {
          code: 'invalid_format',
          format: 'regex',
          message: 'Invalid string: must match pattern /^a$/',
        },
        {
          code: 'invalid_format',
          format: 'email',
          message: 'Invalid email address',
        },
        {
          code: 'invalid_format',
          format: 'datetime',
          message: 'Invalid ISO datetime',
        },
        {
          code: 'invalid_format',
          format: 'includes',
          includes: 'agenai',
          message: 'Invalid string: must include "agenai"',
        },
        {
          code: 'invalid_format',
          format: 'email',
          message: 'Use a company email address.',
        },
      ],
      {},
    ),
    [
      { code: 'invalid_string', path: [], message: 'Invalid' },
      { code: 'invalid_string', path: [], message: 'Invalid email' },
      { code: 'invalid_string', path: [], message: 'Invalid datetime' },
      {
        code: 'invalid_string',
        path: [],
        message: 'Invalid input: must include "agenai"',
      },
      {
        code: 'invalid_string',
        path: [],
        message: 'Use a company email address.',
      },
    ],
  );
});

test('normalizes missing and invalid enum values', () => {
  assert.deepEqual(
    normalizeValidationIssues(
      [
        {
          code: 'invalid_value',
          values: ['owner', 'admin', 'member'],
          path: ['role'],
          message:
            'Invalid option: expected one of "owner"|"admin"|"member"',
        },
        {
          code: 'invalid_value',
          values: ['starting', 'completed'],
          path: ['status', 1],
          message: 'Invalid option',
        },
      ],
      { status: 'pending,waiting_for_user' },
    ),
    [
      {
        code: 'invalid_type',
        path: ['role'],
        message: 'Required',
      },
      {
        code: 'invalid_enum_value',
        path: ['status', 1],
        message:
          "Invalid enum value. Expected 'starting' | 'completed', received 'waiting_for_user'",
      },
    ],
  );
});

test('normalizes validator errors through the convenience facade', () => {
  assert.deepEqual(
    normalizeValidationError(
      {
        issues: [
          {
            code: 'invalid_type',
            expected: 'string',
            path: ['email'],
            message: 'Invalid input: expected string, received undefined',
          },
        ],
      },
      {},
    ),
    [{ code: 'invalid_type', path: ['email'], message: 'Required' }],
  );
});

test('normalizes finite, multiple-of, and discriminated-union failures', () => {
  assert.deepEqual(
    normalizeValidationIssues(
      [
        {
          code: 'invalid_type',
          expected: 'number',
          path: ['usageAmount'],
          message: 'Invalid input: expected number, received number',
        },
        {
          code: 'not_multiple_of',
          divisor: 1,
          origin: 'number',
          path: ['providerInstanceId'],
          message: 'Invalid number: must be a multiple of 1',
        },
        {
          code: 'invalid_union',
          note: 'No matching discriminator',
          discriminator: 'eventType',
          options: ['turn.started', 'turn.completed'],
          path: ['eventType'],
          message:
            "Invalid discriminator value. Expected 'turn.started' | 'turn.completed'",
        },
      ],
      {
        usageAmount: Number.POSITIVE_INFINITY,
        providerInstanceId: 1.5,
        eventType: 'turn.erased',
      },
    ),
    [
      {
        code: 'not_finite',
        path: ['usageAmount'],
        message: 'Number must be finite',
      },
      {
        code: 'not_multiple_of',
        path: ['providerInstanceId'],
        message: 'Number must be a multiple of 1',
      },
      {
        code: 'invalid_union_discriminator',
        path: ['eventType'],
        message:
          "Invalid discriminator value. Expected 'turn.started' | 'turn.completed'",
      },
    ],
  );
});
