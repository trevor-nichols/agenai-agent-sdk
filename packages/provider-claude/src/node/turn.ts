// ------------------------------------------------------------------------------------------------
//                turn.ts - One active turn: worker observations, owned tool calls and host approvals
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  parseAgentItemId, parseAgentRequestId, parseAgentRequestResolutionFor, type AgentError, type AgentItemId, type AgentRequest,
  type AgentProviderKey, type AgentSessionId, type AgentTurnId,
} from '@agen-ai/agent-protocol';
import {
  AgentProviderContractError, chunkAgentCanonicalText, type AgentProviderOutput, type AgentProviderResolveRequestInput, type AgentRequestResolutionResult,
} from '@agen-ai/agent-runtime';
import type { NodeProviderToolApprovalRequest, NodeProviderToolResult, NodeProviderToolSession, NodeProviderToolStart } from '@agen-ai/provider-tools/node';
import { revocationFor, type BoundConfiguration } from './authority.js';
import { TurnChannel } from './channel.js';
import { APPROVE_ONCE, buildApproval, completedItem, display, refusalDiagnostic, startedItem, turnEvents, unstartedItem } from './events.js';
import type { WorkerEvent, WorkerProcess } from './process.js';
import { MCP_SERVER } from './protocol.js';
import type { ClaudeUsage } from './usage.js';

type OrderedEvent = Extract<WorkerEvent, { type: 'tool_call' | 'assistant_text' | 'residual' | 'result' }>;

/** Bounded and droppable once the bound overflows. */
export type TurnData =
  | Readonly<{ kind: 'worker'; event: OrderedEvent }>
  | Readonly<{ kind: 'output'; output: AgentProviderOutput }>;

/** What the reader receives: queued data first, then control state that is never dropped. */
type TurnSignal =
  | TurnData
  | Readonly<{ kind: 'call_settled' }>
  | Readonly<{ kind: 'terminated' }>;

export type TurnEnding = 'interrupted' | 'expired';
const INTERRUPT_CONFIRM_MS = 30_000;
const NATIVE_REFS = 4_096;
const ENDING_REFUSAL = 'Tool call refused: the turn is ending.';

const error = (category: AgentError['category'], code: string, message: string): AgentError =>
  ({ category, code, message, recovery: { kind: 'unknown' } });
const overflowError = () => error('execution_limit', 'claude_turn_output_overflow', 'The turn produced more observations than its bound and was stopped.');

interface PendingRequest { readonly request: AgentRequest; readonly decide: (decision: 'approved' | 'denied') => void }

export interface TurnHost extends BoundConfiguration {
  readonly providerKey: AgentProviderKey;
  readonly sessionId: AgentSessionId;
  readonly tools: NodeProviderToolSession;
  readonly worker: WorkerProcess;
  /** Native tool-use references seen in this session; a repeated reference is refused before entry. */
  readonly nativeRefs: Set<string>;
  /** The session's one native query: its usage series spans every turn. */
  readonly usage: ClaudeUsage;
  fail(reason: string): void;
}

export class ActiveTurn {
  readonly abort = new AbortController();
  ending: TurnEnding | undefined;
  private readonly channel = new TurnChannel<TurnData>();
  private readonly requests = new Map<string, PendingRequest>();
  private inflight = 0;
  private settledCalls = 0;
  /** The first revoking failure or stop, recorded when it arrives; `error` is how the turn then fails, if it does. */
  private termination: Readonly<{ error: AgentError | undefined }> | undefined;
  private terminationDelivered = false;
  private fenceReported = false;
  private unconfirmed: NodeJS.Timeout | undefined;
  private result: Extract<WorkerEvent, { type: 'result' }> | undefined;
  private contractFailure: AgentProviderContractError | undefined;
  private readonly event;

  constructor(private readonly host: TurnHost, readonly turnId: AgentTurnId) {
    this.event = turnEvents(host.sessionId, turnId);
  }

