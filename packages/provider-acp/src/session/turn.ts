import type { AcpJsonObject } from '@agen-ai/acp-transport';
import type { AgentTurnCompletedPayload, AgentTurnId } from '@agen-ai/agent-protocol';
import type { TurnMapping } from './mapping.js';
import type { deferred } from './queue.js';
import type { PendingSessionRequest } from './requests/pending.js';

export type SessionMessage =
  | Readonly<{ kind: 'update'; params: AcpJsonObject }>
  | Readonly<{ kind: 'request'; request: PendingSessionRequest }>
  | Readonly<{ kind: 'terminal'; payload: AgentTurnCompletedPayload }>;

export interface NativeTurn {
  readonly turnId: AgentTurnId;
  readonly mapping: TurnMapping;
  readonly settled: ReturnType<typeof deferred<AgentTurnCompletedPayload>>;
  readonly cleanup: (() => void)[];
  readonly hostInteractions: AbortController;
  prompt: Promise<void>;
  nativeStarted: boolean;
  nativeSettled: boolean;
  terminal: boolean;
  waiting: PendingSessionRequest | undefined;
  transition: Readonly<{ nextRequest?: PendingSessionRequest }> | undefined;
  cancelReason: 'user_requested' | 'timeout' | 'shutdown' | 'superseded' | 'other' | undefined;
  cancellation: Promise<void> | undefined;
}
