import { AcpRequestError, type AcpJsonValue, type AcpReverseRequestContext } from '@agen-ai/acp-transport';
import {
  parseAgentSessionDecisionResponseFor,
  parseAgentSessionPlanReviewResponseFor,
  type AgentError,
  type AgentSessionDecisionRequest,
  type AgentSessionPlanReviewRequest,
  type AgentSessionPlanReviewResponse,
} from '@agen-ai/agent-protocol';
import {
  throwIfAgentOperationAborted,
  type AgentRequestResolutionResult,
  type AgentProviderSessionInteraction,
  type AgentProviderPrepareSessionResponseInput,
  type AgentPreparedSessionResponse,
  type AgentProviderSessionInteractionContext,
  type AgentSessionResponseInput,
  type AgentSessionInteractionTerminal,
} from '@agen-ai/agent-runtime';

import { AcpProviderSessionError } from '../session/errors.js';
import { deferred } from '../session/queue.js';
import { nativePlanReviewReply } from './grokPlanReview.js';

export type PreparePlanContinuation = (input: Readonly<{
  response: AgentSessionPlanReviewResponse;
  signal: AbortSignal;
  nativeSettled: Promise<void>;
  dispatch: () => Promise<AgentRequestResolutionResult>;
}>) => AgentPreparedSessionResponse;

type RequestState =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'terminal'; terminal: AgentSessionInteractionTerminal }>;

export function sessionDecisionError(code: string, message: string): AgentError {
  return Object.freeze({ category: 'invalid_request', code, message, recovery: Object.freeze({ kind: 'none' }) });
}

export class NativeSessionDecision {
  readonly handle: AgentProviderSessionInteraction;
  readonly nativeReply: Promise<AcpJsonValue>;
  private readonly answer = deferred<AcpJsonValue>();
  private readonly terminal = deferred<AgentSessionInteractionTerminal>();
  private readonly presentation = new AbortController();
  private state: RequestState = { kind: 'pending' };
  private callback: Promise<void> | undefined;
  private callbackSettled = true;
  private nativeSettled = false;
  private presented = false;
  private retired = false;
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onNativeAbort = () => this.nativeAborted();

  constructor(private readonly input: Readonly<{
    request: AgentSessionDecisionRequest | AgentSessionPlanReviewRequest;
    nativeContext: Pick<AcpReverseRequestContext, 'id' | 'signal' | 'settled'>;
    hostDeadlineAt?: number;
    prepareContinuation?: PreparePlanContinuation;
    accepting: () => boolean;
    fail: (cause: Error) => void;
    retire: () => void;
  }>) {
    const base = {
      request: input.request,
      signal: this.presentation.signal,
      terminal: this.terminal.promise,
    };
    this.handle = input.request.kind === 'plan_review'
      ? Object.freeze({ ...base, kind: 'prepared', request: input.request,
        prepareResponse: (response: AgentProviderPrepareSessionResponseInput) => this.prepareResponse(response) })
      : Object.freeze({ ...base, kind: 'direct', respond: (response: AgentSessionResponseInput) => this.respond(response) });
    this.nativeReply = this.answer.promise;
    void input.nativeContext.settled.then(() => {
      this.nativeSettled = true;
      this.maybeRetire();
    });
    void this.nativeReply.catch(() => {});
    if (input.hostDeadlineAt !== undefined) this.timer = setTimeout(() => this.expire(), Math.max(0, input.hostDeadlineAt - Date.now()));
    input.nativeContext.signal.addEventListener('abort', this.onNativeAbort, { once: true });
  }

  observeNativeSignal(): void {
    if (this.input.nativeContext.signal.aborted) this.nativeAborted();
  }

  present(handler: AgentProviderSessionInteractionContext['onRequest']): void {
    if (this.presented || this.state.kind !== 'pending') return;
    this.observeNativeSignal();
    if (this.state.kind !== 'pending' || !this.input.accepting()) return;
    if (this.input.hostDeadlineAt !== undefined && Date.now() >= this.input.hostDeadlineAt) { this.expire(); return; }
    this.presented = true;
    this.callbackSettled = false;
    let synchronousFailure: { readonly cause: unknown } | undefined;
    try { this.callback = Promise.resolve(handler(this.handle)); }
    catch (cause) {
      synchronousFailure = { cause };
      this.callback = Promise.reject(cause);
    }
    void this.callback.then(() => {
      this.callbackSettled = true;
      this.maybeRetire();
    }, (cause: unknown) => {
      this.callbackSettled = true;
      this.input.fail(callbackError(cause));
      this.maybeRetire();
    });
    if (synchronousFailure) this.input.fail(callbackError(synchronousFailure.cause));
  }

