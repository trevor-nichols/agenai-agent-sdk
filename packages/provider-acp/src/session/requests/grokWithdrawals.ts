import type { AcpJsonObject } from '@agen-ai/acp-transport';

import type { DescendantIdentity } from '../descendants.js';
import { AcpProviderSessionError } from '../errors.js';
import { nativeIdentity, nativeObject } from '../native.js';
import { deferred, type SessionQueue } from '../queue.js';
import type { NativeTurn } from '../turn.js';
import type { PendingSessionRequest } from './pending.js';

const PERMISSION_STATE_OVERHEAD_BYTES = 256;

type PermissionPhase =
  | Readonly<{ kind: 'announced'; turn: NativeTurn }>
  | Readonly<{ kind: 'attached'; turn: NativeTurn; request: PendingSessionRequest }>
  | Readonly<{ kind: 'resolved'; turn: NativeTurn; request: PendingSessionRequest;
      hold: Readonly<{ ready: ReturnType<typeof deferred<void>>; timer: ReturnType<typeof setTimeout> }> | undefined }>
  | Readonly<{ kind: 'retired' }>;

interface ChildPermission {
  phase: PermissionPhase;
  readonly release: () => void;
}

interface ChildPermissions {
  readonly interactions: Map<string, ChildPermission>;
  readonly release: () => void;
  finished: boolean;
}

/** Only the observed ordered child/tool callback and exact canceled attempt can withdraw a permission. */
export class GrokChildPermissionWithdrawals {
  private readonly children = new Map<string, ChildPermissions>();
  private readonly requests = new Map<PendingSessionRequest, ChildPermission>();

  constructor(private readonly input: Readonly<{
    reserveState: SessionQueue<unknown>['reserveState'];
    currentTurn: () => NativeTurn | undefined;
    timeoutMs: number;
    withdraw: (request: PendingSessionRequest) => void;
    fail: (error: Error) => void;
  }>) {}

  observe(identity: DescendantIdentity, update: AcpJsonObject): void {
    if (identity.attemptId === undefined || update.sessionUpdate !== 'pending_interaction' && update.sessionUpdate !== 'interaction_resolved') return;
    if (update.sessionUpdate === 'pending_interaction' && update.kind !== 'permission') return;
    const toolId = nativeIdentity(update.tool_call_id, 'child permission tool identity');
    const child = this.child(identity);
    const prior = child.interactions.get(toolId);
    if (update.sessionUpdate === 'pending_interaction') {
      const turn = this.input.currentTurn();
      if (child.finished || prior?.phase.kind === 'retired' || !turn || turn.nativeSettled || turn.terminal
        || prior && prior.phase.turn !== turn) throw this.stale();
      if (!prior) child.interactions.set(toolId, { phase: { kind: 'announced', turn },
        release: this.input.reserveState({ childSessionId: identity.childSessionId, toolId }, PERMISSION_STATE_OVERHEAD_BYTES) });
      return;
    }
    if (!prior) {
      child.interactions.set(toolId, { phase: { kind: 'retired' },
        release: this.input.reserveState({ childSessionId: identity.childSessionId, toolId }, PERMISSION_STATE_OVERHEAD_BYTES) });
      return;
    }
    if (prior.phase.kind === 'announced') { prior.phase = { kind: 'retired' }; return; }
    if (prior.phase.kind !== 'attached') return;
    const { turn, request } = prior.phase;
    if (turn !== this.input.currentTurn() || turn.nativeSettled || turn.terminal) throw this.stale();
    const hold = request.answered ? undefined : { ready: deferred<void>(), timer: setTimeout(() => this.input.fail(
      new AcpProviderSessionError('acp_native_permission_uncertain', 'The resolved native child permission lacks exact cancellation corroboration.')),
    this.input.timeoutMs) };
    if (hold) void hold.ready.promise.catch(() => {});
    prior.phase = { kind: 'resolved', turn, request, hold };
  }

  attach(request: PendingSessionRequest): void {
    if (request.kind !== 'permission') return;
    const tool = nativeObject(request.params.toolCall, 'permission tool');
    const meta = tool._meta === undefined ? undefined : nativeObject(tool._meta, 'permission tool metadata');
    if (meta?.['x.ai/requestingSessionId'] === undefined) return;
    const childId = nativeIdentity(meta['x.ai/requestingSessionId'], 'requesting child session identity');
    if (childId === request.params.sessionId) return;
    const child = this.children.get(childId);
    if (!child) return;
    const interaction = child.interactions.get(nativeIdentity(tool.toolCallId, 'permission tool identity'));
    if (child.finished || interaction && (interaction.phase.kind !== 'announced'
      || interaction.phase.turn !== this.input.currentTurn())) throw this.stale();
    if (!interaction || interaction.phase.kind !== 'announced') return;
    interaction.phase = { kind: 'attached', turn: interaction.phase.turn, request };
    this.requests.set(request, interaction);
  }

  finish(identity: DescendantIdentity, update: AcpJsonObject): void {
    if (identity.attemptId === undefined) return;
    if (nativeIdentity(update.subagent_id, 'finished subagent identity') !== identity.subagentId
      || nativeIdentity(update.attempt_id, 'finished attempt identity') !== identity.attemptId) throw new AcpProviderSessionError(
      'acp_native_permission_identity_conflict', 'The native child finish does not identify its exact announced attempt.');
    const child = this.child(identity);
    if (child.finished) return;
    child.finished = true;
    for (const interaction of child.interactions.values()) {
      const phase = interaction.phase;
      if (phase.kind !== 'attached' && phase.kind !== 'resolved' || phase.turn !== this.input.currentTurn()
        || phase.turn.nativeSettled || phase.turn.terminal) continue;
      if (phase.kind !== 'resolved' || update.status !== 'cancelled') {
        if (!phase.request.answered) throw new AcpProviderSessionError(
          'acp_native_permission_uncertain', 'The native child finish lacks the exact ordered permission cancellation facts.');
        continue;
      }
      this.input.withdraw(phase.request);
      this.retire(interaction);
    }
  }

  answerGate(request: PendingSessionRequest): Promise<void> | undefined {
    const phase = this.requests.get(request)?.phase;
    return phase?.kind === 'resolved' ? phase.hold?.ready.promise : undefined;
  }

  settle(request: PendingSessionRequest): void {
    const interaction = this.requests.get(request);
    if (interaction) this.retire(interaction);
    this.requests.delete(request);
  }

  private child(identity: DescendantIdentity): ChildPermissions {
    let child = this.children.get(identity.childSessionId);
    if (!child) {
      child = { interactions: new Map(), finished: false, release: this.input.reserveState({
        childSessionId: identity.childSessionId, subagentId: identity.subagentId, attemptId: identity.attemptId,
      }) };
      this.children.set(identity.childSessionId, child);
    }
    return child;
  }

  private retire(interaction: ChildPermission, error?: Error): void {
    const phase = interaction.phase;
    if (phase.kind === 'resolved' && phase.hold) {
      clearTimeout(phase.hold.timer);
      if (error) phase.hold.ready.reject(error);
      else phase.hold.ready.resolve();
    }
    interaction.phase = { kind: 'retired' };
  }

  private stale(): AcpProviderSessionError {
    return new AcpProviderSessionError('acp_native_permission_stale', 'The native child permission does not identify a fresh callback in its original turn.');
  }

  stop(error: Error): void {
    for (const child of this.children.values()) {
      for (const interaction of child.interactions.values()) { this.retire(interaction, error); interaction.release(); }
      child.release();
    }
    this.children.clear();
    this.requests.clear();
  }
}
