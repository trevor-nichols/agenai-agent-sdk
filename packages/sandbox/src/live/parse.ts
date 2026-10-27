import { z } from 'zod/v4';
import { SandboxOperationError } from '../errors.js';
import { transferData } from '../files/parse.js';
import { parseSandboxRelativePath } from '../files/paths.js';
import { invalidInput } from '../internal/data.js';
import { parseOperationOptions } from '../internal/operations.js';
import type { SandboxDriverFileOptions } from './driver.js';
import type { SandboxFileEntry, SandboxFileOptions, SandboxFileObservation, SandboxFileStatResult,
  SandboxFileWriteOptions, SandboxFileWriteResult, SandboxLivePath } from './types.js';

export interface ParsedFileOptions {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly quotas: SandboxDriverFileOptions['quotas'];
}
export interface ParsedFileWriteOptions extends ParsedFileOptions { readonly mode: 'create' | 'replace' }

export function parseFilePath(input: unknown, root: boolean): SandboxLivePath {
  return root && input === '.' ? '.' : parseSandboxRelativePath(input);
}

export function parseFileOptions(input: SandboxFileOptions | undefined, write = false): ParsedFileOptions {
  const data = input === undefined ? {} : transferData(input, write ? ['signal', 'deadlineAt', 'quotas', 'mode'] : ['signal', 'deadlineAt', 'quotas']);
  const cancellation = parseOperationOptions(data.signal === undefined ? undefined : { signal: data.signal });
  let deadlineAt: number | undefined;
  if (data.deadlineAt !== undefined) {
    if (!z.iso.datetime({ offset: true }).safeParse(data.deadlineAt).success) invalidInput('Live file deadlineAt must be an ISO timestamp');
    deadlineAt = Date.parse(String(data.deadlineAt));
    if (!Number.isSafeInteger(deadlineAt)) invalidInput('Live file deadlineAt must be representable in milliseconds');
  }
  const quotas: { maxBytes?: bigint; maxEntries?: bigint } = {};
  if (data.quotas !== undefined) {
    const selected = transferData(data.quotas, ['maxBytes', 'maxEntries']);
    for (const key of ['maxBytes', 'maxEntries'] as const) {
      const value = selected[key];
      if (value === undefined) continue;
      if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value))) invalidInput('Live file quotas must be nonnegative integers');
      if (value < 0) invalidInput('Live file quotas must be nonnegative integers');
      quotas[key] = BigInt(value);
    }
  }
  return Object.freeze({ ...cancellation, ...(deadlineAt === undefined ? {} : { deadlineAt }), quotas: Object.freeze(quotas) });
}

export function parseFileWriteOptions(input: SandboxFileWriteOptions): ParsedFileWriteOptions {
  const data = transferData(input, ['signal', 'deadlineAt', 'quotas', 'mode']);
  if (data.mode !== 'create' && data.mode !== 'replace') invalidInput('Live writes require explicit create or replace mode');
  return Object.freeze({ ...parseFileOptions(input, true), mode: data.mode });
}

function driverFailure(message: string): never { throw new SandboxOperationError('driver_failure', message); }
function permissions(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0o777) driverFailure('Live metadata requires permission bits in 0..0o777.');
  return value;
}
export function parseFileEntry(input: unknown): SandboxFileEntry {
  const data = transferData(input, ['kind', 'path', 'byteLength', 'permissions']);
  const path = parseFilePath(data.path, true);
  if (data.kind !== 'file' && data.kind !== 'directory' && data.kind !== 'symlink'
    && data.kind !== 'unsupported_hardlink' && data.kind !== 'unsupported_special') driverFailure('Backend returned an unsupported live metadata kind.');
  if (path === '.' && data.kind !== 'directory') driverFailure('Only the directory root can use the live root sentinel.');
  if (typeof data.byteLength !== 'number' || !Number.isSafeInteger(data.byteLength) || data.byteLength < 0) driverFailure('Live metadata requires a safe byte length.');
  return Object.freeze({ kind: data.kind, path, byteLength: data.byteLength, permissions: permissions(data.permissions) });
}

