import {
  createAcpStandardSessionOperations,
  AcpRpcHandlerError,
  type AcpJsonObject,
  type AcpJsonValue,
  type AcpNotificationContext,
  type AcpReverseRequestContext,
} from '@agen-ai/acp-transport';
import {
  parseAgentRequestId,
  type AgentSessionBinding,
  type AgentTurnCompletedPayload,
} from '@agen-ai/agent-protocol';
import {
  throwIfAgentOperationAborted,
  type AgentProviderInterruptTurnInput,
  type AgentProviderTurnInterruptionResult,
  type AgentProviderOutput,
  type AgentProviderResolveRequestInput,
  type AgentProviderStartTurnInput,
  type AgentProviderTurnExecution,
  type AgentRequestResolutionResult,
  type AgentProviderSession,
} from '@agen-ai/agent-runtime';

import type { CreateAcpProviderSessionInput } from './create.js';
import { AcpProviderSessionError, sessionError } from './errors.js';
import { TurnMapping } from './mapping.js';
import { createAcpSessionConfiguration } from '../configuration/control.js';
import { createAcpSessionEnvironment } from '../environment/commands.js';
import { prepareAcpPrompt } from './media.js';
import { AcpHistoryReplay, acpSessionControlClient, openAcpNativeSession } from './opening.js';
import { acpTurnCompletion } from './completion.js';
import { resolveAcpRequest } from './requests/resolution.js';
import { AcpFormFlow } from './requests/forms.js';
import { prepareAcpSessionElicitation } from './requests/elicitation.js';
import { canceledRequestReply, PendingSessionRequests, type PendingSessionRequest } from './requests/pending.js';
import { nativeBytes, nativeObject, nativeString, SESSION_METADATA_UPDATES } from './native.js';
import { deferred, SessionQueue, type QueueEntry } from './queue.js';
import type { NativeTurn, SessionMessage } from './turn.js';

export class SessionState {
  private readonly queue: SessionQueue<SessionMessage>;
  private readonly operations;
  private readonly requests: PendingSessionRequests;
  private readonly configuration;
  private readonly environment;
  private readonly replay: AcpHistoryReplay;
  private readonly opening: QueueEntry<SessionMessage>[] = [];
  private readonly detach: () => void;
  private readonly onStopped: () => void;
  private binding: AgentSessionBinding | undefined;
  private nativeSessionId: string | undefined;
  private turn: NativeTurn | undefined;
  private failure: Error | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private itemSequence = 0;
  private requestSequence = 0;

  constructor(private readonly input: CreateAcpProviderSessionInput) {
    this.queue = new SessionQueue(input.limits);
    this.replay = new AcpHistoryReplay(input.limits);
    this.operations = createAcpStandardSessionOperations(input.connection.client);
    this.requests = new PendingSessionRequests({
      maxPendingRequests: input.limits.maxPendingRequests,
      admit: (request, bytes) => this.queue.admit({ kind: 'request', request }, bytes),
      fail: (error) => this.fail(error),
    });
    this.configuration = createAcpSessionConfiguration({
      capability: input.capabilities.configuration, client: acpSessionControlClient(input),
      getSessionId: () => this.nativeSessionId!, assertUsable: () => this.requireUsable(), onFailure: (error) => this.fail(error),
      timeoutMs: input.limits.initializationTimeoutMs, maxSnapshotBytes: input.limits.maxQueuedBytes,
    });
    this.environment = createAcpSessionEnvironment({ limits: input.limits, now: input.now, signal: input.connection.stopped });
    this.onStopped = () => this.fail(sessionError(input.connection.stopped.reason));
    this.detach = input.connection.attachSession({
      onNotification: (context) => this.admitNotification(context),
      onPermissionRequest: (context) => this.admitRequest(context, 'permission'),
      onElicitationRequest: (context) => this.admitRequest(context, 'form'),
    });
    input.connection.stopped.addEventListener('abort', this.onStopped, { once: true });
    if (input.connection.stopped.aborted) this.onStopped();
  }

