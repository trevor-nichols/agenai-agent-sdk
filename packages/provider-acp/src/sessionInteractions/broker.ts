import type { AcpJsonValue, AcpReverseRequestContext } from '@agen-ai/acp-transport';
import type { AgentProviderConversationId, AgentSessionId } from '@agen-ai/agent-protocol';
import {
  DEFAULT_AGENT_SESSION_INTERACTION_LIMITS,
  throwIfAgentOperationAborted,
  type AgentSessionInteractionContext,
  type AgentSessionInteractionLimits,
} from '@agen-ai/agent-runtime';

import type { AcpProviderLimits } from '../limits.js';
import { AcpProviderSessionError } from '../session/errors.js';
import { folderTrustDecision, GROK_FOLDER_TRUST_METHOD, parseNativeFolderTrustRequest } from './grokFolderTrust.js';
import { NativeSessionDecision, sessionDecisionError } from './request.js';

interface OpeningOwner {
  readonly sessionId: AgentSessionId;
  readonly workingDirectory: string;
  readonly interactions: AgentSessionInteractionContext;
  readonly limits: Readonly<AgentSessionInteractionLimits>;
  readonly removeAbort: () => void;
}

type BrokerState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'prepared' | 'dispatched'; owner: OpeningOwner }>
  | Readonly<{ kind: 'bound' | 'active' | 'open'; owner: OpeningOwner; nativeId: AgentProviderConversationId }>
  | Readonly<{ kind: 'stopped'; cause: Error }>;

export type SessionInteractionStop =
  | Readonly<{ kind: 'session_closed' }>
  | Readonly<{ kind: 'failed'; cause: Error }>;

/** One connection owns one create generation and one retained native decision. */
export class SessionInteractionBroker {
  private state: BrokerState = { kind: 'idle' };
  private requestNumber = 0;
  private retained: Readonly<{ decision: NativeSessionDecision; nativeId: AgentProviderConversationId }> | undefined;
  private readonly entered = new Set<NativeSessionDecision>();
  private openingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onStopped = () => {
    const cause: unknown = this.input.stopped.reason;
    this.stop({ kind: 'failed', cause: cause instanceof Error ? cause : new AcpProviderSessionError(
      'acp_session_interaction_native_failed', 'The native session decision producer stopped.') });
  };

  readonly handleRequest = (context: AcpReverseRequestContext): Promise<AcpJsonValue> => {
    try {
      if (context.method !== GROK_FOLDER_TRUST_METHOD) throw failure(
        'acp_session_interaction_invalid', 'The reverse request does not belong to the selected session mapping.');
      const native = parseNativeFolderTrustRequest(context.params);
      const state = this.state;
      if (state.kind === 'stopped') throw state.cause;
      if (state.kind === 'idle' || state.kind === 'prepared') throw failure(
        'acp_session_interaction_owner_missing', 'The native decision has no dispatched session opening owner.');
      if (this.retained) throw failure(
        'acp_session_interaction_capacity', 'The connection already retains a native session decision.');
      if (native.cwd !== state.owner.workingDirectory
        || ('nativeId' in state && native.sessionId !== state.nativeId)) throw failure(
        'acp_session_interaction_binding', 'The native decision does not match its exact session binding.');
      const expiresAt = Date.now() + state.owner.limits.requestTimeoutMs;
      const request = folderTrustDecision({ native, sessionId: state.owner.sessionId, requestNumber: ++this.requestNumber, expiresAt });
      const descriptorBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
      const nativeBytes = Buffer.byteLength(JSON.stringify(native), 'utf8');
      if (descriptorBytes > state.owner.limits.maxRetainedBytes
        || descriptorBytes + nativeBytes > this.input.limits.maxQueuedBytes) throw failure(
        'acp_session_interaction_capacity', 'The native session decision exceeds its retained byte budget.');
      const decision = new NativeSessionDecision({ request,
        nativeContext: Object.freeze({ id: context.id, signal: context.signal }), expiresAt,
        accepting: () => this.state.kind === 'active' || this.state.kind === 'open',
        fail: (cause) => this.stop({ kind: 'failed', cause }),
        retire: () => {
          if (this.retained?.decision === decision) this.retained = undefined;
          this.entered.delete(decision);
        },
      });
      this.retained = { decision, nativeId: native.sessionId };
      this.entered.add(decision);
      decision.observeNativeSignal();
      if (this.state.kind === 'active' || this.state.kind === 'open') decision.present(state.owner.interactions.onRequest);
      return decision.nativeReply;
    } catch (cause) {
      const error = cause instanceof Error ? cause : failure(
        'acp_session_interaction_invalid', 'The native session decision could not be admitted.', cause);
      this.stop({ kind: 'failed', cause: error });
      const rejected = Promise.reject<AcpJsonValue>(error);
      void rejected.catch(() => {});
      return rejected;
    }
  };

