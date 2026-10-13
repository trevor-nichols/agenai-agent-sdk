import { AcpInstallationError, type AcpInstallationErrorCode } from '../errors.js';
import { AcpRegistryValidationError } from '../../../shared/errors.js';

export function storeFailure(code: AcpInstallationErrorCode, message: string, cause?: unknown): never {
  throw new AcpInstallationError(code, message, cause === undefined ? undefined : { cause });
}

export function isFilesystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function checkInstallationCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) storeFailure('aborted', 'Installation operation was canceled.');
}

export function validateStoreRecord<T>(code: AcpInstallationErrorCode, validate: () => T): T {
  try { return validate(); }
  catch (cause) {
    if (cause instanceof AcpRegistryValidationError) storeFailure(code, 'Retained installation state failed bounded validation.', cause);
    throw cause;
  }
}
