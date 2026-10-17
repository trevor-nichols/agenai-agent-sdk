import type {
  AgentIsoDateTime,
  AgentRequestId,
  AgentSessionId,
} from '../foundation/index.js';
import type { AgentElicitationAnswer, AgentElicitationField } from '../requests/types.js';

declare const agentSessionDecisionChoiceIdBrand: unique symbol;
declare const agentSessionFormChoiceIdBrand: unique symbol;
declare const agentSessionPlanReviewChoiceIdBrand: unique symbol;
declare const agentSessionPlanIdBrand: unique symbol;
declare const agentSessionPlanRevisionBrand: unique symbol;

export type AgentSessionRequestKind = 'decision' | 'form' | 'plan_review';

export type AgentSessionDecisionChoiceId = string & {
  readonly [agentSessionDecisionChoiceIdBrand]: 'AgentSessionDecisionChoiceId';
};

export type AgentSessionFormChoiceId = string & {
  readonly [agentSessionFormChoiceIdBrand]: 'AgentSessionFormChoiceId';
};

export type AgentSessionPlanReviewChoiceId = string & {
  readonly [agentSessionPlanReviewChoiceIdBrand]: 'AgentSessionPlanReviewChoiceId';
};

export type AgentSessionPlanId = string & {
  readonly [agentSessionPlanIdBrand]: 'AgentSessionPlanId';
};

export type AgentSessionPlanRevision = string & {
  readonly [agentSessionPlanRevisionBrand]: 'AgentSessionPlanRevision';
};

export interface AgentSessionWorkspaceTarget {
  readonly kind: 'workspace';
  readonly path: string;
}

export type AgentSessionDecisionConsequence =
  | Readonly<{
    kind: 'grant';
    scope: 'workspace';
    persistence: Readonly<{
      kind: 'provider_managed';
      duration: 'persistent';
      mayAffectOtherSessions: true;
    }>;
  }>
  | Readonly<{
    kind: 'decline';
    configuration: 'remains_gated';
  }>;

export interface AgentSessionDecisionChoice {
  readonly choiceId: AgentSessionDecisionChoiceId;
  readonly label: string;
  readonly description: string;
  readonly consequence: AgentSessionDecisionConsequence;
}

export interface AgentSessionDecisionRequest {
  readonly kind: 'decision';
  readonly requestId: AgentRequestId;
  readonly sessionId: AgentSessionId;
  readonly title: string;
  readonly description?: string;
  readonly target: AgentSessionWorkspaceTarget;
  readonly expiresAt?: AgentIsoDateTime;
  readonly choices: readonly [AgentSessionDecisionChoice, ...AgentSessionDecisionChoice[]];
}

export interface AgentSessionDecisionResponse {
  readonly kind: 'decision';
  readonly choiceId: AgentSessionDecisionChoiceId;
}

export type AgentSessionFormChoice =
  | Readonly<{
    choiceId: AgentSessionFormChoiceId;
    action: 'submit';
    label: string;
    description?: string;
  }>
  | Readonly<{
    choiceId: AgentSessionFormChoiceId;
    action: 'cancel';
    label: string;
    description?: string;
  }>;

export interface AgentSessionFormRequest {
  readonly kind: 'form';
  readonly requestId: AgentRequestId;
  readonly sessionId: AgentSessionId;
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly [AgentElicitationField, ...AgentElicitationField[]];
  readonly choices: readonly [AgentSessionFormChoice, ...AgentSessionFormChoice[]];
  readonly expiresAt?: AgentIsoDateTime;
}

export type AgentSessionPlanReviewAction = 'approve' | 'revise' | 'abandon';

export interface AgentSessionPlanSnapshot {
  readonly planId: AgentSessionPlanId;
  readonly revision: AgentSessionPlanRevision;
  readonly title: string;
  readonly content: Readonly<{
    kind: 'text';
    format: 'plain_text' | 'markdown';
    text: string;
  }>;
}

