// ------------------------------------------------------------------------------------------------
//                parse.ts - Explicit process recipe and closed leader exit receipt parsing
// ------------------------------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import { z } from 'zod/v4';
import { guestPathSchema } from '../files/pathSchemas.js';
import { utf8Within } from '../internal/data.js';
import { parseData } from '../internal/parse.js';
import { SANDBOX_LIMITS } from '../policy/limits.js';
import type { SandboxProcessExit, SandboxProcessSpec } from './types.js';

const argumentSchema = z.string().refine((value) => !value.includes('\0') && utf8Within(value, SANDBOX_LIMITS.maxRecipeBytes), 'Process arguments must be bounded and NUL-free');
const environmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).max(SANDBOX_LIMITS.maxIdentityBytes),
  z.string().refine((value) => !value.includes('\0') && utf8Within(value, SANDBOX_LIMITS.maxEnvValueBytes), 'Environment values must be bounded and NUL-free'),
).refine((value) => Object.keys(value).length <= SANDBOX_LIMITS.maxEnvEntries, 'Too many explicit environment entries');

const processSchema = z.strictObject({
  executable: guestPathSchema,
  args: z.array(argumentSchema).max(SANDBOX_LIMITS.maxArgs),
  env: environmentSchema,
  cwd: guestPathSchema,
}).refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= SANDBOX_LIMITS.maxRecipeBytes, 'Process recipe exceeds its aggregate UTF-8 bound');

const exitSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exited'), code: z.number().int().min(0).max(255) }),
  z.strictObject({ kind: z.literal('signaled'), signal: z.string().regex(/^SIG[A-Z0-9]+$/u).max(64) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.literal('sandbox_stopped') }),
]);

export function parseSandboxProcessSpec(input: unknown): SandboxProcessSpec { return parseData(processSchema, input); }
export function parseSandboxProcessExit(input: unknown): SandboxProcessExit { return parseData(exitSchema, input); }
