// ------------------------------------------------------------------------------------------------
//                errors.ts - Validator-neutral failures and retained cleanup ownership
// ------------------------------------------------------------------------------------------------

import type { ValidationIssue } from '@agen-ai/validation';
import type { SandboxCleanupOwner } from './recovery/types.js';

export type SandboxOperationErrorCode = 'cancelled' | 'deadline_exceeded' | 'output_limit' | 'input_limit' | 'stream_failure' | 'persistence_failure' | 'driver_failure';

export class SandboxOperationError extends Error {
  readonly code: SandboxOperationErrorCode;

  constructor(code: SandboxOperationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxOperationError';
    this.code = code;
  }
}

export class SandboxValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('Invalid sandbox input');
    this.name = 'SandboxValidationError';
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue, path: Object.freeze([...issue.path]) })));
  }
}

export class SandboxUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnsupportedError';
  }
}

export class SandboxStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxStateError';
  }
}

export class SandboxCleanupError extends Error {
  readonly owner: SandboxCleanupOwner;
  readonly operation: 'stop' | 'destroy';

  constructor(message: string, options: { cause: unknown; owner: SandboxCleanupOwner; operation: 'stop' | 'destroy' }) {
    super(message, { cause: options.cause });
    this.name = 'SandboxCleanupError';
    this.owner = options.owner;
    this.operation = options.operation;
  }

  retryCleanup(): Promise<void> {
    return this.owner[this.operation]();
  }
}

export class SandboxStartError extends Error {
  readonly owner: SandboxCleanupOwner;

  constructor(message: string, options: { cause: unknown; owner: SandboxCleanupOwner }) {
    super(message, { cause: options.cause });
    this.name = 'SandboxStartError';
    this.owner = options.owner;
  }
}

export class SandboxRunError extends Error {
  readonly primaryError: unknown;
  readonly cleanupError: unknown;
  readonly owner: SandboxCleanupOwner;

  constructor(options: { primaryError: unknown; cleanupError: unknown; owner: SandboxCleanupOwner }) {
    super('Sandbox operation and cleanup both failed', { cause: options.primaryError });
    this.name = 'SandboxRunError';
    this.primaryError = options.primaryError;
    this.cleanupError = options.cleanupError;
    this.owner = options.owner;
  }

  retryCleanup(): Promise<void> {
    return this.owner.destroy();
  }
}
