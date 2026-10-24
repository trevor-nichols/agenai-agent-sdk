// ------------------------------------------------------------------------------------------------
//                paths.ts - Bounded canonical relative and absolute guest path parsing
// ------------------------------------------------------------------------------------------------

import { parseData } from '../internal/parse.js';
import { guestPathSchema, relativePathSchema } from './pathSchemas.js';
import type { SandboxGuestPath, SandboxRelativePath } from './types.js';

export function parseSandboxRelativePath(input: unknown): SandboxRelativePath { return parseData(relativePathSchema, input); }
export function parseSandboxGuestPath(input: unknown): SandboxGuestPath { return parseData(guestPathSchema, input); }
