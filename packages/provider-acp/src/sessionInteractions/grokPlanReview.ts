import { parseAgentProviderConversationId, parseAgentSessionPlanReviewRequest,
  type AgentProviderConversationId, type AgentSessionId, type AgentSessionPlanReviewRequest,
  type AgentSessionPlanReviewResponse } from '@agen-ai/agent-protocol';
import type { AcpJsonValue } from '@agen-ai/acp-transport';
import { AcpProviderSessionError } from '../session/errors.js';

export const GROK_PLAN_REVIEW_METHOD = '_x.ai/exit_plan_mode';
export const GROK_QUEUE_METHOD = '_x.ai/queue/changed';
export const GROK_SESSION_NOTIFICATION_METHOD = '_x.ai/session_notification';

export interface NativePlanReviewRequest {
  readonly sessionId: AgentProviderConversationId;
  readonly toolCallId: string;
  readonly planContent: string;
}

export function parseNativePlanReviewRequest(input: unknown): NativePlanReviewRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Reflect.ownKeys(input).length !== 3 || !('sessionId' in input) || !('toolCallId' in input) || !('planContent' in input)
    || typeof input.sessionId !== 'string' || Buffer.byteLength(input.sessionId, 'utf8') > 256
    || typeof input.toolCallId !== 'string' || !input.toolCallId || Buffer.byteLength(input.toolCallId, 'utf8') > 256
    || typeof input.planContent !== 'string' || !input.planContent || Buffer.byteLength(input.planContent, 'utf8') > 65_536) {
    throw new AcpProviderSessionError('acp_session_interaction_invalid', 'The native plan review violates the selected mapping.');
  }
  return Object.freeze({ sessionId: parseAgentProviderConversationId(input.sessionId),
    toolCallId: input.toolCallId, planContent: input.planContent });
}

export function validateNativePlanReviewRequest(input: unknown): boolean {
  try { parseNativePlanReviewRequest(input); return true; } catch { return false; }
}

export function validateNativePlanReviewResult(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !('outcome' in input)) return false;
  return input.outcome === 'cancelled'
    ? Reflect.ownKeys(input).length === 2 && 'feedback' in input && typeof input.feedback === 'string'
      && Buffer.byteLength(input.feedback, 'utf8') <= 16_384
    : Reflect.ownKeys(input).length === 1 && (input.outcome === 'approved' || input.outcome === 'abandoned');
}

export function planReviewRequest(native: NativePlanReviewRequest, sessionId: AgentSessionId, requestNumber: number): AgentSessionPlanReviewRequest {
  return parseAgentSessionPlanReviewRequest({ kind: 'plan_review', requestId: `session-interaction:${requestNumber}`, sessionId,
    title: 'Review the restored plan',
    plan: { planId: `session-plan:${requestNumber}`, revision: '1', title: 'Restored plan',
      content: { kind: 'text', format: 'markdown', text: native.planContent } },
    choices: [{ choiceId: 'approve', action: 'approve', label: 'Approve plan' },
      { choiceId: 'revise', action: 'revise', label: 'Revise plan' },
      { choiceId: 'abandon', action: 'abandon', label: 'Abandon plan' }],
  });
}

export function nativePlanReviewReply(response: AgentSessionPlanReviewResponse): AcpJsonValue {
  if (response.action === 'revise') return Object.freeze({ outcome: 'cancelled', feedback: response.feedback });
  return Object.freeze({ outcome: response.action === 'approve' ? 'approved' : 'abandoned' });
}
