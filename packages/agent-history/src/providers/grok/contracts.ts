import type { AgentHistoryMutationOperation } from '../../contracts/index.js';
import type { AgentHistoryLimits } from '../../lifecycle/limits.js';
import type { AcpHistoryRequestOptions } from '../acp/contracts.js';

export type GrokHistoryListParams = Readonly<{
  readonly cwd: string;
  readonly cursor?: string;
  readonly _meta: Readonly<{ 'x.ai/limit': number; 'x.ai/query'?: string; 'x.ai/facetFilters': Readonly<{ kind: 'build' }> }>;
}>;
export type GrokHistorySessionParams = Readonly<{ sessionId: string; cwd: string }>;
export type GrokHistoryUpdatesParams = GrokHistorySessionParams & Readonly<{ offset: number; limit: 1 }>;
export type GrokHistorySearchParams = Readonly<{ query: string; cwd: string; limit: number; offset: number;
  includeContent: true; headless: 'exclude' }>;
export type GrokHistoryRenameParams = GrokHistorySessionParams & Readonly<{ title: string; kind: 'build' }>;
export type GrokHistoryDeleteParams = GrokHistorySessionParams & Readonly<{ kind: 'build' }>;

/** An initialized exact Grok connection; the caller owns native work and bounded transport ingress. */
export interface GrokHistoryConnection {
  readonly protocolProfile: 'schema-v1.23.0';
  readonly runtimeVersion: '1.0.62';
  readonly initialization: unknown;
  readonly resources: Readonly<{ kind: 'caller_owned'; maxInboundFrameBytes: number }>;
  listSessions(params: GrokHistoryListParams, options: AcpHistoryRequestOptions): Promise<unknown>;
  sessionState(params: GrokHistorySessionParams, options: AcpHistoryRequestOptions): Promise<unknown>;
  sessionUpdates(params: GrokHistoryUpdatesParams, options: AcpHistoryRequestOptions): Promise<unknown>;
  sessionSearch?(params: GrokHistorySearchParams, options: AcpHistoryRequestOptions): Promise<unknown>;
}

export interface GrokHistoryOptions {
  readonly sourceId: string;
  readonly generation: string;
  readonly scope: Readonly<{ kind: 'project'; projectPath: string; worktrees: 'excluded' }>;
  readonly limits?: Partial<AgentHistoryLimits>;
  readonly management?: readonly AgentHistoryMutationOperation[];
}
export interface CreateGrokHistoryOptions extends GrokHistoryOptions {
  readonly connection: GrokHistoryConnection;
}
export interface CreateGrokHistoryProcessOptions extends GrokHistoryOptions {
  readonly executable: string;
  readonly nativeHome: string;
  /** The caller prevents other processes from using these saved sessions during management. */
  readonly localManagement?: Readonly<{ kind: 'caller_quiescent' }>;
  readonly resources: Readonly<{
    kind: 'linux-prlimit-bubblewrap'; resourceLauncher: string; sandboxLauncher: string; temporaryRoot: string;
  }>;
}
export interface GrokHistoryExtensionDefinition {
  readonly method: '_x.ai/session/state' | '_x.ai/session/updates' | '_x.ai/session/search' | '_x.ai/session/rename' | '_x.ai/session/delete';
  readonly direction: 'outbound_request';
  readonly validateParams: (value: unknown) => boolean;
  readonly validateResult: (value: unknown) => boolean;
}

export interface GrokHistoryAccess {
  run<T>(operation: (connection: GrokHistoryConnection) => Promise<T>, signal: AbortSignal, mode?: 'read' | 'content-search'): Promise<T>;
}

export interface GrokManagementConnection {
  sessionRename(params: GrokHistoryRenameParams, options: AcpHistoryRequestOptions): Promise<unknown>;
  sessionDelete(params: GrokHistoryDeleteParams, options: AcpHistoryRequestOptions): Promise<unknown>;
}
export interface GrokManagementAccess {
  mutate<T>(operation: (connection: GrokManagementConnection) => Promise<T>, signal: AbortSignal): Promise<T>;
}
