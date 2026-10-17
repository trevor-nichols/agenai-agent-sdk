import type { AcpJsonObject, AcpNotificationContext } from '@agen-ai/acp-transport';

import { GROK_QUEUE_METHOD, GROK_SESSION_NOTIFICATION_METHOD } from '../sessionInteractions/grokPlanReview.js';
import { AcpProviderSessionError } from './errors.js';
import { nativeIdentity, nativeObject, nativeString } from './native.js';
import type { SessionQueue } from './queue.js';
import type { GrokChildPermissionWithdrawals } from './requests/grokWithdrawals.js';

export interface DescendantIdentity {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly subagentId: string;
  readonly attemptId?: string;
  readonly parentPromptId?: string;
}

interface DescendantObservation {
  readonly identity: DescendantIdentity;
  readonly origin: 'live' | 'historical';
  readonly release: () => void;
}

/** Selected native descendants are bounded observations, with no parent output or host authority. */
export class GrokDescendantObservations {
  private readonly bySession = new Map<string, DescendantObservation>();
  private readonly bySubagent = new Map<string, DescendantObservation>();

  constructor(private readonly input: Readonly<{
    reserveState: SessionQueue<unknown>['reserveState'];
    rootSessionId: () => string | undefined;
    activeTurn: () => boolean;
    observeHistory: (params: AcpJsonObject) => void;
    withdrawals: GrokChildPermissionWithdrawals;
  }>) {}

  /** Returns true only when this notification is wholly owned by the observation scope. */
  admit(context: AcpNotificationContext, historical: boolean): boolean {
    const params = nativeObject(context.params, 'descendant notification');
    const meta = params._meta === undefined ? undefined : nativeObject(params._meta, 'descendant metadata');
    if (meta?.isReplay !== undefined && typeof meta.isReplay !== 'boolean') throw new AcpProviderSessionError(
      'acp_descendant_replay_invalid', 'The selected native replay marker must be a boolean.');
    const replay = historical || meta?.isReplay === true;
    const root = this.input.rootSessionId();
    if (params.sessionId === root && root !== undefined) {
      if (context.method !== GROK_SESSION_NOTIFICATION_METHOD) return false;
      const update = nativeObject(params.update, 'descendant session update');
      if (update.sessionUpdate === 'subagent_spawned') this.spawn(update, root, replay);
      else if (update.sessionUpdate === 'subagent_finished') {
        const child = this.bySession.get(nativeIdentity(update.child_session_id, 'finished child session identity'));
        if (child?.origin === 'live' && !replay) this.input.withdrawals.finish(child.identity, update);
      } else return false;
      this.input.observeHistory(params);
      return true;
    }
    if (root === undefined) return false;
    const sessionId = nativeIdentity(params.sessionId, 'child session identity');
    const observation = this.bySession.get(sessionId);
    if (!observation || observation.origin === 'historical' && !replay) return false;
    if (context.method === GROK_QUEUE_METHOD) {
      this.validateQueue(params);
    } else {
      const update = nativeObject(params.update, 'child session update');
      const kind = nativeString(update.sessionUpdate, 'child session update kind');
      if (kind === 'subagent_spawned') throw new AcpProviderSessionError(
        'acp_descendant_nested_unsupported', 'The selected native mapping does not admit nested descendant relationships.');
      if (context.method === GROK_SESSION_NOTIFICATION_METHOD && !replay) this.input.withdrawals.observe(observation.identity, update);
    }
    this.input.observeHistory(params);
    return true;
  }

  private spawn(update: AcpJsonObject, root: string, historical: boolean): void {
    const value: DescendantIdentity = Object.freeze({
      parentSessionId: nativeIdentity(update.parent_session_id, 'parent session identity'),
      childSessionId: nativeIdentity(update.child_session_id, 'child session identity'),
      subagentId: nativeIdentity(update.subagent_id, 'subagent identity'),
      ...(update.attempt_id === undefined ? {} : { attemptId: nativeIdentity(update.attempt_id, 'attempt identity') }),
      ...(update.parent_prompt_id === undefined ? {} : { parentPromptId: nativeIdentity(update.parent_prompt_id, 'parent prompt identity') }),
    });
    if (value.parentSessionId !== root || value.childSessionId === root || value.subagentId === root) throw new AcpProviderSessionError(
      'acp_descendant_identity_invalid', 'The selected native spawn does not identify a direct child of the bound root.');
    const prior = this.bySession.get(value.childSessionId) ?? this.bySubagent.get(value.subagentId);
    if (prior) {
      if (JSON.stringify(prior.identity) !== JSON.stringify(value) || prior.origin === 'historical' && !historical) throw new AcpProviderSessionError(
        'acp_descendant_identity_conflict', 'The selected native descendant identity cannot be rebound or revived.');
      return;
    }
    if (!historical && !this.input.activeTurn()) throw new AcpProviderSessionError(
      'acp_descendant_without_prompt', 'A live native descendant requires active owned parent work.');
    const observation: DescendantObservation = { identity: value, origin: historical ? 'historical' : 'live',
      release: this.input.reserveState(value) };
    this.bySession.set(value.childSessionId, observation);
    this.bySubagent.set(value.subagentId, observation);
  }

  private validateQueue(params: AcpJsonObject): void {
    if (!Array.isArray(params.entries) || params.entries.length > 256) throw new AcpProviderSessionError(
      'acp_descendant_queue_invalid', 'The selected native child queue is invalid.');
    for (const entry of params.entries) nativeIdentity(nativeObject(entry, 'child queue entry').id, 'child queue prompt identity');
    if (params.runningPromptId != null) nativeIdentity(params.runningPromptId, 'running child prompt identity');
  }

  stop(): void {
    for (const observation of this.bySession.values()) observation.release();
    this.bySession.clear();
    this.bySubagent.clear();
  }
}