  /**
   * Takes one worker observation as it arrives. Drift and worker loss act here, whatever the reader is
   * doing: the session is fenced, effects are aborted, pending approvals withdrawn and later calls refused unentered.
   */
  admit(event: WorkerEvent): void {
    const revocation = revocationFor(this.host, event);
    if (revocation) this.revoke(revocation.error, revocation.reason);
    else if (event.type === 'tool_call' && this.abort.signal.aborted) this.refuse(event.callId);
    else if (event.type === 'tool_call' || event.type === 'assistant_text' || event.type === 'residual' || event.type === 'result') {
      if (event.type === 'result') {
        if (this.result) {
          if (!isDeepStrictEqual(this.result, event)) {
            const code = this.result.resultIndex === event.resultIndex ? 'usage_identity_conflict' : 'usage_sequence_invalid';
            const message = 'Claude reported conflicting results for the same prompted turn.';
            this.contractFailure ??= new AgentProviderContractError(this.host.providerKey, code, message);
            this.revoke(error('protocol', code, message), code);
          }
          return;
        }
        this.result = event;
      }
      this.push({ kind: 'worker', event });
    }
  }

  /** Queues data for the reader. Past the bound the turn fails at once and later data is dropped. */
  private push(data: TurnData): void {
    if (this.channel.push(data)) return;
    this.revoke(overflowError(), 'turn_output_overflow');
    if (data.kind === 'worker' && data.event.type === 'tool_call') this.refuse(data.event.callId);
  }

  private refuse(callId: string): void {
    try { this.host.worker.send({ type: 'tool_result', callId, text: ENDING_REFUSAL, isError: true }); }
    catch { /* a failed worker is reported through its own transport event */ }
  }

  /** Keeps the first termination only; later failures still fence the session through `host.fail`. */
  private terminate(failure: AgentError | undefined): boolean {
    if (this.termination) return false;
    this.termination = Object.freeze({ error: failure });
    this.withdraw();
    this.abort.abort();
    this.channel.wake();
    return true;
  }

  private revoke(failure: AgentError, reason: string): void {
    this.host.fail(reason);
    if (this.terminate(failure) && !this.ending) {
      try { this.host.worker.send({ type: 'interrupt' }); } catch { /* reported by the worker transport */ }
    }
  }

  /** Withdraws every pending approval now, so no later host answer reaches its call. */
  private withdraw(): void {
    for (const [requestId, pending] of [...this.requests]) {
      this.requests.delete(requestId);
      this.output('request.unavailable', { requestId, reason: 'withdrawn' });
      this.output('turn.state_changed', { state: 'running' });
      pending.decide('denied');
    }
  }

  private async next(): Promise<TurnSignal> {
    while (true) {
      const data = this.channel.take();
      if (data !== undefined) return data;
      if (this.settledCalls > 0) { this.settledCalls -= 1; return { kind: 'call_settled' }; }
      if (this.termination && !this.terminationDelivered) { this.terminationDelivered = true; return { kind: 'terminated' }; }
      await this.channel.wait();
    }
  }

  private output(type: string, payload: unknown, options?: Parameters<ReturnType<typeof turnEvents>>[2]): void {
    let output: AgentProviderOutput;
    try { output = this.event(type, payload, options); } catch {
      this.host.fail('event_invalid');
      this.stop(`The driver could not represent a ${type} observation.`);
      return;
    }
    this.push({ kind: 'output', output });
  }

  /** Withdraws approvals and stops tools at once, then waits for Claude's own turn result. */
  interrupt(ending: TurnEnding): void {
    if (this.ending) return;
    this.ending = ending;
    this.abort.abort();
    try { this.host.worker.send({ type: 'interrupt' }); } catch { /* reported by the worker transport */ }
    this.unconfirmed = setTimeout(() => this.stop('Claude did not confirm the interruption in time.'), INTERRUPT_CONFIRM_MS);
    this.unconfirmed.unref();
  }

  /** Ends the turn without waiting for Claude; the session is no longer usable afterwards. */
  stop(reason: string): void {
    this.host.fail('turn_stopped');
    this.terminate(this.ending ? undefined : error('provider', 'claude_turn_stopped', reason));
  }

