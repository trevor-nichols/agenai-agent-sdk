import type {
  AgentHistoryCatalogPage, AgentHistoryConversationRef, AgentHistoryConversationSummary,
  AgentHistorySearchPage, AgentHistorySource, AgentHistoryTranscriptPage, AgentHistoryTranscriptView,
  AgentHistoryNamedTranscriptView, AgentHistoryViewPage,
} from './records.js';

export interface AgentHistoryOperationOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}
export interface AgentHistoryDriverContext {
  readonly signal: AbortSignal;
  readonly markDispatched: () => void;
}
export interface AgentHistoryMutationDriverContext extends AgentHistoryDriverContext {
  /** Record one observed native receipt before optional follow-up work or owned cleanup. */
  readonly recordReceipt: (result: AgentHistoryMutationResult) => void;
}
export type AgentHistoryMethod<Input, Output> = (input: Input, options?: AgentHistoryOperationOptions) => Promise<Output>;
export type AgentHistoryDriverMethod<Input, Output> = (input: Input, context: AgentHistoryDriverContext) => Promise<Output>;
export type AgentHistoryMutationDriverMethod<Input> = (input: Input, context: AgentHistoryMutationDriverContext) => Promise<AgentHistoryMutationResult>;

export interface AgentHistoryUnsupportedReason {
  readonly code: 'native_unavailable' | 'unqualified' | 'scope_excluded' | 'management_disabled' | 'resource_policy_required';
  readonly message: string;
}
export type AgentHistoryPort<Descriptor, Methods> =
  | Readonly<{ status: 'unsupported'; reason: AgentHistoryUnsupportedReason }>
  | (Readonly<{ status: 'supported'; descriptor: Descriptor }> & Readonly<Methods>);

export type AgentHistoryCatalogFilter = 'projectPath' | 'archived' | 'parent' | 'sourceKinds';
export type AgentHistoryOrder = 'native' | 'updated_asc' | 'updated_desc' | 'created_asc' | 'created_desc';
export interface AgentHistoryListInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly projectPath?: string;
  readonly archived?: 'exclude' | 'include' | 'only';
  readonly order?: AgentHistoryOrder;
  readonly parent?: AgentHistoryConversationRef;
  readonly sourceKinds?: readonly string[];
}
export interface AgentHistoryLookupInput { readonly conversation: AgentHistoryConversationRef }
export interface AgentHistoryReadInput extends AgentHistoryLookupInput {
  readonly view?: AgentHistoryTranscriptView;
  readonly cursor?: string;
  readonly limit?: number;
}
export interface AgentHistoryViewListInput extends AgentHistoryLookupInput {
  readonly kind: AgentHistoryNamedTranscriptView['kind'];
  readonly cursor?: string;
  readonly limit?: number;
}
export interface AgentHistoryViewDescriptor {
  readonly kinds: readonly AgentHistoryNamedTranscriptView['kind'][];
  readonly pagination: 'offset' | 'cursor' | 'none';
}
export interface AgentHistorySearchInput extends AgentHistoryListInput { readonly query: string }
export interface AgentHistoryCatalogDescriptor {
  readonly filters: readonly AgentHistoryCatalogFilter[];
  readonly orders: readonly AgentHistoryOrder[];
  readonly pagination: 'offset' | 'cursor' | 'none';
}
export interface AgentHistoryLookupDescriptor { readonly semantics: 'native_lookup' }
export interface AgentHistoryTranscriptDescriptor {
  readonly views: readonly AgentHistoryTranscriptView['kind'][];
  readonly pagination: 'offset' | 'cursor' | 'none';
}
export interface AgentHistorySearchDescriptor {
  readonly syntax: 'literal' | 'sql_like' | 'fts' | 'provider_defined';
  readonly caseSensitivity: 'sensitive' | 'insensitive' | 'provider_defined';
  readonly ranking: 'none' | 'native' | 'chronological';
  readonly scope: 'title' | 'metadata' | 'transcript';
  readonly filters: readonly AgentHistoryCatalogFilter[];
  readonly orders: readonly AgentHistoryOrder[];
}

