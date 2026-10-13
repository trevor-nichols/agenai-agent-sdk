// ------------------------------------------------------------------------------------------------
//                errors.ts - Validator-neutral delegation parser failures
// ------------------------------------------------------------------------------------------------

import {
  normalizeValidationError,
  type ValidationErrorInput,
  type ValidationIssue,
} from "@agen-ai/validation";
import { freezeDelegationData } from "./immutable.js";

export type DelegationValidationIssue = ValidationIssue;

export class DelegationValidationError extends Error {
  readonly issues: readonly DelegationValidationIssue[];

  constructor(issues: readonly DelegationValidationIssue[]) {
    super("Delegation data is invalid.");
    this.name = "DelegationValidationError";
    this.issues = freezeDelegationData(issues.slice(0, 100).map((issue) => ({
      code: issue.code, path: [...issue.path], message: issue.message,
    })));
  }
}

export function invalidDelegationData(
  code: string,
  path: readonly (string | number)[],
  message: string,
): never {
  throw new DelegationValidationError([{ code, path, message }]);
}

export function delegationSchemaError(error: ValidationErrorInput, input: unknown): never {
  throw new DelegationValidationError(normalizeValidationError(error, input));
}
