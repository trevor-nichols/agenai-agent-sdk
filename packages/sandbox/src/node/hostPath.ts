// ------------------------------------------------------------------------------------------------
//                hostPath.ts - Canonical caller-selected filesystem authority and identity checks
// ------------------------------------------------------------------------------------------------

import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { SandboxOperationError } from '../errors.js';
import { invalidInput } from '../internal/data.js';

export function canonicalHostPath(input: unknown): string {
  if (typeof input !== 'string' || input.includes('\0') || !isAbsolute(input) || normalize(input) !== input
    || (input.length > 1 && input.endsWith('/'))) invalidInput('Select an explicit canonical absolute host path');
  return input;
}

export async function verifyHostDirectory(path: string, signal?: AbortSignal): Promise<BigIntStats> {
  signal?.throwIfAborted();
  const metadata = await lstat(path, { bigint: true });
  signal?.throwIfAborted();
  if (!metadata.isDirectory() || await realpath(path) !== path) invalidInput('Host root must be an existing canonical directory without symlink components');
  signal?.throwIfAborted();
  return metadata;
}

export function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function verifyDirectoryIdentity(path: string, expected: BigIntStats): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (!current.isDirectory() || !sameIdentity(current, expected)) {
    throw new SandboxOperationError('input_limit', 'Host directory identity changed during the transfer.');
  }
}

export function verifyRegularIdentity(current: BigIntStats, expected: BigIntStats): void {
  if (!current.isFile() || !sameIdentity(current, expected) || current.size !== expected.size
    || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs) {
    throw new SandboxOperationError('input_limit', 'Host file identity, length or modification metadata changed during the transfer.');
  }
}
