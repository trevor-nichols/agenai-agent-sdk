// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain request parsers and exact resolution checks
// ------------------------------------------------------------------------------------------------

import type { ValidationIssue } from '@agen-ai/validation';

import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
} from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentApprovalRequestSchema,
  AgentApprovalResolutionSchema,
  AgentRequestResolutionSchema,
  AgentRequestSchema,
} from '../zod/requests.js';
import type {
  AgentApprovalRequest,
  AgentApprovalResolution,
  AgentElicitationAnswer,
  AgentElicitationField,
  AgentElicitationRequest,
  AgentMultiSelectElicitationAnswer,
  AgentMultiSelectElicitationField,
  AgentRequest,
  AgentRequestResolution,
  AgentSingleSelectElicitationAnswer,
  AgentSingleSelectElicitationField,
} from './types.js';

export function parseAgentRequest(input: unknown): AgentRequest {
  return parseWithSchema(AgentRequestSchema, input);
}

export function parseAgentApprovalRequest(input: unknown): AgentApprovalRequest {
  return parseWithSchema(AgentApprovalRequestSchema, input);
}

export function safeParseAgentApprovalRequest(
  input: unknown,
): AgentProtocolParseResult<AgentApprovalRequest> {
  return safeParseWithSchema(AgentApprovalRequestSchema, input);
}

export function safeParseAgentRequest(
  input: unknown,
): AgentProtocolParseResult<AgentRequest> {
  return safeParseWithSchema(AgentRequestSchema, input);
}

export function parseAgentRequestResolution(
  input: unknown,
): AgentRequestResolution {
  return parseWithSchema(AgentRequestResolutionSchema, input);
}

export function safeParseAgentRequestResolution(
  input: unknown,
): AgentProtocolParseResult<AgentRequestResolution> {
  return safeParseWithSchema(AgentRequestResolutionSchema, input);
}

export function parseAgentApprovalResolution(
  input: unknown,
): AgentApprovalResolution {
  return parseWithSchema(AgentApprovalResolutionSchema, input);
}

export function safeParseAgentApprovalResolution(
  input: unknown,
): AgentProtocolParseResult<AgentApprovalResolution> {
  return safeParseWithSchema(AgentApprovalResolutionSchema, input);
}

function issue(path: readonly (string | number)[], message: string): ValidationIssue {
  return { code: 'custom', path, message };
}

function fieldMap(
  request: AgentElicitationRequest,
): ReadonlyMap<string, AgentElicitationField> {
  return new Map(request.fields.map((field) => [field.fieldId, field]));
}

function singleSelectAnswerIssues(
  field: AgentSingleSelectElicitationField,
  answer: AgentSingleSelectElicitationAnswer,
  answerIndex: number,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedValues = new Set(field.options.map((option) => option.value));
  if (answer.value !== undefined && !allowedValues.has(answer.value)) {
    issues.push(issue(
      ['answers', answerIndex, 'value'],
      'Single-select answers must reference an option declared by the request.',
    ));
  }
  if (answer.other !== undefined && !field.allowOther) {
    issues.push(issue(
      ['answers', answerIndex, 'other'],
      'This request field does not accept a custom choice.',
    ));
  }
  return issues;
}

function multiSelectAnswerIssues(
  field: AgentMultiSelectElicitationField,
  answer: AgentMultiSelectElicitationAnswer,
  answerIndex: number,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedValues = new Set(field.options.map((option) => option.value));
  if (answer.values.some((value) => !allowedValues.has(value))) {
    issues.push(issue(
      ['answers', answerIndex, 'values'],
      'Multi-select answers must reference options declared by the request.',
    ));
  }
  if (answer.other !== undefined && !field.allowOther) {
    issues.push(issue(
      ['answers', answerIndex, 'other'],
      'This request field does not accept a custom choice.',
    ));
  }
  const selectionCount = answer.values.length + (answer.other === undefined ? 0 : 1);
  if (field.required && selectionCount === 0) {
    issues.push(issue(
      ['answers', answerIndex],
      'A required multi-select answer needs a declared option or a custom choice.',
    ));
  }
  if (selectionCount > field.maxSelections) {
    issues.push(issue(
      ['answers', answerIndex],
      'This request field exceeds its maximum selection count.',
    ));
  }
  return issues;
}

