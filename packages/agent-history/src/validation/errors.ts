import type { ValidationIssue } from '@agen-ai/validation';

export class AgentHistoryValidationError extends TypeError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('Agent history data is invalid.');
    this.name = 'AgentHistoryValidationError';
    this.issues = Object.freeze(issues.slice(0, 100).map((issue) => Object.freeze({
      code: issue.code.slice(0, 120),
      path: Object.freeze(issue.path.slice(0, 16).map((part) => typeof part === 'string' ? part.slice(0, 128) : part)),
      message: issue.message.slice(0, 512),
    })));
  }
}

export function invalidHistoryData(code: string, path: readonly (string | number)[], message: string): never {
  throw new AgentHistoryValidationError([{ code, path, message }]);
}
