// ------------------------------------------------------------------------------------------------
//                validation.ts - Validator-neutral protocol result and error contracts
// ------------------------------------------------------------------------------------------------

import type { ValidationIssue } from '@agen-ai/validation';

export type { ValidationIssue, ValidationPathSegment } from '@agen-ai/validation';

export interface AgentProtocolParseSuccess<T> {
  readonly success: true;
  readonly data: T;
}

export interface AgentProtocolParseFailure {
  readonly success: false;
  readonly issues: readonly ValidationIssue[];
}

export type AgentProtocolParseResult<T> =
  | AgentProtocolParseSuccess<T>
  | AgentProtocolParseFailure;

export class AgentProtocolValidationError extends TypeError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('Agent protocol validation failed.');
    this.name = 'AgentProtocolValidationError';
    this.issues = issues;
  }
}
