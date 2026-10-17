// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain request parsers and exact resolution checks
// ------------------------------------------------------------------------------------------------

import type { ValidationIssue } from '@agen-ai/validation';

import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
} from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { elicitationResponseIssues } from './elicitation.js';
import {
  AgentApprovalRequestSchema,
  AgentApprovalResolutionSchema,
  AgentRequestResolutionSchema,
  AgentRequestSchema,
} from '../zod/requests.js';
import type {
  AgentApprovalRequest,
  AgentApprovalResolution,
  AgentRequest,
  AgentRequestResolution,
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

  issues.push(...elicitationResponseIssues(request.fields, resolution.answers));
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
