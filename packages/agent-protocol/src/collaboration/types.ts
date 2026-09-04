// ------------------------------------------------------------------------------------------------
//                types.ts - Canonical collaboration lifecycle contracts - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentArtifactId,
  AgentCollaborationId,
  AgentError,
  AgentGeneratedResourceId,
  AgentIsoDateTime,
} from '../foundation/index.js';
import type { AgentTurnInputContent } from '../turns/index.js';

export const AGENT_COLLABORATION_ROLES = [
  'delegate',
  'reviewer',
  'researcher',
  'specialist',
] as const;
export const AGENT_COLLABORATION_STATUSES = [
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'failed',
  'canceled',
] as const;
export const AGENT_COLLABORATION_CONTROL_ACTIONS = [
  'spawn',
  'steer',
  'stop',
  'close',
  'inspect',
] as const;
export const AGENT_COLLABORATION_OUTCOMES = [
  'completed',
  'failed',
  'canceled',
] as const;
export const AGENT_COLLABORATION_STOP_REASONS = [
  'user_requested',
  'timeout',
  'shutdown',
  'superseded',
  'other',
] as const;
export const AGENT_COLLABORATION_USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
  'modelCalls',
] as const;
export const AGENT_COLLABORATION_TITLE_MAX_LENGTH = 200;
export const AGENT_COLLABORATION_OBJECTIVE_MAX_LENGTH = 4_000;
export const AGENT_COLLABORATION_PROGRESS_MAX_LENGTH = 2_000;
export const AGENT_COLLABORATION_RESULT_REFERENCES_MAX_LENGTH = 100;
export const AGENT_COLLABORATION_GRAPH_LIMITS = Object.freeze({
  maxNodes: 100,
  maxDepth: 16,
  maxChildrenPerNode: 100,
  maxActiveNodes: 100,
});

export type AgentCollaborationRole =
  (typeof AGENT_COLLABORATION_ROLES)[number];
export type AgentCollaborationStatus =
  (typeof AGENT_COLLABORATION_STATUSES)[number];
export type AgentCollaborationControlAction =
  (typeof AGENT_COLLABORATION_CONTROL_ACTIONS)[number];
export type AgentCollaborationOutcomeKind =
  (typeof AGENT_COLLABORATION_OUTCOMES)[number];
export type AgentCollaborationStopReason =
  (typeof AGENT_COLLABORATION_STOP_REASONS)[number];
export type AgentCollaborationUsageField =
  (typeof AGENT_COLLABORATION_USAGE_FIELDS)[number];

export type AgentCollaborationOutcome =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'failed'; error: AgentError }>
  | Readonly<{
      kind: 'canceled';
      reason: AgentCollaborationStopReason;
    }>;

export type AgentCollaborationUsage =
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{
      kind: 'reported';
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
      modelCalls?: number;
    }>;

export interface AgentCollaborationNode {
  readonly collaborationId: AgentCollaborationId;
  readonly rootCollaborationId: AgentCollaborationId;
  readonly parentCollaborationId?: AgentCollaborationId;
  readonly role: AgentCollaborationRole;
  readonly title: string;
  readonly status: AgentCollaborationStatus;
  readonly objective: string;
  readonly progress?: string;
  readonly usage: AgentCollaborationUsage;
  readonly outcome?: AgentCollaborationOutcome;
  readonly createdAt: AgentIsoDateTime;
  readonly updatedAt: AgentIsoDateTime;
  readonly terminalAt?: AgentIsoDateTime;
  readonly closedAt?: AgentIsoDateTime;
  readonly artifactIds?: readonly AgentArtifactId[];
  readonly resourceIds?: readonly AgentGeneratedResourceId[];
}

export interface AgentCollaborationSpawnInput {
  readonly collaborationId: AgentCollaborationId;
  readonly parentCollaborationId?: AgentCollaborationId;
  readonly role: AgentCollaborationRole;
  readonly title: string;
  readonly objective: string;
  readonly createdAt: AgentIsoDateTime;
}

export interface AgentCollaborationSteerInput extends AgentTurnInputContent {
  readonly action: 'steer';
  readonly collaborationId: AgentCollaborationId;
}

export interface AgentCollaborationStopInput {
  readonly action: 'stop';
  readonly collaborationId: AgentCollaborationId;
  readonly reason: AgentCollaborationStopReason;
}

export interface AgentCollaborationCloseInput {
  readonly action: 'close';
  readonly collaborationId: AgentCollaborationId;
}

export interface AgentCollaborationInspectInput {
  readonly action: 'inspect';
  readonly collaborationId: AgentCollaborationId;
}

export type AgentCollaborationControlInput =
  | AgentCollaborationSteerInput
  | AgentCollaborationStopInput
  | AgentCollaborationCloseInput
  | AgentCollaborationInspectInput;
