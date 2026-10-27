// ------------------------------------------------------------------------------------------------
//                parse.ts - Streaming metadata and caller-selected transfer admission
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { invalidInput } from '../internal/data.js';
import { parseOperationOptions } from '../internal/operations.js';
import { parseSandboxRelativePath, parseSandboxSymlinkTarget } from './paths.js';
import type { SandboxCapturedTreeSelection, SandboxSymlinkPolicy, SandboxTransferBudget, SandboxTransferOptions, SandboxTransferSummary } from './types.js';

export function transferData(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object'
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) invalidInput('Transfer metadata must be a plain object');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalidInput('Unexpected transfer metadata field');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalidInput('Transfer metadata must contain enumerable data fields');
    result[key] = descriptor.value;
  }
  return result;
}

export interface ParsedTransferOptions {
  readonly symlinks: SandboxSymlinkPolicy;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly quotas: SandboxTransferBudget;
}

export function parseTransferOptions(input: SandboxTransferOptions | undefined): ParsedTransferOptions {
  const data = input === undefined ? {} : transferData(input, ['signal', 'deadlineAt', 'quotas', 'symlinks']);
  const symlinks = data.symlinks === undefined ? 'reject' : data.symlinks;
  if (symlinks !== 'reject' && symlinks !== 'preserve_internal') invalidInput('Transfer symlinks must be reject or preserve_internal');
  const cancellation = parseOperationOptions(data.signal === undefined ? undefined : { signal: data.signal });
  let deadlineAt: number | undefined;
  if (data.deadlineAt !== undefined) {
    if (!z.iso.datetime({ offset: true }).safeParse(data.deadlineAt).success) invalidInput('Transfer deadlineAt must be an ISO timestamp');
    deadlineAt = Date.parse(String(data.deadlineAt));
    if (!Number.isSafeInteger(deadlineAt)) invalidInput('Transfer deadlineAt must be representable in milliseconds');
  }
  const quotas: Partial<Record<keyof SandboxTransferBudget, bigint>> = {};
  if (data.quotas !== undefined) {
    const selected = transferData(data.quotas, ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxArchiveBytes', 'maxPaths', 'maxSymlinks']);
    for (const key of ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxArchiveBytes', 'maxPaths', 'maxSymlinks'] as const) {
      const value = selected[key];
      if (value === undefined) continue;
      if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value))) invalidInput('Transfer quotas must be nonnegative integers');
      if (value < 0) invalidInput('Transfer quotas must be nonnegative integers');
      quotas[key] = BigInt(value);
    }
  }
  return Object.freeze({ symlinks, ...cancellation, ...(deadlineAt === undefined ? {} : { deadlineAt }), quotas: Object.freeze(quotas) });
}

export function parseTreeMetadata(input: unknown, bodyField: 'open' | 'bytes', symlinks: SandboxSymlinkPolicy = 'reject') {
  const data = transferData(input, ['kind', 'path', 'target', 'byteLength', 'executable', bodyField]);
  const path = parseSandboxRelativePath(data.path);
  if (data.kind === 'directory') {
    if (Reflect.ownKeys(data).length !== 2) invalidInput('Directories require only kind and path');
    return Object.freeze({ kind: 'directory' as const, path });
  }
  if (data.kind === 'symlink') {
    if (symlinks !== 'preserve_internal') invalidInput('Symbolic links require explicit preserve_internal transfer admission');
    if (Reflect.ownKeys(data).length !== 3) invalidInput('Symbolic links require only kind, path and target');
    return Object.freeze({ kind: 'symlink' as const, path, target: parseSandboxSymlinkTarget(data.target) });
  }
  if (data.kind !== 'file' || Reflect.ownKeys(data).length !== 5) invalidInput('Files require kind, path, byteLength, executable and a body source');
  if (typeof data.byteLength !== 'number' || !Number.isSafeInteger(data.byteLength) || data.byteLength < 0) invalidInput('File byteLength must be a nonnegative safe integer');
  if (typeof data.executable !== 'boolean') invalidInput('File executable must be boolean');
  if (bodyField === 'open' && typeof data.open !== 'function') invalidInput('Input files require an open function');
  return Object.freeze({ kind: 'file' as const, path, byteLength: data.byteLength, executable: data.executable, body: data[bodyField] });
}

export function parseTransferSummary(input: unknown): SandboxTransferSummary {
  const data = transferData(input, ['files', 'directories', 'symlinks', 'payloadBytes', 'archiveBytes']);
  const { files, directories, symlinks, payloadBytes, archiveBytes } = data;
  if (typeof files !== 'bigint' || files < 0n || typeof directories !== 'bigint' || directories < 0n
    || typeof symlinks !== 'bigint' || symlinks < 0n || typeof payloadBytes !== 'bigint' || payloadBytes < 0n || typeof archiveBytes !== 'bigint' || archiveBytes < 0n) invalidInput('Transfer summaries require nonnegative bigint counters');
  return Object.freeze({ files, directories, symlinks, payloadBytes, archiveBytes });
}

/** Captures selection grammar before awaits without enumerating a caller's streamed exact-file list. */
export function captureSandboxTreeSelection(input: unknown): SandboxCapturedTreeSelection {
  const data = transferData(input, ['kind', 'paths', 'path']);
  if (data.kind === 'workspace' && Reflect.ownKeys(data).length === 1) return Object.freeze({ kind: 'workspace' });
  if (data.kind === 'subtree' && Reflect.ownKeys(data).length === 2) return Object.freeze({ kind: 'subtree', path: parseSandboxRelativePath(data.path) });
  if (data.kind !== 'files' || Reflect.ownKeys(data).length !== 2 || data.paths === null
    || (typeof data.paths !== 'object' && typeof data.paths !== 'function')) invalidInput('Export requires a workspace, exact-file list or one directory subtree');
  return Object.freeze({ kind: 'files', paths: data.paths as AsyncIterable<string> | Iterable<string> });
}
