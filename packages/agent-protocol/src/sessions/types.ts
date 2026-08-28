// ------------------------------------------------------------------------------------------------
//                types.ts - Provider-neutral session semantics - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentConfigurationRevisionId,
  AgentJsonValue,
  AgentProviderConversationId,
  AgentProviderHistoryAnchor,
  AgentSessionId,
  AgentTurnId,
} from '../foundation/index.js';

// ------------------------------------------------------------------------------------------------
//                Binding and Effective Configuration
// ------------------------------------------------------------------------------------------------

export interface AgentSessionBinding {
  readonly conversationId: AgentProviderConversationId;
  readonly historyAnchor?: AgentProviderHistoryAnchor;
}

export interface AgentSessionConfiguration {
  readonly revision: AgentConfigurationRevisionId;
  readonly values: Readonly<Record<string, AgentJsonValue>>;
}

// ------------------------------------------------------------------------------------------------
//                Session Open Semantics
// ------------------------------------------------------------------------------------------------

export interface AgentSessionCreateInput {
  readonly operation: 'create';
  readonly sessionId: AgentSessionId;
  readonly configuration: AgentSessionConfiguration;
}

export interface AgentSessionResumeInput {
  readonly operation: 'resume';
  readonly sessionId: AgentSessionId;
  readonly binding: AgentSessionBinding;
  readonly configuration: AgentSessionConfiguration;
}

export interface AgentSessionBranchSource {
  readonly sessionId: AgentSessionId;
  readonly binding: AgentSessionBinding;
  readonly throughTurn: Readonly<{
    turnId: AgentTurnId;
    historyAnchor: AgentProviderHistoryAnchor;
  }>;
}

export interface AgentSessionBranchInput {
  readonly operation: 'branch';
  readonly sessionId: AgentSessionId;
  readonly source: AgentSessionBranchSource;
  readonly configuration: AgentSessionConfiguration;
}

export type AgentSessionOpenInput =
  | AgentSessionCreateInput
  | AgentSessionResumeInput
  | AgentSessionBranchInput;

export type AgentSessionOpenDisposition = 'created' | 'resumed' | 'branched';