export interface AgentSessionPlanReviewChoice {
  readonly choiceId: AgentSessionPlanReviewChoiceId;
  readonly action: AgentSessionPlanReviewAction;
  readonly label: string;
  readonly description?: string;
}

export interface AgentSessionPlanReviewRequest {
  readonly kind: 'plan_review';
  readonly requestId: AgentRequestId;
  readonly sessionId: AgentSessionId;
  readonly title: string;
  readonly description?: string;
  readonly plan: AgentSessionPlanSnapshot;
  readonly choices: readonly [AgentSessionPlanReviewChoice, ...AgentSessionPlanReviewChoice[]];
  readonly expiresAt?: AgentIsoDateTime;
}

export type AgentSessionRequest =
  | AgentSessionDecisionRequest
  | AgentSessionFormRequest
  | AgentSessionPlanReviewRequest;

export type AgentSessionFormResponse =
  | Readonly<{
    kind: 'form';
    action: 'submit';
    choiceId: AgentSessionFormChoiceId;
    answers: readonly AgentElicitationAnswer[];
  }>
  | Readonly<{
    kind: 'form';
    action: 'cancel';
    choiceId: AgentSessionFormChoiceId;
  }>;

export type AgentSessionPlanReviewResponse =
  | Readonly<{
    kind: 'plan_review';
    action: 'approve' | 'abandon';
    choiceId: AgentSessionPlanReviewChoiceId;
    planId: AgentSessionPlanId;
    revision: AgentSessionPlanRevision;
  }>
  | Readonly<{
    kind: 'plan_review';
    action: 'revise';
    choiceId: AgentSessionPlanReviewChoiceId;
    planId: AgentSessionPlanId;
    revision: AgentSessionPlanRevision;
    feedback: string;
  }>;

export type AgentSessionResponse =
  | AgentSessionDecisionResponse
  | AgentSessionFormResponse
  | AgentSessionPlanReviewResponse;

export type AgentSessionAcceptedResponse =
  | AgentSessionDecisionResponse
  | Readonly<{
    kind: 'form';
    action: 'submit' | 'cancel';
    choiceId: AgentSessionFormChoiceId;
  }>
  | Readonly<{
    kind: 'plan_review';
    action: AgentSessionPlanReviewAction;
    choiceId: AgentSessionPlanReviewChoiceId;
    planId: AgentSessionPlanId;
    revision: AgentSessionPlanRevision;
  }>;

export const AGENT_SESSION_REQUEST_BYTES_LIMIT = 65_536;
export const AGENT_SESSION_DECISION_REQUEST_BYTES_LIMIT = AGENT_SESSION_REQUEST_BYTES_LIMIT;
export const AGENT_SESSION_DECISION_RESPONSE_BYTES_LIMIT = 1_024;
export const AGENT_SESSION_FORM_RESPONSE_BYTES_LIMIT = 65_536;
export const AGENT_SESSION_PLAN_REVIEW_RESPONSE_BYTES_LIMIT = 65_536;
export const AGENT_SESSION_PLAN_TEXT_BYTES_LIMIT = 49_152;
export const AGENT_SESSION_PLAN_ID_BYTES_LIMIT = 128;
export const AGENT_SESSION_PLAN_REVISION_BYTES_LIMIT = 128;
export const AGENT_SESSION_PLAN_REVIEW_FEEDBACK_MAX_LENGTH = 4_000;
export const AGENT_SESSION_PLAN_REVIEW_FEEDBACK_BYTES_LIMIT = 16_384;
export const AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH = 16;
export const AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT = 128;
export const AGENT_SESSION_DECISION_TITLE_MAX_LENGTH = 120;
export const AGENT_SESSION_DECISION_DESCRIPTION_MAX_LENGTH = 4_000;
export const AGENT_SESSION_DECISION_CHOICE_DESCRIPTION_MAX_LENGTH = 1_000;
export const AGENT_SESSION_DECISION_WORKSPACE_PATH_BYTES_LIMIT = 4_096;
