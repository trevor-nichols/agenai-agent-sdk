import type { ValidationIssue } from '@agen-ai/validation';
import type { z } from 'zod/v4';

import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
} from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { elicitationResponseIssues } from '../requests/elicitation.js';
import {
  AgentSessionDecisionChoiceIdSchema,
  AgentSessionFormChoiceIdSchema,
  AgentSessionPlanReviewChoiceIdSchema,
  AgentSessionPlanIdSchema,
  AgentSessionPlanRevisionSchema,
  AgentSessionDecisionRequestSchema,
  AgentSessionFormRequestSchema,
  AgentSessionPlanReviewRequestSchema,
  AgentSessionRequestSchema,
  AgentSessionDecisionResponseSchema,
  AgentSessionFormResponseSchema,
  AgentSessionPlanReviewResponseSchema,
  AgentSessionResponseSchema,
} from '../zod/sessionInteractions.js';
import type {
  AgentSessionDecisionChoiceId,
  AgentSessionFormChoiceId,
  AgentSessionPlanReviewChoiceId,
  AgentSessionPlanId,
  AgentSessionPlanRevision,
  AgentSessionDecisionRequest,
  AgentSessionFormRequest,
  AgentSessionPlanReviewRequest,
  AgentSessionRequest,
  AgentSessionDecisionResponse,
  AgentSessionFormResponse,
  AgentSessionPlanReviewResponse,
  AgentSessionResponse,
} from './types.js';

export function parseAgentSessionDecisionChoiceId(input: unknown): AgentSessionDecisionChoiceId {
  return parseWithSchema(AgentSessionDecisionChoiceIdSchema, input);
}

export function safeParseAgentSessionDecisionChoiceId(
  input: unknown,
): AgentProtocolParseResult<AgentSessionDecisionChoiceId> {
  return safeParseWithSchema(AgentSessionDecisionChoiceIdSchema, input);
}

export function parseAgentSessionFormChoiceId(input: unknown): AgentSessionFormChoiceId {
  return parseWithSchema(AgentSessionFormChoiceIdSchema, input);
}

export function safeParseAgentSessionFormChoiceId(
  input: unknown,
): AgentProtocolParseResult<AgentSessionFormChoiceId> {
  return safeParseWithSchema(AgentSessionFormChoiceIdSchema, input);
}

export function parseAgentSessionPlanReviewChoiceId(input: unknown): AgentSessionPlanReviewChoiceId {
  return parseWithSchema(AgentSessionPlanReviewChoiceIdSchema, input);
}

export function safeParseAgentSessionPlanReviewChoiceId(
  input: unknown,
): AgentProtocolParseResult<AgentSessionPlanReviewChoiceId> {
  return safeParseWithSchema(AgentSessionPlanReviewChoiceIdSchema, input);
}

export function parseAgentSessionPlanId(input: unknown): AgentSessionPlanId {
  return parseWithSchema(AgentSessionPlanIdSchema, input);
}

export function safeParseAgentSessionPlanId(
  input: unknown,
): AgentProtocolParseResult<AgentSessionPlanId> {
  return safeParseWithSchema(AgentSessionPlanIdSchema, input);
}

export function parseAgentSessionPlanRevision(input: unknown): AgentSessionPlanRevision {
  return parseWithSchema(AgentSessionPlanRevisionSchema, input);
}

export function safeParseAgentSessionPlanRevision(
  input: unknown,
): AgentProtocolParseResult<AgentSessionPlanRevision> {
  return safeParseWithSchema(AgentSessionPlanRevisionSchema, input);
}

export function parseAgentSessionDecisionRequest(input: unknown): AgentSessionDecisionRequest {
  return parseWithSchema(AgentSessionDecisionRequestSchema, input);
}

export function safeParseAgentSessionDecisionRequest(
  input: unknown,
): AgentProtocolParseResult<AgentSessionDecisionRequest> {
  return safeParseWithSchema(AgentSessionDecisionRequestSchema, input);
}

export function parseAgentSessionFormRequest(input: unknown): AgentSessionFormRequest {
  return parseWithSchema(AgentSessionFormRequestSchema, input);
}

export function safeParseAgentSessionFormRequest(
  input: unknown,
): AgentProtocolParseResult<AgentSessionFormRequest> {
  return safeParseWithSchema(AgentSessionFormRequestSchema, input);
}

export function parseAgentSessionPlanReviewRequest(input: unknown): AgentSessionPlanReviewRequest {
  return parseWithSchema(AgentSessionPlanReviewRequestSchema, input);
}

export function safeParseAgentSessionPlanReviewRequest(
  input: unknown,
): AgentProtocolParseResult<AgentSessionPlanReviewRequest> {
  return safeParseWithSchema(AgentSessionPlanReviewRequestSchema, input);
}

export function parseAgentSessionRequest(input: unknown): AgentSessionRequest {
  return parseWithSchema(AgentSessionRequestSchema, input);
}

export function safeParseAgentSessionRequest(
  input: unknown,
): AgentProtocolParseResult<AgentSessionRequest> {
  return safeParseWithSchema(AgentSessionRequestSchema, input);
}

export function parseAgentSessionDecisionResponse(input: unknown): AgentSessionDecisionResponse {
  return parseWithSchema(AgentSessionDecisionResponseSchema, input);
}

export function safeParseAgentSessionDecisionResponse(
  input: unknown,
): AgentProtocolParseResult<AgentSessionDecisionResponse> {
  return safeParseWithSchema(AgentSessionDecisionResponseSchema, input);
}

