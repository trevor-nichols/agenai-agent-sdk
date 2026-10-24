// ------------------------------------------------------------------------------------------------
//                pathSchemas.ts - Internal canonical guest and relative path schema composition
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { utf8Within } from '../internal/data.js';
import { SANDBOX_LIMITS } from '../policy/limits.js';
import type { SandboxGuestPath, SandboxRelativePath } from './types.js';

function safeSegments(path: string): boolean {
  const segments = path.split('/');
  return segments.length <= SANDBOX_LIMITS.maxPathSegments
    && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'
      && utf8Within(segment, SANDBOX_LIMITS.maxPathSegmentBytes));
}

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Within(value, SANDBOX_LIMITS.maxPathBytes)
    && !/[\\\u0000-\u001f\u007f]/u.test(value);
}

export const relativePathSchema = z.custom<SandboxRelativePath>((value) => safePath(value) && safeSegments(value), 'Expected a bounded canonical relative file path');
export const guestPathSchema = z.custom<SandboxGuestPath>((value) => safePath(value) && value.startsWith('/')
  && (value === '/' || safeSegments(value.slice(1))), 'Expected a bounded canonical absolute guest path');

