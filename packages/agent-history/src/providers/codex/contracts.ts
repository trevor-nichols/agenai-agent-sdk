import type { AgentHistoryLimits } from '../../lifecycle/limits.js';
import type { AgentHistoryMutationOperation } from '../../contracts/index.js';

export type CodexHistorySourceKind = 'cli' | 'vscode' | 'exec' | 'appServer' | 'subAgent'
  | 'subAgentReview' | 'subAgentCompact' | 'subAgentThreadSpawn' | 'subAgentOther' | 'unknown';
export type CodexHistoryScope = Readonly<{ kind: 'project'; projectPath: string; worktrees: 'excluded' }>
  | Readonly<{ kind: 'all_projects' }>;
export type CodexHistoryCatalogPolicy = 'scan_and_repair' | 'state_db_only';

export type CodexHistoryRequest =
  | Readonly<{ method: 'thread/list'; params: Readonly<{
    cursor?: string; limit: number; sortKey: 'created_at' | 'updated_at'; sortDirection: 'asc' | 'desc';
    modelProviders: readonly string[]; sourceKinds: readonly CodexHistorySourceKind[];
    archived: boolean; cwd?: string; useStateDbOnly: boolean; searchTerm?: string;
  }> }>
  | Readonly<{ method: 'thread/read'; params: Readonly<{ threadId: string; includeTurns: false }> }>
  | Readonly<{ method: 'thread/turns/list'; params: Readonly<{
    threadId: string; cursor?: string; limit: number; sortDirection: 'asc'; itemsView: 'full';
  }> }>
  | Readonly<{ method: 'thread/items/list'; params: Readonly<{
    threadId: string; cursor?: string; limit: number; sortDirection: 'asc';
  }> }>
  | Readonly<{ method: 'thread/name/set'; params: Readonly<{ threadId: string; name: string }> }>
  | Readonly<{ method: 'thread/archive' | 'thread/unarchive' | 'thread/delete'; params: Readonly<{ threadId: string }> }>;

export interface CodexHistoryRequestContext {
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
}

/** An initialized local app-server port. The host owns correlation, ingress and native workload limits. */
export interface CodexHistoryConnection {
  readonly runtimeVersion: '0.163.0';
  /** Return one correlated JSON-RPC response as UTF-8 bytes, including its result or error envelope. */
  request(request: CodexHistoryRequest, context: CodexHistoryRequestContext): Promise<Uint8Array>;
}

export interface CodexHistoryOptions {
  readonly sourceId: string;
  readonly generation: string;
  readonly scope: CodexHistoryScope;
  readonly catalogPolicy: CodexHistoryCatalogPolicy;
  readonly sourceKinds?: readonly CodexHistorySourceKind[];
  readonly limits?: Partial<AgentHistoryLimits>;
  readonly management?: readonly AgentHistoryMutationOperation[];
}

export interface CreateCodexHistoryOptions extends CodexHistoryOptions {
  readonly connection: CodexHistoryConnection;
  readonly resources: Readonly<{ kind: 'caller_owned' }>;
}

export interface CreateCodexHistoryProcessOptions extends CodexHistoryOptions {
  readonly executable: string;
  readonly configHome: string;
  readonly resources: Readonly<{
    kind: 'linux-prlimit-bubblewrap';
    resourceLauncher: string;
    sandboxLauncher: string;
    temporaryRoot: string;
  }>;
}

export interface CodexHistoryMappingOptions {
  readonly catalogPolicy: CodexHistoryCatalogPolicy;
  readonly sourceKinds: readonly CodexHistorySourceKind[];
  readonly pageBytes: number;
}

export interface CodexHistoryAccess {
  run<T>(operation: (connection: CodexHistoryConnection) => Promise<T>, signal: AbortSignal): Promise<T>;
}
