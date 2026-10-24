import type { AgentHistoryLimits } from '../../lifecycle/limits.js';
import type { AgentHistoryMutationOperation } from '../../contracts/index.js';

export type OpenCodeHistoryMessageType = 'agent-switched' | 'model-switched' | 'location-switched'
  | 'user' | 'synthetic' | 'system' | 'skill' | 'shell' | 'assistant' | 'compaction' | 'idle';

export interface CreateOpenCodeHistoryOptions {
  readonly sourceId: string;
  readonly generation: string;
  readonly scope: Readonly<{ kind: 'project'; projectPath: string; worktrees: 'excluded' }>;
  readonly projectID?: string;
  readonly server: Readonly<{
    baseUrl: string;
    headers?: Readonly<Record<string, string>>;
    runtimeVersion: '2.1.2';
  }>;
  readonly resources: Readonly<{ kind: 'caller_owned' }>;
  readonly messageType?: OpenCodeHistoryMessageType;
  readonly limits?: Partial<AgentHistoryLimits>;
  readonly management?: readonly AgentHistoryMutationOperation[];
}

export interface OpenCodeSessionListInput {
  readonly limit: number;
  readonly cursor?: string;
  readonly order?: 'asc' | 'desc';
  readonly directory?: string;
  readonly project?: string;
  readonly parentID?: string;
  readonly archived?: boolean;
  readonly search?: string;
}

export interface OpenCodeMessageListInput {
  readonly sessionID: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly order?: 'asc';
  readonly type?: OpenCodeHistoryMessageType;
}

export interface OpenCodeHistoryClient {
  info(signal: AbortSignal): Promise<unknown>;
  sessions(input: OpenCodeSessionListInput, signal: AbortSignal): Promise<unknown>;
  session(id: string, signal: AbortSignal): Promise<unknown>;
  messages(input: OpenCodeMessageListInput, signal: AbortSignal): Promise<unknown>;
  active(signal: AbortSignal): Promise<unknown>;
  update(input: OpenCodeSessionUpdateInput, signal: AbortSignal, dispatch: () => void): Promise<void>;
  remove(sessionID: string, signal: AbortSignal, dispatch: () => void): Promise<void>;
}
export type OpenCodeSessionUpdateInput = Readonly<{ sessionID: string; title: string }>
  | Readonly<{ sessionID: string; archived: boolean }>;