  resolveRequest(input: AgentProviderResolveRequestInput): AgentRequestResolutionResult {
    const pending = this.requests.get(input.resolution.requestId);
    if (!pending) return { status: 'rejected', requestState: 'unavailable', error: error('invalid_request', 'request_unavailable', 'The approval request is no longer pending.') };
    let resolution;
    try { resolution = parseAgentRequestResolutionFor(pending.request, input.resolution); } catch {
      return { status: 'rejected', requestState: 'pending', error: error('invalid_request', 'resolution_invalid', 'The resolution does not answer this approval request.') };
    }
    input.onProviderExecutionStarted?.();
    this.requests.delete(resolution.requestId);
    this.output('turn.state_changed', { state: 'running' });
    pending.decide(resolution.disposition === 'selected' && resolution.optionId === APPROVE_ONCE ? 'approved' : 'denied');
    return { status: 'delivered' };
  }

  private approve(itemId: AgentItemId, action: NodeProviderToolApprovalRequest, signal: AbortSignal): Promise<'approved' | 'denied'> {
    const requestId = parseAgentRequestId(`claude-request:${randomUUID()}`);
    const built = buildApproval(requestId, itemId, action);
    if (!built || signal.aborted || this.abort.signal.aborted) {
      if (!built) this.output('provider.diagnostic', { code: 'approval_action_oversized', message: 'The exact action exceeds the approval context bound and was refused.' });
      return Promise.resolve('denied');
    }
    return new Promise((resolve) => {
      this.requests.set(requestId, { request: built.request, decide: resolve });
      this.output('request.opened', { request: built.request }, { requestContext: built.context });
      this.output('turn.state_changed', { state: 'waiting_for_request', requestId });
      signal.addEventListener('abort', () => {
        if (!this.requests.delete(requestId)) return;
        this.output('request.unavailable', { requestId, reason: signal.reason === 'expired' ? 'expired' : 'withdrawn' });
        this.output('turn.state_changed', { state: 'running' });
        resolve('denied');
      }, { once: true });
    });
  }

  /** Runs one owned call to settlement and always answers the worker exactly once. */
  private call(event: Extract<WorkerEvent, { type: 'tool_call' }>): void {
    if (this.abort.signal.aborted) { this.refuse(event.callId); return; }
    this.inflight += 1;
    if (this.host.nativeRefs.size >= NATIVE_REFS) this.host.fail('native_reference_bound');
    void (async () => {
      const itemId = parseAgentItemId(`claude-item:${randomUUID()}`);
      let start: NodeProviderToolStart | undefined;
      let result: NodeProviderToolResult | undefined;
      try {
        if (event.nativeRef !== null && this.host.nativeRefs.has(event.nativeRef) || this.host.nativeRefs.size >= NATIVE_REFS) {
          result = { tool: null, status: 'refused', text: 'Tool call refused: this native tool use was already dispatched.', isError: true, changes: [] };
        } else {
          if (event.nativeRef !== null) this.host.nativeRefs.add(event.nativeRef);
          result = await this.host.tools.call({ tool: event.tool, input: event.input, signal: this.abort.signal, observer: {
            started: (observed) => { start = observed; this.output('item.started', startedItem(itemId, observed)); },
            approve: (action, signal) => this.approve(itemId, action, signal),
          } });
        }
      } catch {
        result = { tool: null, status: 'failed', text: 'Tool call failed before it settled.', isError: true, changes: [] };
      }
      if (start) this.output('item.completed', completedItem(itemId, start, result));
      else {
        const { started, completed } = unstartedItem(itemId, result);
        this.output('item.started', started);
        this.output('item.completed', completed);
      }
      if (result.refusal) this.output('provider.diagnostic', refusalDiagnostic(result.refusal, result.tool));
      if (result.fence && !this.fenceReported) {
        this.fenceReported = true;
        this.output('runtime.warning', { code: 'tool_session_fenced', message: `Later tool effects are refused (${result.fence}).` });
      }
      try { this.host.worker.send({ type: 'tool_result', callId: event.callId, text: result.text, isError: result.isError }); }
      catch { /* a failed worker is reported through its own transport event */ }
    })().finally(() => {
      this.settledCalls += 1;
      this.channel.wake();
    });
  }

  /** Usage is reported once the turn's work has settled; a report it cannot represent fails the session. */
  private usage(result: Extract<WorkerEvent, { type: 'result' }> | undefined, interrupted: boolean): AgentProviderOutput[] {
    try {
      return this.host.usage.observe(this.turnId, result, interrupted).map((observation) => this.event('usage.observed', observation));
    } catch (cause) {
      this.host.fail(cause instanceof AgentProviderContractError ? cause.code : 'usage_invalid');
      throw cause;
    }
  }