export interface AgentHistoryMutationEffects {
  readonly scope: 'local' | 'remote' | 'local_and_remote' | 'provider_managed';
  readonly descendants: 'none' | 'subagents' | 'descendants' | 'unknown';
  readonly active: 'native_rejects' | 'requires_quiescent' | 'unknown';
  readonly atomicity: 'atomic' | 'non_atomic' | 'unknown';
}
export interface AgentHistoryMutationDescriptor { readonly effects: AgentHistoryMutationEffects }
export interface AgentHistoryMutationInput extends AgentHistoryLookupInput { readonly acceptEffects: AgentHistoryMutationEffects }
export interface AgentHistoryRenameInput extends AgentHistoryMutationInput { readonly title: string }
export type AgentHistoryMutationOperation = 'rename' | 'archive' | 'restore' | 'delete';
export interface AgentHistoryMutationReason { readonly code: string; readonly message: string }
export type AgentHistoryMutationResult =
  | Readonly<{ status: 'applied'; ref: AgentHistoryConversationRef }>
  | Readonly<{ status: 'not_applied'; ref: AgentHistoryConversationRef; reason: AgentHistoryMutationReason }>
  | Readonly<{ status: 'outcome_unknown'; ref: AgentHistoryConversationRef; reason: AgentHistoryMutationReason }>;

export interface AgentHistoryPorts {
  readonly catalog: AgentHistoryPort<AgentHistoryCatalogDescriptor, { list: AgentHistoryMethod<AgentHistoryListInput, AgentHistoryCatalogPage> }>;
  readonly lookup: AgentHistoryPort<AgentHistoryLookupDescriptor, { get: AgentHistoryMethod<AgentHistoryLookupInput, AgentHistoryConversationSummary> }>;
  readonly transcript: AgentHistoryPort<AgentHistoryTranscriptDescriptor, { read: AgentHistoryMethod<AgentHistoryReadInput, AgentHistoryTranscriptPage> }>;
  readonly views: AgentHistoryPort<AgentHistoryViewDescriptor, { list: AgentHistoryMethod<AgentHistoryViewListInput, AgentHistoryViewPage> }>;
  readonly metadataSearch: AgentHistoryPort<AgentHistorySearchDescriptor, { search: AgentHistoryMethod<AgentHistorySearchInput, AgentHistorySearchPage> }>;
  readonly contentSearch: AgentHistoryPort<AgentHistorySearchDescriptor, { search: AgentHistoryMethod<AgentHistorySearchInput, AgentHistorySearchPage> }>;
  readonly rename: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMethod<AgentHistoryRenameInput, AgentHistoryMutationResult> }>;
  readonly archive: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMethod<AgentHistoryMutationInput, AgentHistoryMutationResult> }>;
  readonly restore: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMethod<AgentHistoryMutationInput, AgentHistoryMutationResult> }>;
  readonly delete: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMethod<AgentHistoryMutationInput, AgentHistoryMutationResult> }>;
}

export interface AgentHistoryDriverPorts {
  readonly catalog: AgentHistoryPort<AgentHistoryCatalogDescriptor, { list: AgentHistoryDriverMethod<AgentHistoryListInput, AgentHistoryCatalogPage> }>;
  readonly lookup: AgentHistoryPort<AgentHistoryLookupDescriptor, { get: AgentHistoryDriverMethod<AgentHistoryLookupInput, AgentHistoryConversationSummary> }>;
  readonly transcript: AgentHistoryPort<AgentHistoryTranscriptDescriptor, { read: AgentHistoryDriverMethod<AgentHistoryReadInput, AgentHistoryTranscriptPage> }>;
  readonly views: AgentHistoryPort<AgentHistoryViewDescriptor, { list: AgentHistoryDriverMethod<AgentHistoryViewListInput, AgentHistoryViewPage> }>;
  readonly metadataSearch: AgentHistoryPort<AgentHistorySearchDescriptor, { search: AgentHistoryDriverMethod<AgentHistorySearchInput, AgentHistorySearchPage> }>;
  readonly contentSearch: AgentHistoryPort<AgentHistorySearchDescriptor, { search: AgentHistoryDriverMethod<AgentHistorySearchInput, AgentHistorySearchPage> }>;
  readonly rename: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMutationDriverMethod<AgentHistoryRenameInput> }>;
  readonly archive: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMutationDriverMethod<AgentHistoryMutationInput> }>;
  readonly restore: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMutationDriverMethod<AgentHistoryMutationInput> }>;
  readonly delete: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMutationDriverMethod<AgentHistoryMutationInput> }>;
}
export interface AgentHistoryDriver extends AgentHistoryDriverPorts {
  readonly dispose?: () => Promise<void>;
}
export interface AgentHistory extends AgentHistoryPorts {
  readonly source: AgentHistorySource;
  close(): Promise<void>;
}