  async open(): Promise<AgentProviderSession> {
    this.requireUsable();
    throwIfAgentOperationAborted(this.input.context.signal);
    await openAcpNativeSession(this.input, {
      replay: this.replay,
      bind: (binding) => {
        this.binding = binding;
        this.nativeSessionId = binding.conversationId;
        this.bindHostSession();
      },
      observeSetup: (result) => {
        for (const entry of this.opening.splice(0)) {
          try {
            if (entry.value.kind === 'update') {
              this.assertNativeSession(entry.value.params);
              this.observeMetadata(nativeObject(entry.value.params.update, 'opening session update'));
            }
          } finally { entry.release(); }
        }
        this.configuration.observeSetup(result);
      },
    });
    this.requireUsable();
    if (!this.binding) throw new AcpProviderSessionError('acp_binding_missing', 'ACP did not return a session binding.');
    // Opening metadata is processed before exposing the public session, and never becomes turn output.
    await this.configuration.applyOpeningConfiguration(this.input.context.configuration, this.input.context.signal);
    const binding = this.binding;
    return Object.freeze({
      binding,
      startTurn: (input: AgentProviderStartTurnInput) => this.startTurn(input),
      interruption: Object.freeze({ kind: 'supported' as const, interruptTurn: (input: AgentProviderInterruptTurnInput) => this.interruptTurn(input) }),
      steering: Object.freeze({ kind: 'unsupported' as const }),
      configuration: this.configuration.control,
      operations: Object.freeze({ kind: 'unsupported' as const }),
      managedContent: Object.freeze({ kind: 'unsupported' as const }),
      environment: this.environment.port,
      collaboration: Object.freeze({ kind: 'unsupported' as const }),
      generatedResources: Object.freeze({ kind: 'unsupported' as const }),
      close: async () => this.close(),
    });
  }

  private requireUsable(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new AcpProviderSessionError('acp_session_closed', 'The ACP session is closed.');
  }