  constructor(private readonly input: Readonly<{
    stopped: AbortSignal;
    limits: AcpProviderLimits;
    onFailure: (cause: Error) => void;
  }>) {
    input.stopped.addEventListener('abort', this.onStopped, { once: true });
    if (input.stopped.aborted) this.onStopped();
  }

  prepareOpening(input: Readonly<{
    sessionId: AgentSessionId;
    workingDirectory: string;
    interactions: AgentSessionInteractionContext;
    signal?: AbortSignal;
  }>): void {
    throwIfAgentOperationAborted(input.signal);
    if (this.state.kind !== 'idle') throw this.stateError();
    const onAbort = () => this.stop({ kind: 'failed', cause: input.signal?.reason instanceof Error
      ? input.signal.reason : new DOMException('The session opening was aborted.', 'AbortError') });
    // The validated adapter facade supplies the context and bounded limits before connection acquisition.
    const owner: OpeningOwner = Object.freeze({
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
      interactions: input.interactions,
      limits: Object.freeze({ ...DEFAULT_AGENT_SESSION_INTERACTION_LIMITS, ...input.interactions.limits }),
      removeAbort: () => input.signal?.removeEventListener('abort', onAbort),
    });
    this.state = { kind: 'prepared', owner };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    this.throwIfStopped();
  }

  onOpeningDispatched(): void {
    if (this.state.kind !== 'prepared') throw this.stateError();
    this.state = { kind: 'dispatched', owner: this.state.owner };
    this.openingTimer = setTimeout(() => this.stop({ kind: 'failed', cause: failure(
      'acp_session_interaction_opening_timeout', 'The native decision opening did not bind before its deadline.') }),
    this.input.limits.initializationTimeoutMs);
  }

  bindNativeSession(nativeId: AgentProviderConversationId): void {
    if (this.state.kind !== 'dispatched') throw this.stateError();
    if (this.retained && this.retained.nativeId !== nativeId) {
      const cause = failure('acp_session_interaction_binding', 'The buffered decision claimed a different native session.');
      this.stop({ kind: 'failed', cause });
      throw cause;
    }
    this.state = { kind: 'bound', owner: this.state.owner, nativeId };
  }

  completeOpeningResponse(): void {
    if (this.state.kind !== 'bound') throw this.stateError();
    this.clearOpeningTimer();
    const owner = this.state.owner;
    this.state = { kind: 'active', owner, nativeId: this.state.nativeId };
    this.retained?.decision.present(owner.interactions.onRequest);
    this.throwIfStopped();
  }

  adopt(): void {
    if (this.state.kind !== 'active') throw this.stateError();
    this.state.owner.removeAbort();
    this.state = { kind: 'open', owner: this.state.owner, nativeId: this.state.nativeId };
  }

  stop(reason: SessionInteractionStop): void {
    if (this.state.kind === 'stopped') return;
    const cause = reason.kind === 'failed' ? reason.cause : failure(
      'acp_session_interaction_closed', 'The session decision owner was closed.');
    if (this.state.kind !== 'idle') this.state.owner.removeAbort();
    this.clearOpeningTimer();
    this.state = { kind: 'stopped', cause };
    this.retained?.decision.stop(reason.kind === 'failed'
      ? Object.freeze({ kind: 'failed', error: sessionDecisionError(
        'session_interaction_failed', 'The session decision owner failed.') })
      : Object.freeze({ kind: 'session_closed' }), cause);
    if (reason.kind === 'failed') this.input.onFailure(cause);
  }

  private clearOpeningTimer(): void {
    if (this.openingTimer) clearTimeout(this.openingTimer);
    this.openingTimer = undefined;
  }

  private stateError(): Error {
    return this.state.kind === 'stopped' ? this.state.cause : failure(
      'acp_session_interaction_binding', 'The native session interaction lifecycle is out of order.');
  }

  private throwIfStopped(): void {
    if (this.state.kind === 'stopped') throw this.state.cause;
  }

  async join(): Promise<void> {
    while (this.entered.size > 0) await Promise.all([...this.entered].map((decision) => decision.join()));
    if (this.state.kind === 'stopped') this.input.stopped.removeEventListener('abort', this.onStopped);
  }
}

function failure(reasonCode: string, message: string, cause?: unknown): AcpProviderSessionError {
  return new AcpProviderSessionError(reasonCode, message, cause === undefined ? undefined : { cause });
}
