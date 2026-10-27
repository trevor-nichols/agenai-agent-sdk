// ------------------------------------------------------------------------------------------------
//                paths.ts - Bounded canonical relative and absolute guest path parsing
// ------------------------------------------------------------------------------------------------

import { parseData } from '../internal/parse.js';
import { guestPathSchema, relativePathSchema, symlinkTargetSchema } from './pathSchemas.js';
import type { SandboxGuestPath, SandboxRelativePath, SandboxSymlinkTarget } from './types.js';

export function parseSandboxRelativePath(input: unknown): SandboxRelativePath { return parseData(relativePathSchema, input); }
export function parseSandboxGuestPath(input: unknown): SandboxGuestPath { return parseData(guestPathSchema, input); }
export function parseSandboxSymlinkTarget(input: unknown): SandboxSymlinkTarget { return parseData(symlinkTargetSchema, input); }
