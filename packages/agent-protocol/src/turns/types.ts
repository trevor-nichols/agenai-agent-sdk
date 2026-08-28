// ------------------------------------------------------------------------------------------------
//                types.ts - Turn input and observation primitives - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentError,
  AgentIsoDateTime,
  AgentItemId,
  AgentTurnId,
} from '../foundation/index.js';

// ------------------------------------------------------------------------------------------------
//                Input Parts and Turn Operations
// ------------------------------------------------------------------------------------------------

export interface AgentTextInputPart {
  readonly type: 'text';
  readonly text: string;
}

export const AGENT_IMAGE_INPUT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export const AGENT_IMAGE_INPUT_SOURCE_KINDS = [
  'url',
  'base64',
  'local_file',
] as const;

export type AgentImageInputMediaType =
  (typeof AGENT_IMAGE_INPUT_MEDIA_TYPES)[number];
export type AgentImageInputSourceKind =
  (typeof AGENT_IMAGE_INPUT_SOURCE_KINDS)[number];

interface AgentImageInputSourceMetadata {
  readonly mediaType: AgentImageInputMediaType;
  readonly byteSize: number;
  readonly widthPixels: number;
  readonly heightPixels: number;
}

export type AgentImageInputSource =
  | Readonly<AgentImageInputSourceMetadata & {
      type: 'url';
      url: string;
    }>
  | Readonly<AgentImageInputSourceMetadata & {
      type: 'base64';
      data: string;
    }>
  | Readonly<AgentImageInputSourceMetadata & {
      type: 'local_file';
      path: string;
      sha256: string;
    }>;

export interface AgentImageInputPart {
  readonly type: 'image';
  readonly source: AgentImageInputSource;
}

export type AgentTurnInputPart = AgentTextInputPart | AgentImageInputPart;

export const AGENT_TURN_INTERACTION_MODES = ['default', 'plan'] as const;

export type AgentTurnInteractionMode =
  (typeof AGENT_TURN_INTERACTION_MODES)[number];

export interface AgentTurnInputContent {
  readonly parts: readonly AgentTurnInputPart[];
  readonly summary?: string;
}

export interface AgentTurnRunInput extends AgentTurnInputContent {
  readonly turnId: AgentTurnId;
  readonly interactionMode: AgentTurnInteractionMode;
  readonly deadlineAt?: AgentIsoDateTime;
}

export type AgentTurnInterruptionReason =
  | 'user_requested'
  | 'timeout'
  | 'shutdown'
  | 'superseded'
  | 'other';

export interface AgentTurnInterruptionInput {
  readonly turnId: AgentTurnId;
  readonly reason: AgentTurnInterruptionReason;
  readonly requestedAt?: AgentIsoDateTime;
}

// ------------------------------------------------------------------------------------------------
//                Turn and Item Observation Vocabulary
// ------------------------------------------------------------------------------------------------

export const AGENT_ITEM_KINDS = [
  'user_message',
  'assistant_message',
  'reasoning',
  'plan',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'dynamic_tool_call',
  'collaboration_tool_call',
  'web_search',
  'browser_action',
  'computer_action',
  'image_view',
  'review',
  'context_compaction',
  'unknown',
] as const;

export type AgentItemKind = (typeof AGENT_ITEM_KINDS)[number];

export const AGENT_ITEM_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'canceled',
  'unknown',
] as const;

export type AgentItemStatus = (typeof AGENT_ITEM_STATUSES)[number];

export const AGENT_CONTENT_STREAM_KINDS = [
  'assistant_text',
  'reasoning_text',
  'reasoning_summary',
  'plan_text',
  'command_output',
  'file_change_output',
  'unknown',
] as const;

export type AgentContentStreamKind =
  (typeof AGENT_CONTENT_STREAM_KINDS)[number];

export type AgentTurnState = 'running' | 'waiting_for_request';
export type AgentTurnOutcome = 'completed' | 'failed' | 'canceled' | 'expired';

export interface AgentItemSnapshotBase {
  readonly itemId: AgentItemId;
  readonly status: AgentItemStatus;
  readonly title?: string;
  readonly summary?: string;
}

export interface AgentUserMessageItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'user_message';
}

export interface AgentAssistantMessageItemSnapshot
  extends AgentItemSnapshotBase {
  readonly itemKind: 'assistant_message';
}

export interface AgentReasoningItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'reasoning';
}

export interface AgentPlanItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'plan';
}

export interface AgentContextCompactionItemSnapshot
  extends AgentItemSnapshotBase {
  readonly itemKind: 'context_compaction';
}

export interface AgentUnknownItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'unknown';
}

