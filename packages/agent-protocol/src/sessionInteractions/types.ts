import type {
  AgentIsoDateTime,
  AgentRequestId,
  AgentSessionId,
} from '../foundation/index.js';

declare const agentSessionDecisionChoiceIdBrand: unique symbol;

export type AgentSessionDecisionChoiceId = string & {
  readonly [agentSessionDecisionChoiceIdBrand]: 'AgentSessionDecisionChoiceId';
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
  readonly expiresAt: AgentIsoDateTime;
  readonly choices: readonly [AgentSessionDecisionChoice, ...AgentSessionDecisionChoice[]];
}

export interface AgentSessionDecisionResponse {
  readonly choiceId: AgentSessionDecisionChoiceId;
}

export const AGENT_SESSION_DECISION_REQUEST_BYTES_LIMIT = 65_536;
export const AGENT_SESSION_DECISION_RESPONSE_BYTES_LIMIT = 1_024;
export const AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH = 16;
export const AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT = 128;
export const AGENT_SESSION_DECISION_TITLE_MAX_LENGTH = 120;
export const AGENT_SESSION_DECISION_DESCRIPTION_MAX_LENGTH = 4_000;
export const AGENT_SESSION_DECISION_CHOICE_DESCRIPTION_MAX_LENGTH = 1_000;
export const AGENT_SESSION_DECISION_WORKSPACE_PATH_BYTES_LIMIT = 4_096;