  /**
   * Yields the turn's observations until the worker reports the turn result or the turn terminates,
   * then joins entered calls and reports the turn's usage. A termination recorded while calls settle
   * still decides the outcome.
   */
  async *run(prompt: string, onStarted: (() => void) | undefined): AsyncGenerator<AgentProviderOutput> {
    yield this.event('turn.started', {});
    let unsuccessful: AgentError | undefined;
    let succeeded = false;
    let assistantItem: AgentItemId | undefined;
    let result: Extract<WorkerEvent, { type: 'result' }> | undefined;
    let interruptedBeforeResult = false;
    let prompted = false;
    let settled = this.abort.signal.aborted;
    if (!settled) {
      try { this.host.worker.send({ type: 'prompt', text: prompt }); prompted = true; onStarted?.(); } catch {
        this.revoke(error('transport', 'claude_worker_unavailable', 'The Claude worker no longer accepts prompts.'), 'worker_unavailable');
      }
    }
    while (!settled) {
      const signal = await this.next();
      if (signal.kind === 'output') { yield signal.output; continue; }
      if (signal.kind === 'call_settled') { this.inflight -= 1; continue; }
      if (signal.kind === 'terminated') break;
      const event = signal.event;
      if (event.type === 'tool_call') this.call(event);
      else if (event.type === 'assistant_text') {
        if (!assistantItem) {
          assistantItem = parseAgentItemId(`claude-item:${randomUUID()}`);
          yield this.event('item.started', { itemId: assistantItem, itemKind: 'assistant_message', status: 'in_progress' });
        }
        for (const delta of chunkAgentCanonicalText(event.text)) {
          yield this.event('content.delta', { itemId: assistantItem, streamKind: 'assistant_text', delta });
        }
        if (event.complete) {
          yield this.event('item.completed', { itemId: assistantItem, itemKind: 'assistant_message', status: 'completed' });
          assistantItem = undefined;
        }
      } else if (event.type === 'residual') {
        yield this.event('provider.diagnostic', { code: 'residual_tool_denied', message: `Denied non-owned tool ${display(event.tool, 200)}.` });
      } else {
        settled = true;
        result = event;
        interruptedBeforeResult = this.ending !== undefined;
        succeeded = event.subtype === 'success' && !event.isError;
        if (!succeeded && !this.ending) {
          unsuccessful = event.subtype === 'error_max_turns'
            ? error('execution_limit', 'claude_max_turns', 'Claude reached the turn bound.')
            : event.subtype === 'error_max_budget_usd'
              ? error('execution_limit', 'claude_max_budget_usd', 'Claude reached the session cost budget.')
              : error('provider', 'claude_turn_failed', 'Claude ended the turn without success.');
        }
      }
    }
    clearTimeout(this.unconfirmed);
    this.abort.abort();
    while (this.inflight > 0) {
      const signal = await this.next();
      if (signal.kind === 'output') yield signal.output;
      else if (signal.kind === 'call_settled') this.inflight -= 1;
      else if (signal.kind === 'worker' && signal.event.type === 'tool_call') this.call(signal.event);
    }
    if (this.contractFailure) throw this.contractFailure;
    if (prompted) {
      for (const output of this.usage(result, interruptedBeforeResult)) {
        if (this.contractFailure) throw this.contractFailure;
        yield output;
      }
    }
    if (this.contractFailure) throw this.contractFailure;
    const failure = this.termination?.error ?? unsuccessful;
    const outcome = failure ? 'failed' : this.ending === 'expired' ? 'expired' : this.ending === 'interrupted' || !succeeded ? 'canceled' : 'completed';
    yield this.event('turn.completed', { structuredOutput: { kind: 'not_requested' }, outcome, ...(failure ? { error: failure } : {}) });
    if (this.contractFailure) throw this.contractFailure;
  }
}

export const ownedToolNames = (names: readonly string[]) => new Set(names.map((name) => `mcp__${MCP_SERVER}__${name}`));