export function parseAgentSessionFormResponse(input: unknown): AgentSessionFormResponse {
  return parseWithSchema(AgentSessionFormResponseSchema, input);
}

export function safeParseAgentSessionFormResponse(
  input: unknown,
): AgentProtocolParseResult<AgentSessionFormResponse> {
  return safeParseWithSchema(AgentSessionFormResponseSchema, input);
}

export function parseAgentSessionPlanReviewResponse(input: unknown): AgentSessionPlanReviewResponse {
  return parseWithSchema(AgentSessionPlanReviewResponseSchema, input);
}

export function safeParseAgentSessionPlanReviewResponse(
  input: unknown,
): AgentProtocolParseResult<AgentSessionPlanReviewResponse> {
  return safeParseWithSchema(AgentSessionPlanReviewResponseSchema, input);
}

export function parseAgentSessionResponse(input: unknown): AgentSessionResponse {
  return parseWithSchema(AgentSessionResponseSchema, input);
}

export function safeParseAgentSessionResponse(
  input: unknown,
): AgentProtocolParseResult<AgentSessionResponse> {
  return safeParseWithSchema(AgentSessionResponseSchema, input);
}

function issue(path: readonly (string | number)[], message: string): ValidationIssue {
  return { code: 'custom', path, message };
}

function sessionResponseIssues(
  request: AgentSessionRequest,
  response: AgentSessionResponse,
): readonly ValidationIssue[] {
  if (request.kind !== response.kind) {
    return [issue(['kind'], 'Session response kind must match the offered request.')];
  }
  const issues: ValidationIssue[] = [];
  const choice = request.choices.find((offered) => offered.choiceId === response.choiceId);
  if (!choice) {
    issues.push(issue(['choiceId'], 'The response must select a choice offered by this session request.'));
  } else if ('action' in choice && 'action' in response && choice.action !== response.action) {
    issues.push(issue(['action'], 'The response action must match the selected offered choice.'));
  }
  if (request.kind === 'form' && response.kind === 'form' && response.action === 'submit') {
    issues.push(...elicitationResponseIssues(request.fields, response.answers));
  }
  if (request.kind === 'plan_review' && response.kind === 'plan_review') {
    if (request.plan.planId !== response.planId) {
      issues.push(issue(['planId'], 'The response must identify the exact offered plan.'));
    }
    if (request.plan.revision !== response.revision) {
      issues.push(issue(['revision'], 'The response must identify the exact offered plan revision.'));
    }
  }
  return issues;
}

function safeParseSessionResponseFor<Request extends AgentSessionRequest, Response extends AgentSessionResponse>(
  requestSchema: z.ZodType<Request>,
  responseSchema: z.ZodType<Response>,
  requestInput: unknown,
  responseInput: unknown,
): AgentProtocolParseResult<Response> {
  const request = safeParseWithSchema(requestSchema, requestInput);
  if (!request.success) return request;
  const response = safeParseWithSchema(responseSchema, responseInput);
  if (!response.success) return response;
  const issues = sessionResponseIssues(request.data, response.data);
  return issues.length === 0 ? response : { success: false, issues };
}

export function safeParseAgentSessionDecisionResponseFor(
  requestInput: unknown,
  responseInput: unknown,
): AgentProtocolParseResult<AgentSessionDecisionResponse> {
  return safeParseSessionResponseFor(AgentSessionDecisionRequestSchema, AgentSessionDecisionResponseSchema, requestInput, responseInput);
}

export function parseAgentSessionDecisionResponseFor(
  request: AgentSessionDecisionRequest,
  input: unknown,
): AgentSessionDecisionResponse {
  const parsed = safeParseAgentSessionDecisionResponseFor(request, input);
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}

export function safeParseAgentSessionFormResponseFor(
  requestInput: unknown,
  responseInput: unknown,
): AgentProtocolParseResult<AgentSessionFormResponse> {
  return safeParseSessionResponseFor(AgentSessionFormRequestSchema, AgentSessionFormResponseSchema, requestInput, responseInput);
}

export function parseAgentSessionFormResponseFor(
  request: AgentSessionFormRequest,
  input: unknown,
): AgentSessionFormResponse {
  const parsed = safeParseAgentSessionFormResponseFor(request, input);
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}

export function safeParseAgentSessionPlanReviewResponseFor(
  requestInput: unknown,
  responseInput: unknown,
): AgentProtocolParseResult<AgentSessionPlanReviewResponse> {
  return safeParseSessionResponseFor(AgentSessionPlanReviewRequestSchema, AgentSessionPlanReviewResponseSchema, requestInput, responseInput);
}

export function parseAgentSessionPlanReviewResponseFor(
  request: AgentSessionPlanReviewRequest,
  input: unknown,
): AgentSessionPlanReviewResponse {
  const parsed = safeParseAgentSessionPlanReviewResponseFor(request, input);
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}

export function safeParseAgentSessionResponseFor(
  requestInput: unknown,
  responseInput: unknown,
): AgentProtocolParseResult<AgentSessionResponse> {
  return safeParseSessionResponseFor(AgentSessionRequestSchema, AgentSessionResponseSchema, requestInput, responseInput);
}

export function parseAgentSessionResponseFor(
  request: AgentSessionRequest,
  input: unknown,
): AgentSessionResponse {
  const parsed = safeParseAgentSessionResponseFor(request, input);
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}
