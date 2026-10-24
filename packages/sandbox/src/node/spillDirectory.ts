// ------------------------------------------------------------------------------------------------
//                spillDirectory.ts - Explicit POSIX spill root admission without ambient discovery
// ------------------------------------------------------------------------------------------------

import type { OperationOptions } from '../contracts.js';
import { SandboxUnsupportedError } from '../errors.js';
import { parseOperationOptions } from '../internal/operations.js';
import { canonicalHostPath, verifyHostDirectory } from './hostPath.js';

export function parseSandboxSpillDirectory(input: unknown): string {
  return canonicalHostPath(input);
}

export async function verifySandboxSpillDirectory(directory: string, input?: OperationOptions): Promise<void> {
  const root = parseSandboxSpillDirectory(directory);
  const { signal } = parseOperationOptions(input);
  signal?.throwIfAborted();
  if (process.platform === 'win32') throw new SandboxUnsupportedError('Metadata spill requires POSIX create-and-unlink semantics.');
  await verifyHostDirectory(root, signal);
}
