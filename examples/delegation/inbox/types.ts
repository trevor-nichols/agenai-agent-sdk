import type {
  DelegationCompletionEnvelope, DelegationParentDeliveryPort, DelegationParentScope,
} from '@agen-ai/agent-orchestration';

export type ParentLifecycle = 'idle' | 'running' | 'busy' | 'waiting' | 'stopped' | 'paused' | 'retired';

export interface ParentDestination {
  readonly revision: number;
  readonly lifecycle: ParentLifecycle;
  readonly resultAccess: boolean;
  readonly executionAllowed: boolean;
}

export interface ParentTurnLease {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  dispatch(input: Readonly<{
    envelope: DelegationCompletionEnvelope;
    inboxId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{ status: 'acknowledged' | 'uncertain' }>>;
  release(): void | Promise<void>;
}

export interface ParentInboxHost {
  inspectParent(parent: DelegationParentScope): ParentDestination | undefined;
  /** Shares the host's normal parent-turn exclusion and current execution authority. */
  acquireTurn(parent: DelegationParentScope): ParentTurnLease | undefined;
}

export type ParentInboxState = 'pending' | 'dispatch_intended' | 'acknowledged' | 'recovery_required' | 'dismissed';

export interface ParentInboxView {
  readonly inboxId: string;
  readonly envelope: DelegationCompletionEnvelope;
  readonly acceptedAt: string;
  readonly state: ParentInboxState;
  readonly dispatchId?: string;
  readonly dispatchedAt?: string;
  readonly settledAt?: string;
  readonly reason?: string;
}

export interface ParentDispatchReceipt {
  readonly inboxId: string;
  readonly state: ParentInboxState | 'blocked';
  readonly reason?: string;
}

export interface SqliteParentInbox {
  readonly port: DelegationParentDeliveryPort;
  inspect(input: Readonly<{ parent: DelegationParentScope; storeId: string; notificationId: string }>): ParentInboxView | undefined;
  dispatchPending(input: Readonly<{
    parent: DelegationParentScope;
    trigger: 'automatic' | 'next_turn';
    limit?: number;
  }>): Promise<readonly ParentDispatchReceipt[]>;
  dispose(input?: Readonly<{ timeoutMs?: number }>): Promise<Readonly<{ status: 'closed' | 'recovery_required' }>>;
}
