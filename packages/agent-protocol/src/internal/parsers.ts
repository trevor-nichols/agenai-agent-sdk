// ------------------------------------------------------------------------------------------------
//                parsers.ts - Validator-neutral parser facade - Dependencies: validation, Zod 4
// ------------------------------------------------------------------------------------------------

import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import type { ZodType } from 'zod/v4';

import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
} from '../foundation/validation.js';

// ------------------------------------------------------------------------------------------------
//                Shared Parser Operations
// ------------------------------------------------------------------------------------------------

export function safeParseWithSchema<T>(
  schema: ZodType<T>,
  input: unknown,
): AgentProtocolParseResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    issues: normalizeZodValidationError(schema, parsed.error, input),
  };
}

export function parseWithSchema<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = safeParseWithSchema(schema, input);
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}
