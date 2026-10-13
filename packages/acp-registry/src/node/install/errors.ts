export type AcpInstallationErrorCode =
  | 'invalid_input' | 'unsupported_platform' | 'unsupported_format' | 'integrity_mismatch'
  | 'policy_denied' | 'artifact_unavailable' | 'limit_exceeded' | 'aborted' | 'timeout'
  | 'tool_failed' | 'toolchain_mismatch' | 'unsafe_archive' | 'store_busy' | 'store_invalid'
  | 'installation_not_found' | 'installation_mismatch' | 'payload_changed' | 'reference_active'
  | 'reference_mismatch' | 'recovery_conflict' | 'io_failure';

export class AcpInstallationError extends Error {
  readonly code: AcpInstallationErrorCode;

  constructor(code: AcpInstallationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcpInstallationError';
    this.code = code;
  }
}
