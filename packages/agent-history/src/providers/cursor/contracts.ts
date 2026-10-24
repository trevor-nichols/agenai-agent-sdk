import type { AgentHistoryMutationOperation } from '../../contracts/index.js';
import type { AgentHistoryLimits } from '../../lifecycle/limits.js';

export interface CursorHistoryStore {
  readonly kind: 'jsonl' | 'sqlite';
  readonly path: string;
}

export interface CursorHistoryResourcePolicy {
  readonly kind: 'linux-prlimit';
  readonly executable: string;
  readonly temporaryRoot: string;
}

export interface CreateCursorHistoryOptions {
  readonly sourceId: string;
  readonly generation: string;
  readonly store: CursorHistoryStore;
  readonly scope: Readonly<{ kind: 'project'; projectPath: string; worktrees: 'excluded' }>;
  readonly resources: CursorHistoryResourcePolicy;
  readonly limits?: Partial<AgentHistoryLimits>;
  readonly management?: readonly AgentHistoryMutationOperation[];
}
