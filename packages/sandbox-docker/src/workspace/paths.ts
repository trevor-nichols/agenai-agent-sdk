// ------------------------------------------------------------------------------------------------
//                paths.ts - Fixed Docker archive roots and bounded canonical entry names
// ------------------------------------------------------------------------------------------------

import { SANDBOX_LIMITS, SandboxOperationError, SandboxValidationError, parseSandboxRelativePath, parseSandboxSymlinkTarget } from '@agen-ai/sandbox';

export const ARCHIVE_ROOT = 'workspace';
export const ARCHIVE_WORK = `${ARCHIVE_ROOT}/work`;

export function archiveError(message: string): SandboxOperationError {
  return new SandboxOperationError('driver_failure', `Unsafe workspace archive: ${message}`);
}

export function unsafeArchive(message: string): never {
  throw archiveError(message);
}

export function symlinkTarget(target: string): string {
  try { return parseSandboxSymlinkTarget(target); }
  catch (error) {
    if (error instanceof SandboxValidationError) unsafeArchive('symbolic-link targets require bounded raw relative text.');
    throw error;
  }
}

export function archiveName(name: string, directory: boolean): string {
  const canonical = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = canonical.split('/');
  if (Buffer.byteLength(canonical) > SANDBOX_LIMITS.maxPathBytes + ARCHIVE_WORK.length + 1
    || segments.length > SANDBOX_LIMITS.maxPathSegments + 2
    || /[\\\p{Cc}]/u.test(canonical)
    || segments.some((part) => !part || part === '.' || part === '..'
      || Buffer.byteLength(part) > SANDBOX_LIMITS.maxPathSegmentBytes)) {
    unsafeArchive('entry names must be bounded canonical relative paths.');
  }
  return canonical;
}

export function workspaceName(name: string, directory: boolean): string {
  const canonical = archiveName(name, directory);
  if (canonical === ARCHIVE_ROOT || canonical === ARCHIVE_WORK) {
    if (!directory) unsafeArchive('workspace roots must be directories.');
    return canonical;
  }
  if (!canonical.startsWith(`${ARCHIVE_WORK}/`)) unsafeArchive('entries must remain inside the owned work directory.');
  try { parseSandboxRelativePath(canonical.slice(ARCHIVE_WORK.length + 1)); }
  catch { unsafeArchive('work entries exceed the public relative-path bounds.'); }
  return canonical;
}