  stop(terminal: AgentSessionInteractionTerminal, cause: Error): void {
    if (this.state.kind === 'terminal') return;
    this.finalize(terminal);
    this.answer.reject(cause);
  }

  private finalize(terminal: AgentSessionInteractionTerminal): void {
    if (this.state.kind === 'terminal') return;
    this.state = { kind: 'terminal', terminal: Object.freeze(terminal) };
    clearTimeout(this.timer);
    this.input.nativeContext.signal.removeEventListener('abort', this.onNativeAbort);
    this.terminal.resolve(this.state.terminal);
    this.presentation.abort(new DOMException('The session decision is no longer answerable.', 'AbortError'));
    this.maybeRetire();
  }

  private expire(): void {
    if (this.state.kind === 'terminal') return;
    const cause = new AcpProviderSessionError('acp_session_interaction_expired', 'The session decision expired before acceptance.');
    this.stop(Object.freeze({ kind: 'expired', source: 'host_policy' }), cause);
    this.input.fail(cause);
  }

  private nativeAborted(): void {
    if (this.state.kind === 'terminal') return;
    const reason: unknown = this.input.nativeContext.signal.reason;
    if (reason instanceof AcpRequestError && reason.reasonCode === 'acp_reverse_request_canceled'
      && reason.requestId === this.input.nativeContext.id) {
      this.stop(Object.freeze({ kind: 'withdrawn' }), reason);
      return;
    }
    this.input.fail(reason instanceof Error ? reason : new AcpProviderSessionError(
      'acp_session_interaction_native_failed', 'The native session decision producer stopped.'));
  }

  private async respond(input: AgentSessionResponseInput): Promise<AgentRequestResolutionResult> {
    throwIfAgentOperationAborted(input.signal);
    if (this.input.request.kind !== 'decision') throw new TypeError('Plan review requires prepared response ownership.');
    const response = parseAgentSessionDecisionResponseFor(this.input.request, { kind: input.kind, choiceId: input.choiceId });
    this.observeNativeSignal();
    if (this.input.hostDeadlineAt !== undefined && Date.now() >= this.input.hostDeadlineAt) this.expire();
    if (!this.input.accepting() || this.state.kind === 'terminal') {
      return Object.freeze({ status: 'rejected', requestState: 'unavailable', error: sessionDecisionError(
        'session_interaction_unavailable', 'The session decision is no longer available.') });
    }
    // Resolving this exact handler is local acceptance; serialization and native effects occur later.
    this.answer.resolve(Object.freeze({ outcome: response.choiceId === 'grant' ? 'trust' : 'reject' }));
    this.finalize(Object.freeze({ kind: 'answered', response }));
    return Object.freeze({ status: 'delivered' });
  }

  private prepareResponse(input: AgentProviderPrepareSessionResponseInput): AgentPreparedSessionResponse {
    throwIfAgentOperationAborted(input.signal);
    if (this.input.request.kind !== 'plan_review' || !this.input.prepareContinuation) throw new TypeError('This request has no continuation mapping.');
    const response = parseAgentSessionPlanReviewResponseFor(this.input.request, input.response);
    return this.input.prepareContinuation({ response, signal: input.signal, nativeSettled: this.input.nativeContext.settled, dispatch: async () => {
      throwIfAgentOperationAborted(input.signal);
      this.observeNativeSignal();
      if (this.input.hostDeadlineAt !== undefined && Date.now() >= this.input.hostDeadlineAt) this.expire();
      if (!this.input.accepting() || this.state.kind === 'terminal') return Object.freeze({ status: 'rejected', requestState: 'unavailable',
        error: sessionDecisionError('session_interaction_unavailable', 'The plan review is no longer available.') });
      this.answer.resolve(nativePlanReviewReply(response));
      this.finalize(Object.freeze({ kind: 'answered', response: Object.freeze({ kind: 'plan_review', action: response.action,
        choiceId: response.choiceId, planId: response.planId, revision: response.revision }) }));
      return Object.freeze({ status: 'delivered' });
    } });
  }

  private maybeRetire(): void {
    if (this.retired || this.state.kind !== 'terminal' || !this.nativeSettled || !this.callbackSettled) return;
    this.retired = true;
    this.input.retire();
  }

  async join(): Promise<void> {
    await Promise.allSettled([this.input.nativeContext.settled, ...(this.callback ? [this.callback] : [])]);
  }
}

function callbackError(cause: unknown): Error {
  return cause instanceof Error ? cause : new AcpProviderSessionError(
    'acp_session_interaction_handler_failed', 'The session decision handler failed.', { cause });
}
