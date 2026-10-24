import type {
  AgentIsoDateTime, AgentJsonValue, AgentProviderConversationId,
  AgentProviderHistoryAnchor, AgentProviderItemRef, AgentProviderKey, AgentProviderTurnRef,
} from '@agen-ai/agent-protocol';

export interface AgentHistorySourceIdentity {
  readonly providerKey: AgentProviderKey;
  readonly sourceId: string;
  readonly generation: string;
}

export type AgentHistoryScope =
  | Readonly<{ kind: 'project'; projectPath: string; worktrees: 'included' | 'excluded' }>
  | Readonly<{ kind: 'all_projects' }>
  | Readonly<{ kind: 'account'; label?: string }>
  | Readonly<{ kind: 'provider_defined'; description: string }>;

export type AgentHistoryStorageEffect = 'initializes_store' | 'migrates_store' | 'updates_index' | 'updates_auxiliary_files';
export type AgentHistoryStorageEffects =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'possible'; effects: readonly [AgentHistoryStorageEffect, ...AgentHistoryStorageEffect[]] }>
  | Readonly<{ kind: 'unknown'; reason: string }>;

export interface AgentHistorySource extends AgentHistorySourceIdentity {
  readonly kind: string;
  readonly scope: AgentHistoryScope;
  readonly storageEffects: AgentHistoryStorageEffects;
  readonly resourceOwnership: 'owned' | 'borrowed';
}

export interface AgentHistoryConversationRef {
  readonly source: AgentHistorySourceIdentity;
  readonly conversationId: AgentProviderConversationId;
}

export interface AgentHistoryConversationSummary {
  readonly ref: AgentHistoryConversationRef;
  readonly title?: string;
  readonly createdAt?: AgentIsoDateTime;
  readonly updatedAt?: AgentIsoDateTime;
  readonly projectPath?: string;
  readonly model?: string;
  readonly parent?: AgentHistoryConversationRef;
  readonly archiveState: 'archived' | 'not_archived' | 'unknown';
}

export interface AgentHistoryNativeReferences {
  readonly turnId?: AgentProviderTurnRef;
  readonly itemId?: AgentProviderItemRef;
  readonly historyAnchor?: AgentProviderHistoryAnchor;
}

export type AgentHistoryAttachmentReference =
  | Readonly<{ kind: 'uri'; uri: string }>
  | Readonly<{ kind: 'native'; id: string }>;

export type AgentHistoryOmission = 'compacted' | 'deleted' | 'unsupported_record_kind' | 'unsupported_content'
  | 'subagents_excluded' | 'native_retention' | 'resource_limit' | 'provider_omission';

export type AgentHistoryContent =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'thinking'; text: string }>
  | Readonly<{ kind: 'attachment'; attachmentKind: 'image' | 'file' | 'document' | 'unknown'; reference: AgentHistoryAttachmentReference; name?: string; mediaType?: string }>
  | Readonly<{ kind: 'omission'; reason: AgentHistoryOmission; detail: string }>;

interface AgentHistoryRecordBase {
  readonly native?: AgentHistoryNativeReferences;
  readonly timestamp?: AgentIsoDateTime;
}

export type AgentHistoryRecord = AgentHistoryRecordBase & (
  | Readonly<{ kind: 'message'; role: 'user' | 'assistant' | 'system' | 'developer'; content: readonly AgentHistoryContent[] }>
  | Readonly<{ kind: 'tool_call'; callId?: string; name: string; arguments?: AgentJsonValue }>
  | Readonly<{ kind: 'tool_result'; callId?: string; outcome: 'succeeded' | 'failed' | 'unknown'; content: readonly AgentHistoryContent[] }>
  | Readonly<{ kind: 'notice'; code: string; message: string }>
  | Readonly<{ kind: 'compaction'; summary?: string }>
);

export type AgentHistoryConsistency = 'live' | 'snapshot';
export type AgentHistoryCoverageView = 'catalog' | 'retained_chain' | 'current_checkpoint' | 'stored_updates' | 'retained_archive';
export interface AgentHistoryCoverage {
  readonly view: AgentHistoryCoverageView;
  readonly children: 'included' | 'excluded' | 'unknown';
  readonly omissions: readonly AgentHistoryOmission[];
}

export interface AgentHistoryPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
  readonly observedAt: AgentIsoDateTime;
  readonly consistency: AgentHistoryConsistency;
  readonly coverage: AgentHistoryCoverage;
}

export type AgentHistoryCatalogPage = AgentHistoryPage<AgentHistoryConversationSummary>;
export type AgentHistoryTranscriptPage = AgentHistoryPage<AgentHistoryRecord>;
export interface AgentHistorySearchHit {
  readonly conversation: AgentHistoryConversationSummary;
  readonly snippet?: string;
  readonly native?: AgentHistoryNativeReferences;
  readonly score?: number;
  readonly matchedFields?: readonly ('title' | 'transcript' | 'conversation_id')[];
}
export interface AgentHistorySearchPage extends AgentHistoryPage<AgentHistorySearchHit> {
  readonly totalEstimate?: number;
}

export type AgentHistoryTranscriptView =
  | Readonly<{ kind: 'main' }>
  | Readonly<{ kind: 'subagent'; id: string }>
  | Readonly<{ kind: 'run'; id: string }>;

export type AgentHistoryNamedTranscriptView = Exclude<AgentHistoryTranscriptView, Readonly<{ kind: 'main' }>>;
export interface AgentHistoryViewSummary {
  readonly view: AgentHistoryNamedTranscriptView;
  readonly title?: string;
  readonly createdAt?: AgentIsoDateTime;
  readonly updatedAt?: AgentIsoDateTime;
}
export type AgentHistoryViewPage = AgentHistoryPage<AgentHistoryViewSummary>;
