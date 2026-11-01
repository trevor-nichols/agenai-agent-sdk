import { createHash } from 'node:crypto';
import type { ConcurrentMemberLabel } from './types.js';

export const CONCURRENT_FIXTURE = Object.freeze({
  source: 'export const answer = 42;\n',
  instructions: 'Work only in project/. Keep immutable inputs and peer state unchanged.\n',
  initialProject: 'initial project state\n',
  initialNativeState: 'initial native state\n',
});

export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const memberProject = (label: ConcurrentMemberLabel): string => `project mutation by ${label}\n`;
export const memberNativeState = (label: ConcurrentMemberLabel): string => `native state mutation by ${label}\n`;
