import { normalizeValidationError, type ValidationErrorInput, type ValidationIssue } from '@agen-ai/validation';
import { deepFreeze } from './immutable.js';

export type AcpRegistryIssue = ValidationIssue;

export class AcpRegistryValidationError extends Error {
  readonly issues: readonly AcpRegistryIssue[];

  constructor(issues: readonly AcpRegistryIssue[]) {
    super('The ACP registry snapshot is invalid.');
    this.name = 'AcpRegistryValidationError';
    this.issues = deepFreeze(issues.map((issue) => ({ ...issue, path: [...issue.path] })));
  }
}

export function invalidRegistry(code: string, path: readonly (string | number)[], message: string): never {
  throw new AcpRegistryValidationError([{ code, path, message }]);
}

export function registrySchemaError(error: ValidationErrorInput, input: unknown): never {
  throw new AcpRegistryValidationError(normalizeValidationError(error, input));
}