export function parseFileObservation(input: unknown, fields: readonly string[] = []): SandboxFileObservation {
  const data = transferData(input, ['kind', 'reason', ...fields]);
  if (data.kind === 'completed' || data.kind === 'changed' || data.kind === 'missing') {
    if (data.reason !== undefined) driverFailure('Live completion observations cannot carry a reason.');
    return Object.freeze({ kind: data.kind });
  }
  if (data.kind === 'rejected' && (data.reason === 'path_resolution' || data.reason === 'unsupported_type' || data.reason === 'hardlink'
    || data.reason === 'already_exists' || data.reason === 'quota_exceeded' || data.reason === 'permission_denied')) return Object.freeze({ kind: data.kind, reason: data.reason });
  if (data.kind === 'cancelled' && (data.reason === 'signal' || data.reason === 'deadline' || data.reason === 'callback_closed' || data.reason === 'stopped')) return Object.freeze({ kind: data.kind, reason: data.reason });
  return driverFailure('Backend returned an invalid live terminal observation.');
}

export function parseFileStatResult(input: unknown, path: SandboxLivePath): SandboxFileStatResult {
  const observation = parseFileObservation(input, ['entry']);
  const data = transferData(input, ['kind', 'reason', 'entry']);
  if (observation.kind === 'completed') {
    const entry = parseFileEntry(data.entry);
    if (entry.path !== path) driverFailure('Backend stat metadata does not match the selected path.');
    return Object.freeze({ ...observation, entry });
  }
  if (data.entry !== undefined) driverFailure('An incomplete stat cannot claim complete metadata.');
  return observation;
}

export function parseFileCount(input: unknown, field: 'bytes' | 'entries', actual: bigint): SandboxFileObservation {
  const observation = parseFileObservation(input, [field]);
  const data = transferData(input, ['kind', 'reason', field]);
  if (data[field] !== actual) driverFailure('Backend live terminal counter does not match the delivered data.');
  return observation;
}

export function parseFileWriteResult(input: unknown, actual: bigint): SandboxFileWriteResult {
  const data = transferData(input, ['kind', 'effect', 'bytes', 'permissions', 'reason']);
  const unknownCount = data.bytes === null && (data.kind === 'uncertain' || (data.kind === 'cancelled' && data.effect === 'unknown'));
  if (!unknownCount && (typeof data.bytes !== 'bigint' || data.bytes < 0n || data.bytes > actual)) driverFailure('Backend write counter exceeds its consumed source.');
  const bytes = data.bytes;
  if ((data.kind === 'completed' || data.kind === 'changed') && data.effect === 'published' && data.reason === undefined) {
    if (typeof bytes !== 'bigint' || bytes !== actual) driverFailure('Published write counter does not match its complete consumed source.');
    return Object.freeze({ kind: data.kind, effect: data.effect, bytes, permissions: permissions(data.permissions) });
  }
  if (data.permissions !== undefined) driverFailure('Unconfirmed writes cannot claim publication permission bits.');
  if (data.kind === 'uncertain' && (data.effect === 'published' || data.effect === 'unknown') && data.reason === undefined && (bytes === null || typeof bytes === 'bigint')) return Object.freeze({ kind: data.kind, effect: data.effect, bytes });
  const observation = parseFileObservation({ kind: data.kind, ...(data.reason === undefined ? {} : { reason: data.reason }) });
  if (observation.kind === 'cancelled' && data.effect === 'unknown' && (bytes === null || typeof bytes === 'bigint')) return Object.freeze({ ...observation, effect: data.effect, bytes });
  if (observation.kind === 'cancelled' && data.effect === 'none' && typeof bytes === 'bigint') return Object.freeze({ ...observation, effect: data.effect, bytes });
  if ((observation.kind === 'missing' || observation.kind === 'rejected') && data.effect === 'none' && typeof bytes === 'bigint') return Object.freeze({ ...observation, effect: data.effect, bytes });
  return driverFailure('Backend returned an invalid live write publication observation.');
}