  private assertNativeSession(params: AcpJsonObject): void {
    if (this.nativeSessionId !== undefined && params.sessionId !== this.nativeSessionId) {
      throw new AcpProviderSessionError('acp_session_identity_mismatch', 'ACP traffic identifies a different native session.');
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.turn?.hostInteractions.abort(error);
    this.queue.fail(error);
    this.requests.cancelAll();
    this.environment.close();
    this.turn?.settled.reject(error);
    this.clearTurnTimers();
    void this.input.connection.close().catch(() => undefined);
  }

  private admitNotification(context: AcpNotificationContext): Promise<void> | void {
    this.requireUsable();
    const params = nativeObject(context.params, 'session notification');
    this.assertNativeSession(params);
    const update = nativeObject(params.update, 'session update');
    const kind = nativeString(update.sessionUpdate, 'session update kind');
    this.replay.observe(params);
    if (SESSION_METADATA_UPDATES.has(kind)) {
      if (this.nativeSessionId === undefined) {
        const entry = this.queue.admit({ kind: 'update', params }, nativeBytes(params) * 2);
        this.opening.push(entry);
        return entry.consumed;
      }
      this.observeMetadata(update);
      return;
    }
    if (this.replay.active) return;
    if (!this.turn || this.turn.nativeSettled || this.turn.terminal) {
      throw new AcpProviderSessionError('acp_update_without_prompt', 'ACP emitted turn content without an active native prompt.');
    }
    try {
      return this.queue.admit({ kind: 'update', params }, nativeBytes(params) * 2).consumed;
    } catch (error) {
      this.fail(sessionError(error));
      throw error;
    }
  }

  private bindHostSession(): void {
    this.input.connection.bindSession({ nativeSessionId: this.nativeSessionId!, sessionId: this.input.context.sessionId,
      workingDirectory: this.input.context.workingDirectory });
  }

  private observeMetadata(update: AcpJsonObject): void {
    if (this.configuration.observeUpdate(update)) return;
    if (update.sessionUpdate === 'available_commands_update') this.environment.observeCommands(update.availableCommands!);
    // Stable usage carries no confirmed compaction lifecycle; it cannot satisfy canonical context usage invariants.
  }

  private admitRequest(context: AcpReverseRequestContext, kind: PendingSessionRequest['kind']): Promise<AcpJsonValue> {
    this.requireUsable();
    const params = nativeObject(context.params, `${kind} request`);
    this.assertNativeSession(params);
    if (!this.turn || this.turn.nativeSettled || this.turn.terminal) {
      throw new AcpRpcHandlerError(-32600, 'ACP interaction requests require an active native prompt.');
    }
    if (this.turn.cancelReason !== undefined) return Promise.resolve(canceledRequestReply(kind));
    const prepared = kind === 'form' ? prepareAcpSessionElicitation({ context, params,
      lifetime: this.turn.hostInteractions.signal, host: this.input.connection.hostElicitation }) : undefined;
    return this.requests.admit(context, kind, params, prepared?.form, prepared?.host);
  }

  private clearTurnTimers(): void {
    for (const cleanup of this.turn?.cleanup.splice(0) ?? []) cleanup();
  }

  startTurn(input: AgentProviderStartTurnInput): AgentProviderTurnExecution {
    this.requireUsable();
    throwIfAgentOperationAborted(input.signal);
    if (this.turn && !this.turn.terminal) throw new AcpProviderSessionError('acp_turn_active', 'The ACP session already has an active or waiting turn.');
    if (input.interactionMode !== 'default') {
      throw new AcpProviderSessionError('acp_input_unsupported', 'ACP supports only the default interaction mode.');
    }
    const prompt = prepareAcpPrompt(input.parts, this.input.capabilities);
    const settled = deferred<AgentTurnCompletedPayload>();
    void settled.promise.catch(() => undefined);
    const turn: NativeTurn = {
      turnId: input.turnId,
      mapping: new TurnMapping({
        sessionId: this.input.context.sessionId,
        turnId: input.turnId,
        workingDirectory: this.input.context.workingDirectory,
        now: this.input.now,
        nextItemId: () => ++this.itemSequence,
        nextRequestId: () => ++this.requestSequence,
        reserveState: (value, extraBytes) => this.queue.reserveState(value, extraBytes),
      }),
      settled,
      cleanup: [],
      hostInteractions: new AbortController(),
      prompt: Promise.resolve(),
      nativeStarted: false,
      nativeSettled: false,
      terminal: false,
      waiting: undefined,
      transition: undefined,
      cancelReason: undefined,
      cancellation: undefined,
    };
    this.turn = turn;
    let acquired = false;
    const outputs = {
      [Symbol.asyncIterator]: () => {
        if (acquired) throw new AcpProviderSessionError('acp_turn_stream_owned', 'The ACP turn output already has a consumer.');
        acquired = true;
        return this.streamTurn(turn, input, prompt);
      },
    };
    return Object.freeze({ turnId: turn.turnId, outputs, resolveRequest: (resolution: AgentProviderResolveRequestInput) => this.resolveRequest(turn, resolution) });
  }

  private launchTurn(turn: NativeTurn, input: AgentProviderStartTurnInput, prompt: ReturnType<typeof prepareAcpPrompt>): void {
    this.requireUsable();
    throwIfAgentOperationAborted(input.signal);
    if (turn.nativeSettled) return;
    input.onProviderExecutionStarted?.();
    turn.nativeStarted = true;
    turn.prompt = this.operations.prompt({
      sessionId: this.nativeSessionId!,
      prompt,
    }, {
      timeoutMs: this.input.limits.promptTimeoutMs,
      onResponseReceived: (response) => {
        turn.nativeSettled = true;
        if (this.requests.size > 0) {
          this.fail(new AcpProviderSessionError('acp_terminal_with_request', 'ACP completed a prompt with unanswered interaction requests.'));
          return;
        }
        turn.hostInteractions.abort(new DOMException('The ACP native prompt settled.', 'AbortError'));
        this.clearTurnTimers();
        const payload = acpTurnCompletion(response, turn.cancelReason);
        this.queue.admit({ kind: 'terminal', payload }, nativeBytes(payload), true);
        turn.settled.resolve(payload);
      },
    }).then(() => undefined, (error) => {
      if (!turn.nativeSettled) this.fail(sessionError(error));
    });
    const cancel = (reason: 'user_requested' | 'timeout') => {
      void this.cancelNative(turn, reason).catch((error) => this.fail(sessionError(error)));
    };
    if (input.signal) {
      const abort = () => cancel('user_requested');
      input.signal.addEventListener('abort', abort, { once: true });
      turn.cleanup.push(() => input.signal!.removeEventListener('abort', abort));
      if (input.signal.aborted) abort();
    }
    if (input.deadlineAt !== undefined) {
      const timer = setTimeout(() => cancel('timeout'), Math.min(2_147_483_647, Math.max(0, Date.parse(input.deadlineAt) - Date.now())));
      turn.cleanup.push(() => clearTimeout(timer));
    }
  }

  private async *emit(output: AgentProviderOutput): AsyncGenerator<AgentProviderOutput> {
    if (this.turn?.terminal) return;
    this.requireUsable();
    const release = this.queue.reserveOutput(output);
    try { yield output; }
    finally { release(); }
  }

  private async *drain(turn: NativeTurn): AsyncGenerator<AgentProviderOutput, 'terminal'> {
    for (;;) {
      if (turn.terminal) return 'terminal';
      this.requireUsable();
      if (turn.transition) {
        const transition = turn.transition;
        turn.transition = undefined;
        yield* this.emit(turn.mapping.event('turn.state_changed', { state: 'running' }));
        if (transition.nextRequest && !transition.nextRequest.answered && !turn.cancelReason) {
          turn.waiting = transition.nextRequest;
          yield* this.offerRequest(turn, transition.nextRequest);
        }
        continue;
      }
      const entry = await this.queue.take(
        () => turn.terminal || turn.transition !== undefined,
        (message) => message.kind !== 'request' || turn.waiting === undefined,
      );
      if (!entry) continue;
      if (turn.terminal) { entry.release(); return 'terminal'; }
      const message = entry.value;
      if (message.kind === 'update') {
        try {
          this.assertNativeSession(message.params);
          for (const output of turn.mapping.update(nativeObject(message.params.update, 'session update'))) {
            if (turn.terminal) return 'terminal';
            yield* this.emit(output);
            if (turn.terminal) return 'terminal';
          }
        } finally { entry.release(); }
      } else if (message.kind === 'request') {
        const request = message.request;
        if (request.answered || turn.cancelReason) { entry.release(); continue; }
        if (request.kind === 'permission') {
          const mappedTool = turn.mapping.tool(nativeObject(request.params.toolCall, 'permission tool'), true);
          let next = mappedTool.next();
          while (!next.done) {
            if (turn.terminal) return 'terminal';
            yield* this.emit(next.value);
            if (turn.terminal) return 'terminal';
            next = mappedTool.next();
          }
          const permission = turn.mapping.permission(request.params, next.value);
          request.mapped = { kind: 'permission', permission, request: permission.request };
        } else {
          if (request.params.toolCallId != null && !turn.mapping.hasTool(nativeString(request.params.toolCallId, 'elicitation tool identity'))) {
            this.requests.reject(request, new AcpRpcHandlerError(-32602, 'ACP form tool identity was not observed in this turn.'));
            continue;
          }
          if (request.host) {
            void (async () => request.host!())().then((result) => this.requests.answer(request, result), (error) => this.requests.reject(request, sessionError(error)));
            continue;
          }
          const flow = new AcpFormFlow(request.form!, () => parseAgentRequestId(`acp:request:${++this.requestSequence}`));
          request.mapped = { kind: 'form', flow, request: flow.request };
        }
        turn.waiting = request;
        yield* this.offerRequest(turn, request);
        if (turn.terminal) return 'terminal';
        continue;
      } else {
        try {
          if (this.requests.size > 0) throw new AcpProviderSessionError('acp_terminal_with_request', 'ACP completed a prompt with unanswered interaction requests.');
          for (const output of turn.mapping.complete(message.payload)) {
            if (turn.terminal) return 'terminal';
            yield* this.emit(output);
            if (turn.terminal) return 'terminal';
          }
          turn.terminal = true;
          turn.waiting = undefined;
          turn.mapping.release();
          this.clearTurnTimers();
          return 'terminal';
        } finally { entry.release(); }
      }
    }
  }

  private async *offerRequest(turn: NativeTurn, request: PendingSessionRequest): AsyncGenerator<AgentProviderOutput> {
    const canonical = request.mapped!.request;
    yield* this.emit(turn.mapping.event('request.opened', { request: canonical }));
    if (turn.terminal) return;
    yield* this.emit(turn.mapping.event('turn.state_changed', { state: 'waiting_for_request', requestId: canonical.requestId }));
  }

  private async *streamTurn(turn: NativeTurn, input: AgentProviderStartTurnInput, prompt: ReturnType<typeof prepareAcpPrompt>): AsyncGenerator<AgentProviderOutput> {
    let stable = false;
    try {
      this.launchTurn(turn, input, prompt);
      yield* this.emit(turn.mapping.event('turn.started', {}));
      yield* this.drain(turn);
      stable = true;
    } catch (error) { this.fail(sessionError(error)); throw error; }
    finally {
      if (!stable && !this.closed) this.fail(new AcpProviderSessionError('acp_turn_abandoned', 'The ACP turn stream was abandoned before a stable boundary.'));
    }
  }

  private async resolveRequest(turn: NativeTurn, input: AgentProviderResolveRequestInput): Promise<AgentRequestResolutionResult> {
    throwIfAgentOperationAborted(input.signal);
    const request = turn.waiting;
    if (this.turn !== turn || turn.terminal || !request?.mapped) {
      throw new AcpProviderSessionError('acp_request_not_pending', 'The ACP resolution does not identify an available pending request.');
    }
    const result = resolveAcpRequest(this.requests, turn, request, request.mapped, input);
    if (result.status === 'delivered') this.queue.wakeReader();
    return result;
  }

  private cancelNative(turn: NativeTurn, reason: NativeTurn['cancelReason']): Promise<void> {
    if (turn.cancellation) return turn.cancellation;
    if (turn.nativeSettled) return Promise.resolve();
    turn.cancelReason = reason;
    this.requests.cancelAll();
    turn.hostInteractions.abort(new DOMException('The ACP turn was canceled.', 'AbortError'));
    if (!turn.nativeStarted) {
      const payload: AgentTurnCompletedPayload = { outcome: reason === 'timeout' ? 'expired' : 'canceled' };
      turn.nativeSettled = true;
      this.queue.admit({ kind: 'terminal', payload }, nativeBytes(payload), true);
      turn.settled.resolve(payload);
      return Promise.resolve();
    }
    turn.cancellation = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await this.operations.cancel({ sessionId: this.nativeSessionId! });
            await turn.settled.promise;
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new AcpProviderSessionError('acp_cancel_uncertain', 'The ACP cancellation deadline elapsed without native confirmation.')), this.input.limits.cancellationTimeoutMs);
          }),
        ]);
      } finally { if (timeout) clearTimeout(timeout); }
    })();
    return turn.cancellation;
  }

  async interruptTurn(input: AgentProviderInterruptTurnInput): Promise<AgentProviderTurnInterruptionResult> {
    this.requireUsable();
    throwIfAgentOperationAborted(input.signal);
    const turn = this.turn;
    if (!turn || turn.turnId !== input.turnId || turn.terminal) throw new AcpProviderSessionError('acp_turn_mismatch', 'The ACP interruption does not identify the active turn.');
    if (turn.nativeSettled) return {
      status: 'failed',
      error: { category: 'invalid_request', code: 'acp_native_turn_settled', message: 'The native prompt has already settled; its existing output stream must finish.', recovery: { kind: 'none' } },
    };
    try {
      await this.cancelNative(turn, input.reason);
      const payload = await turn.settled.promise;
      return {
        status: payload.outcome === 'failed' ? 'failed'
          : payload.outcome === 'canceled' || payload.outcome === 'expired' ? 'canceled' : 'completed',
        ...(payload.error === undefined ? {} : { error: payload.error }),
      };
    } catch (error) { this.fail(sessionError(error)); throw error; }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.resolve().then(async () => {
      await this.input.closeResources();
      this.input.onClosed();
    }).catch((error) => { this.closePromise = undefined; throw error; });
    const error = new AcpProviderSessionError('acp_session_closed', 'The ACP session is closed.');
    this.turn?.hostInteractions.abort(error);
    this.queue.fail(error);
    this.requests.cancelAll();
    this.turn?.settled.reject(error);
    this.clearTurnTimers();
    this.environment.close();
    this.turn?.mapping.release();
    this.detach();
    this.input.connection.stopped.removeEventListener('abort', this.onStopped);
    return this.closePromise;
  }
}