function answerIssues(
  field: AgentElicitationField,
  answer: AgentElicitationAnswer,
  answerIndex: number,
): readonly ValidationIssue[] {
  if (field.kind !== answer.kind) {
    return [issue(
      ['answers', answerIndex, 'kind'],
      'Answer kind must match the corresponding request field.',
    )];
  }
  if (field.kind === 'text' && answer.kind === 'text') {
    return answer.value.length <= field.maxLength
      ? []
      : [issue(
          ['answers', answerIndex, 'value'],
          'Text answer exceeds the field maximum length.',
        )];
  }
  if (field.kind === 'single_select' && answer.kind === 'single_select') {
    return singleSelectAnswerIssues(field, answer, answerIndex);
  }
  if (field.kind === 'multi_select' && answer.kind === 'multi_select') {
    return multiSelectAnswerIssues(field, answer, answerIndex);
  }
  return [];
}

function resolutionIssues(
  request: AgentRequest,
  resolution: AgentRequestResolution,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (request.requestKind !== resolution.requestKind) {
    issues.push(issue(
      ['requestKind'],
      'Resolution kind must match the request kind.',
    ));
  }
  if (request.requestId !== resolution.requestId) {
    issues.push(issue(
      ['requestId'],
      'Resolution requestId must match the opened request.',
    ));
  }
  if (
    request.requestKind === 'approval'
    && resolution.requestKind === 'approval'
    && resolution.disposition === 'selected'
    && !request.options.some(
      (option) => option.optionId === resolution.optionId,
    )
  ) {
    issues.push(issue(
      ['optionId'],
      'Approval resolution must select an option declared by the request.',
    ));
  }
  if (
    request.requestKind !== 'elicitation'
    || resolution.requestKind !== 'elicitation'
    || resolution.disposition !== 'answered'
  ) {
    return issues;
  }

  const fields = fieldMap(request);
  const answered = new Set<string>();
  resolution.answers.forEach((answer, answerIndex) => {
    if (answered.has(answer.fieldId)) {
      issues.push(issue(
        ['answers', answerIndex, 'fieldId'],
        'Each request field may be answered once.',
      ));
      return;
    }
    answered.add(answer.fieldId);
    const field = fields.get(answer.fieldId);
    if (!field) {
      issues.push(issue(
        ['answers', answerIndex, 'fieldId'],
        'Answer fieldId must reference a field declared by the request.',
      ));
      return;
    }
    issues.push(...answerIssues(field, answer, answerIndex));
  });

  for (const field of request.fields) {
    if (field.required && !answered.has(field.fieldId)) {
      issues.push(issue(
        ['answers'],
        `Required request field ${field.fieldId} is missing an answer.`,
      ));
    }
  }
  return issues;
}

export function safeParseAgentRequestResolutionFor(
  requestInput: unknown,
  resolutionInput: unknown,
): AgentProtocolParseResult<AgentRequestResolution> {
  const request = safeParseAgentRequest(requestInput);
  if (!request.success) return request;
  const resolution = safeParseAgentRequestResolution(resolutionInput);
  if (!resolution.success) return resolution;
  const issues = resolutionIssues(request.data, resolution.data);
  return issues.length === 0
    ? resolution
    : { success: false, issues };
}

export function parseAgentRequestResolutionFor(
  requestInput: unknown,
  resolutionInput: unknown,
): AgentRequestResolution {
  const parsed = safeParseAgentRequestResolutionFor(requestInput, resolutionInput);
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}
