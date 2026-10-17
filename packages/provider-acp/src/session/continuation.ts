import type { AcpJsonObject, AcpJsonValue, AcpNotificationContext } from '@agen-ai/acp-transport';
import type { AgentTurnCompletedPayload, AgentTurnId } from '@agen-ai/agent-protocol';
import { throwIfAgentOperationAborted, type AgentNativeContinuationOutcome, type AgentProviderOutput,
  type AgentProviderTurnExecution } from '@agen-ai/agent-runtime';
import type { PreparePlanContinuation } from '../sessionInteractions/request.js';
import { GROK_QUEUE_METHOD } from '../sessionInteractions/grokPlanReview.js';
import { AcpProviderSessionError } from './errors.js';
import { acpTurnCompletion } from './completion.js';
import { nativeObject, nativeString, SESSION_METADATA_UPDATES } from './native.js';
import { deferred, type SessionQueue } from './queue.js';
import type { NativeTurn, SessionMessage } from './turn.js';

/** The selected restored-plan continuation shares the session's turn and output owners. */
export class GrokPlanContinuations {
  private readonly historicalPrompts = new Map<string, () => void>();
  private readonly completedPrompts = new Set<string>();
  private continuation: Readonly<{
    turn: NativeTurn;
    outcome: ReturnType<typeof deferred<AgentNativeContinuationOutcome>>;
    ready: ReturnType<typeof deferred<boolean>>;
    state: { dispatched: boolean; promptId?: string; outputObserved: boolean };
  }> | undefined;

  constructor(private readonly input: Readonly<{
    queue: SessionQueue<SessionMessage>;
    selected: boolean;
    requireUsable: () => void;
    assertNativeSession: (params: AcpJsonObject) => void;
    createNativeTurn: (turnId: AgentTurnId) => NativeTurn;
    execution: (turn: NativeTurn, stream: () => AsyncGenerator<AgentProviderOutput>) => AgentProviderTurnExecution;
    stream: (turn: NativeTurn, ready: Promise<boolean>) => AsyncGenerator<AgentProviderOutput>;
    completeNativeTurn: (turn: NativeTurn, payload: AgentTurnCompletedPayload) => void;
    close: () => Promise<void>;
  }>) {}

  private replayed(meta: AcpJsonObject | undefined): boolean {
    if (meta?.isReplay !== undefined && typeof meta.isReplay !== 'boolean') throw new AcpProviderSessionError(
      'acp_continuation_replay_invalid', 'The selected native replay marker must be a boolean.');
    return meta?.isReplay === true;
  }

  private promptIds(values: readonly (AcpJsonValue | undefined)[]): readonly string[] {
    return values.flatMap((value) => {
      if (value === undefined || value === null) return [];
      const id = nativeString(value, 'prompt identity');
      if (!id || Buffer.byteLength(id, 'utf8') > 256) throw new AcpProviderSessionError(
        'acp_continuation_identity_invalid', 'Native prompt identity exceeds its bound.');
      return [id];
    });
  }

  private rememberPrompts(ids: readonly string[]): void {
    for (const id of ids) if (!this.historicalPrompts.has(id)) this.historicalPrompts.set(id, this.input.queue.reserveState(id));
  }

  admitOutput(params: AcpJsonObject, update: AcpJsonObject, historical: boolean): boolean {
    if (!this.input.selected) return true;
    const meta = params._meta === undefined ? undefined : nativeObject(params._meta, 'continuation metadata');
    const replay = this.replayed(meta);
    const ids = this.promptIds([meta?.promptId, update.prompt_id]);
    if (historical || replay || !this.continuation?.state.dispatched) this.rememberPrompts(ids);
    if (historical || replay) return false;
    if (SESSION_METADATA_UPDATES.has(nativeString(update.sessionUpdate, 'session update kind'))) return true;
    if (this.continuation && !this.continuation.turn.terminal) {
      if (!this.continuation.state.promptId || meta?.promptId !== this.continuation.state.promptId) {
        throw new AcpProviderSessionError('acp_continuation_output_mismatch', 'Native continuation output requires its exact promoted prompt identity.');
      }
      this.continuation.state.outputObserved = true;
    }
    return true;
  }

