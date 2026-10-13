import { posix } from 'node:path';
import { AcpInstallationError } from '../errors.js';
import type { AcpInstallationLimits } from '../contracts.js';

export function archivePath(input: string, directory: boolean, limits: AcpInstallationLimits): string {
  if (input.length > limits.maxPathBytes || Buffer.byteLength(input) > limits.maxPathBytes) throw new AcpInstallationError('limit_exceeded', 'An archive path exceeds the configured byte limit.');
  if (/[\\:\p{Cc}\p{Cf}]/u.test(input) || input.startsWith('/')) unsafePath();
  const path = directory && input.endsWith('/') ? input.slice(0, -1) : input;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '..' || segment !== '.' && /[. ]$/u.test(segment))) unsafePath();
  const normalized = segments.filter((segment) => segment !== '.');
  if (normalized.length > limits.maxPathDepth) throw new AcpInstallationError('limit_exceeded', 'An archive path exceeds the configured depth.');
  if (!directory && normalized.length === 0) unsafePath();
  return normalized.join('/');
}

export function archiveLinkTarget(input: string, limits: AcpInstallationLimits): readonly string[] {
  if (input.length > limits.maxPathBytes || Buffer.byteLength(input) > limits.maxPathBytes) throw new AcpInstallationError('limit_exceeded', 'An archive link target exceeds the configured byte limit.');
  if (!input || /[\\:\p{Cc}\p{Cf}]/u.test(input) || input.startsWith('/')) unsafePath();
  const segments = input.split('/');
  if (segments.some((segment) => !segment || segment !== '.' && segment !== '..' && /[. ]$/u.test(segment))) unsafePath();
  if (segments.length > limits.maxPathDepth) throw new AcpInstallationError('limit_exceeded', 'An archive link target exceeds the configured depth.');
  return segments;
}

export function parentArchivePaths(path: string): readonly string[] {
  const segments = path.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

export function relativeArchiveTarget(path: string, target: string): string {
  return posix.relative(posix.dirname(path), target) || '.';
}

function unsafePath(): never {
  throw new AcpInstallationError('unsafe_archive', 'Archive paths and link targets must remain unambiguous and contained in the payload.');
}