export interface AgentCommandExecutionDetails {
  readonly commandSummary?: string;
  readonly workingPath?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly truncated?: true;
}

export interface AgentCommandExecutionItemSnapshot
  extends AgentItemSnapshotBase {
  readonly itemKind: 'command_execution';
  readonly details?: AgentCommandExecutionDetails;
}

export const AGENT_FILE_CHANGE_KINDS = [
  'created',
  'modified',
  'deleted',
  'renamed',
  'unknown',
] as const;

export type AgentFileChangeKind = (typeof AGENT_FILE_CHANGE_KINDS)[number];

export interface AgentFileChange {
  readonly path: string;
  readonly changeKind: AgentFileChangeKind;
}

export interface AgentFileChangeDetails {
  readonly changes: readonly AgentFileChange[];
  readonly truncated?: true;
}

export interface AgentFileChangeItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'file_change';
  readonly details?: AgentFileChangeDetails;
}

export interface AgentMcpToolCallDetails {
  readonly serverName?: string;
  readonly toolName?: string;
  readonly actionSummary?: string;
  readonly durationMs?: number;
  readonly truncated?: true;
}

export interface AgentMcpToolCallItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'mcp_tool_call';
  readonly details?: AgentMcpToolCallDetails;
}

export interface AgentDynamicToolCallDetails {
  readonly toolName?: string;
  readonly actionSummary?: string;
  readonly durationMs?: number;
  readonly success?: boolean;
  readonly truncated?: true;
}

export interface AgentDynamicToolCallItemSnapshot
  extends AgentItemSnapshotBase {
  readonly itemKind: 'dynamic_tool_call';
  readonly details?: AgentDynamicToolCallDetails;
}

export interface AgentCollaborationToolCallDetails {
  readonly toolName?: string;
  readonly actionSummary?: string;
  readonly truncated?: true;
}

export interface AgentCollaborationToolCallItemSnapshot
  extends AgentItemSnapshotBase {
  readonly itemKind: 'collaboration_tool_call';
  readonly details?: AgentCollaborationToolCallDetails;
}

export interface AgentWebSearchDetails {
  readonly querySummary?: string;
  readonly actionSummary?: string;
  readonly truncated?: true;
}

export interface AgentWebSearchItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'web_search';
  readonly details?: AgentWebSearchDetails;
}

export interface AgentBrowserActionDetails {
  readonly actionSummary: string;
  readonly truncated?: true;
}

export interface AgentBrowserActionItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'browser_action';
  readonly details?: AgentBrowserActionDetails;
}

export interface AgentComputerActionDetails {
  readonly actionSummary: string;
  readonly truncated?: true;
}

export interface AgentComputerActionItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'computer_action';
  readonly details?: AgentComputerActionDetails;
}

export interface AgentImageViewDetails {
  readonly filePath?: string;
  readonly actionSummary?: string;
  readonly truncated?: true;
}

export interface AgentImageViewItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'image_view';
  readonly details?: AgentImageViewDetails;
}

export type AgentReviewDetails =
  | Readonly<{
      phase: 'entered';
      target: string;
      truncated?: true;
    }>
  | Readonly<{
      phase: 'exited';
      report: string;
      truncated?: true;
    }>;

export interface AgentReviewItemSnapshot extends AgentItemSnapshotBase {
  readonly itemKind: 'review';
  readonly details: AgentReviewDetails;
}

export type AgentItemSnapshot =
  | AgentUserMessageItemSnapshot
  | AgentAssistantMessageItemSnapshot
  | AgentReasoningItemSnapshot
  | AgentPlanItemSnapshot
  | AgentCommandExecutionItemSnapshot
  | AgentFileChangeItemSnapshot
  | AgentMcpToolCallItemSnapshot
  | AgentDynamicToolCallItemSnapshot
  | AgentCollaborationToolCallItemSnapshot
  | AgentWebSearchItemSnapshot
  | AgentBrowserActionItemSnapshot
  | AgentComputerActionItemSnapshot
  | AgentImageViewItemSnapshot
  | AgentReviewItemSnapshot
  | AgentContextCompactionItemSnapshot
  | AgentUnknownItemSnapshot;

export interface AgentPlanStep {
  readonly stepId: string;
  readonly text: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'canceled';
  readonly priority?: 'low' | 'medium' | 'high';
}

export interface AgentDiffSummary {
  readonly summary: string;
  readonly fileCount: number;
  readonly byteSize: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary?: boolean;
  readonly malformed?: boolean;
  readonly truncated?: boolean;
}

export interface AgentTurnCompletedPayload {
  readonly outcome: AgentTurnOutcome;
  readonly reason?: string;
  readonly error?: AgentError;
}