  admitNotification(context: AcpNotificationContext): void {
    this.input.requireUsable();
    const params = nativeObject(context.params, 'continuation notification');
    this.input.assertNativeSession(params);
    const meta = params._meta === undefined ? undefined : nativeObject(params._meta, 'continuation metadata');
    const replay = this.replayed(meta);
    const update = context.method === GROK_QUEUE_METHOD ? undefined : nativeObject(params.update, 'native session update');
    const ids = this.promptIds([meta?.promptId, update?.prompt_id, ...(context.method === GROK_QUEUE_METHOD
      ? [params.runningPromptId, ...Array.isArray(params.entries) ? params.entries.map((entry) => nativeObject(entry, 'queue entry').id) : []] : [])]);
    if (replay || !this.continuation?.state.dispatched) this.rememberPrompts(ids);
    if (replay) return;
    if (context.method === GROK_QUEUE_METHOD) {
      const continuation = this.continuation;
      if (!continuation?.state.dispatched || params.runningPromptId == null) return;
      const id = nativeString(params.runningPromptId, 'promoted prompt identity');
      if (params.runningKind !== 'prompt' || !id.startsWith('plan-resume-') || this.historicalPrompts.has(id) && continuation.state.promptId !== id
        || meta?.promptId != null && meta.promptId !== id
        || ids.some((value) => value !== id && !this.historicalPrompts.has(value))
        || continuation.state.promptId !== undefined && continuation.state.promptId !== id) {
        throw new AcpProviderSessionError('acp_continuation_promotion_invalid', 'The native continuation promotion does not identify its fresh owned prompt.');
      }
      if (!continuation.state.promptId) {
        continuation.state.promptId = id;
        continuation.turn.nativeStarted = true;
        continuation.outcome.resolve(Object.freeze({ kind: 'started' }));
        continuation.ready.resolve(true);
      }
      return;
    }
    if (update?.sessionUpdate !== 'turn_completed') return;
    const continuation = this.continuation;
    if (!continuation?.state.dispatched) {
      if (typeof update.prompt_id === 'string' && this.completedPrompts.has(update.prompt_id)) throw new AcpProviderSessionError(
        'acp_continuation_terminal_invalid', 'The native continuation repeated an already completed terminal.');
      return;
    }
    if (update.prompt_id !== continuation.state.promptId) {
      if (typeof update.prompt_id === 'string' && this.historicalPrompts.has(update.prompt_id)) return;
      throw new AcpProviderSessionError('acp_continuation_terminal_mismatch', 'The terminal does not identify the owned promoted prompt.');
    }
    if (!continuation.state.promptId || continuation.turn.nativeSettled
      || update.stop_reason !== 'end_turn' && update.stop_reason !== 'cancelled'
      || update.stop_reason === 'end_turn' && !continuation.state.outputObserved
      || update.error != null || params.error != null) throw new AcpProviderSessionError(
      'acp_continuation_terminal_invalid', 'The native continuation did not produce its exact terminal.');
    this.input.completeNativeTurn(continuation.turn, acpTurnCompletion({ kind: 'result',
      result: { stopReason: update.stop_reason } }, continuation.turn.cancelReason));
  }

  prepareResponse(input: Parameters<PreparePlanContinuation>[0]): ReturnType<PreparePlanContinuation> {
    this.input.requireUsable();
    throwIfAgentOperationAborted(input.signal);
    let canceled = false;
    let dispatched = false;
    let owned: NonNullable<GrokPlanContinuations['continuation']> | undefined;
    const outcome = deferred<AgentNativeContinuationOutcome>();
    const ready = deferred<boolean>();
    void outcome.promise.catch(() => {});
    void ready.promise.catch(() => {});
    const cancel = async () => {
      if (canceled) return;
      canceled = true;
      if (dispatched) { await this.input.close(); return; }
      outcome.resolve(Object.freeze({ kind: 'not_started' }));
      ready.resolve(false);
      if (owned) {
        owned.turn.terminal = true;
        owned.turn.sourceSettled = true;
        owned.turn.mapping.release();
        owned.outcome.resolve(Object.freeze({ kind: 'not_started' }));
        owned.ready.resolve(false);
        this.input.queue.wakeReader();
        if (this.continuation === owned) this.continuation = undefined;
      }
    };
    const dispatch = async () => {
      throwIfAgentOperationAborted(input.signal);
      if (canceled || dispatched) throw new AcpProviderSessionError('acp_continuation_dispatch_invalid', 'A prepared response can enter only once.');
      if (input.response.action !== 'abandon' && !owned) throw new AcpProviderSessionError('acp_continuation_owner_missing', 'The native continuation requires its prepared reader.');
      dispatched = true;
      if (owned) owned.state.dispatched = true;
      const result = await input.dispatch();
      if (result.status !== 'delivered' && owned) {
        owned.turn.terminal = true;
        owned.turn.mapping.release();
        owned.outcome.resolve(Object.freeze({ kind: 'not_started' }));
        owned.ready.resolve(false);
      }
      return result;
    };
    if (input.response.action === 'abandon') return Object.freeze({ kind: 'no_continuation', dispatch, cancel });
    return Object.freeze({ kind: 'native_continuation', outcome: outcome.promise, dispatch, cancel,
      createExecution: ({ turnId, signal }: Readonly<{ turnId: AgentTurnId; signal: AbortSignal }>) => {
        if (owned || canceled || dispatched) throw new AcpProviderSessionError('acp_continuation_owner_invalid', 'The prepared execution can be acquired only once.');
        throwIfAgentOperationAborted(signal);
        const turn = this.input.createNativeTurn(turnId);
        owned = { turn, outcome, ready, state: { dispatched: false, outputObserved: false } };
        this.continuation = owned;
        const owner = this.input;
        return owner.execution(turn, async function* () {
          yield* owner.stream(turn, ready.promise);
          if (dispatched) await input.nativeSettled;
        });
      } });
  }

  complete(turn: NativeTurn): void {
    if (this.continuation?.turn !== turn) return;
    const promptId = this.continuation.state.promptId;
    if (promptId !== undefined) {
      this.rememberPrompts([promptId]);
      this.completedPrompts.add(promptId);
    }
    this.continuation = undefined;
  }

  stop(error: Error): void {
    this.continuation?.ready.reject(error);
    this.continuation?.outcome.reject(error);
    for (const release of this.historicalPrompts.values()) release();
    this.historicalPrompts.clear();
    this.completedPrompts.clear();
  }
}
