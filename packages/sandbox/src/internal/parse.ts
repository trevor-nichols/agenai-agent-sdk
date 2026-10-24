// ------------------------------------------------------------------------------------------------
//                parse.ts - Immutable schema parsing with validator-neutral issue errors
// ------------------------------------------------------------------------------------------------

import type { ZodType } from 'zod/v4';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { SandboxValidationError } from '../errors.js';
import { captureData, freezeData } from './data.js';

export function parseData<Value>(schema: ZodType<Value>, input: unknown): Value {
  const captured = captureData(input);
  const result = schema.safeParse(captured);
  if (!result.success) throw new SandboxValidationError(normalizeZodValidationError(schema, result.error, captured));
  return freezeData(result.data);
}
