import type { AgentProviderKey } from '@agen-ai/agent-protocol';
import type { AgentHistoryLimits } from '../../lifecycle/limits.js';

export type AcpHistoryScope =
  | Readonly<{ kind: 'project'; projectPath: string; worktrees: 'excluded' }>
  | Readonly<{ kind: 'all_projects' }>;

export type AcpHistoryListParams = Readonly<{
  readonly cwd?: string;
  readonly cursor?: string;
}>;

export interface AcpHistoryRequestOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/** The caller supplies the actual initialize response and owns transport ingress and native work. */
export interface AcpHistoryConnection {
  readonly protocolProfile: 'schema-v1.23.0';
  readonly initialization: unknown;
  readonly resources: Readonly<{ kind: 'caller_owned'; maxInboundFrameBytes: number }>;
  listSessions(params: AcpHistoryListParams, options: AcpHistoryRequestOptions): Promise<unknown>;
}

export interface CreateAcpHistoryOptions {
  readonly providerKey: AgentProviderKey;
  readonly sourceId: string;
  readonly generation: string;
  readonly scope: AcpHistoryScope;
  readonly connection: AcpHistoryConnection;
  readonly limits?: Partial<AgentHistoryLimits>;
}
