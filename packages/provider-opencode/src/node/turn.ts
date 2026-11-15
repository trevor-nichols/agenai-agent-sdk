// ------------------------------------------------------------------------------------------------
//                turn.ts - One active turn: native observations, owned tool calls and host approvals
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { parseAgentItemId, type AgentError, type AgentSessionId, type AgentTurnId } from '@agen-ai/agent-protocol';
import type { AgentProviderOutput, AgentProviderResolveRequestInput, AgentRequestResolutionResult } from '@agen-ai/agent-runtime';
import type { NodeProviderToolResult, NodeProviderToolSession, NodeProviderToolStart } from '@agen-ai/provider-tools/node';
import { TurnApprovals, type TurnOutput } from './approvals.js';
import { TurnChannel } from './channel.js';
import { OWNED_TOOLS } from './config.js';
import type { PluginCall } from './endpoint.js';
import { completedItem, display, refusalDiagnostic, startedItem, turnError as error, turnEvents, TurnTexts, unstartedItem } from './events.js';
import type { NativeEvent } from './native-events.js';
import type { NativeSession, NativeSignal } from './native.js';
import { TurnUsage } from './turn-usage.js';
import type { OpenCodeTurnOutcome, OpenCodeUsage } from './usage.js';

type OrderedEvent = Extract<NativeEvent, { kind: 'text' | 'execution_started' | 'execution_succeeded' | 'execution_failed' | 'execution_interrupted' }>;
type QueuedCall = Readonly<{ kind: 'call'; call: PluginCall; controller: AbortController }>;

/** What the reader takes in order; cancellations, loss and fences act when they arrive instead. */
type Queued = Readonly<{ kind: 'output'; output: AgentProviderOutput }> | QueuedCall | Readonly<{ kind: 'event'; event: OrderedEvent }>;

export type TurnEnding = 'interrupted' | 'expired';
const INTERRUPT_CONFIRM_MS = 30_000;
const NATIVE_REFS = 4_096;
const ENDING_REFUSAL = 'Tool call refused: the turn is ending.';
const CANCELED = 'Tool call canceled before it ran.';
const OWNED = new Set(OWNED_TOOLS);

const overflowError = () => error('execution_limit', 'opencode_turn_output_overflow', 'The turn produced more observations than its bound and was stopped.');

export interface TurnHost {
  readonly sessionId: AgentSessionId;
  readonly tools: NodeProviderToolSession;
  readonly native: NativeSession;
  readonly usage: OpenCodeUsage;
  /** Native call identities seen in this session; a repeated identity is refused before entry. */
  readonly nativeRefs: Set<string>;
  /** Unsettled native control requests; every turn end and session close joins them. */
  readonly controls: Set<Promise<void>>;
  fail(reason: string): void;
}

export class ActiveTurn {
  readonly abort = new AbortController();
  ending: TurnEnding | undefined;
  private readonly channel = new TurnChannel<Queued>();
  private readonly approvals = new TurnApprovals((type, payload, options) => this.output(type, payload, options));
  /** Admitted calls from admission to settlement, so a cancellation that precedes entry is kept. */
  private readonly calls = new Map<number, AbortController>();
  private readonly texts;
  private inflight = 0;
  private prompted = false;
  private interruptWanted = false;
  private interruptSent = false;
  /** OpenCode reported this turn's execution result, or no execution was ever started. */
  private executionSettled = false;
  /** OpenCode's own execution result, which decides how completely its usage is known. */
  private nativeOutcome: OpenCodeTurnOutcome | undefined;
  private readonly usage: TurnUsage;
  private stopped = false;
  /** The reader takes no more native observations; only entered calls' outputs are still drained. */
  private finishing = false;
  private overflowHandled = false;
  private failure: AgentError | undefined;
  private fenceReported = false;
  private unconfirmed: NodeJS.Timeout | undefined;
  private readonly event;

  constructor(private readonly host: TurnHost, readonly turnId: AgentTurnId) {
    this.event = turnEvents(host.sessionId, turnId);
    this.texts = new TurnTexts(this.event);
    this.usage = new TurnUsage(host, turnId, this.event, (code, message) => this.refuseNative(code, message));
  }

  /** Takes one native signal; nothing that fences the session waits for the reader, paused or finalizing. */
  receive(signal: NativeSignal): void {
    if (signal.type === 'cancel') { this.calls.get(signal.id)?.abort(); return; }
    if (signal.type === 'failed') { this.lose(signal.reason); return; }
    if (signal.type === 'call') {
      if (signal.call.sessionID !== this.host.native.sessionID) {
        this.refuseNative('opencode_foreign_tool_call', 'OpenCode sent a tool call belonging to another session.');
        this.refuse(signal.call.id, 'Tool call refused: it belongs to another session.');
        return;
      }
      if (this.abort.signal.aborted) { this.refuse(signal.call.id, ENDING_REFUSAL); return; }
      const controller = new AbortController();
      this.calls.set(signal.call.id, controller);
      this.queue({ kind: 'call', call: signal.call, controller });
      return;
    }
    const event = signal.event;
    switch (event.kind) {
      case 'benign': return;
      case 'session_usage': case 'step_started': case 'step_ended': case 'step_failed':
        this.usage.account(event);
        return;
      case 'text': case 'execution_started': case 'execution_succeeded': case 'execution_failed': case 'execution_interrupted':
        if (!this.finishing) this.queue({ kind: 'event', event });
        return;
      case 'tool_input':
        if (!OWNED.has(event.name)) this.refuseNative('opencode_foreign_tool', `OpenCode reported a tool call outside the owned set: ${display(event.name, 200)}.`);
        return;
      case 'tool_called':
        if (event.executed) this.refuseNative('opencode_provider_executed_tool', 'The model provider executed a tool outside AgenAI ownership.');
        return;
      case 'permission_asked':
        this.control(this.host.native.rejectPermission(event.requestID));
        this.refuseNative('opencode_native_permission', 'OpenCode asked for a native permission outside the owned tools.');
        return;
      case 'form_created':
        this.control(this.host.native.cancelForm(event.formID));
        this.refuseNative('opencode_native_form', 'OpenCode opened a native form.');
        return;
      default:
        this.refuseNative('opencode_native_drift', `OpenCode reported ${event.kind === 'drift' ? display(event.type, 120) : event.kind} during a turn.`);
    }
  }

  /** Past the bound the turn fails at once: effects stop, OpenCode is interrupted and later calls are refused unentered. */
  private queue(item: Queued): void {
    if (this.channel.push(item)) return;
    if (item.kind === 'call') this.refuse(item.call.id, ENDING_REFUSAL);
    if (this.overflowHandled) return;
    this.overflowHandled = true;
    this.failure ??= overflowError();
    this.host.fail('turn_output_overflow');
    this.abort.abort();
    this.sendInterrupt();
  }

  /** Answers a call that never entered the broker and forgets its admission. */
  private refuse(id: number, text: string): void {
    this.calls.delete(id);
    try { this.host.native.reply(id, { text, isError: true }); } catch { /* the endpoint reports its own failure */ }
  }

  /** Owns one native control request until it settles; a failed request has an unknown effect and fences the session. */
  private control(request: Promise<unknown>, onFailure = () => this.host.fail('native_control_failed')): void {
    const settled: Promise<void> = request.then(() => undefined, onFailure).finally(() => this.host.controls.delete(settled));
    this.host.controls.add(settled);
  }

  /** Sent once, after the prompt and before OpenCode reports a result; `false` receipts settle with nothing interrupted. */
  private sendInterrupt(): void {
    this.interruptWanted = true;
    if (!this.prompted || this.interruptSent || this.executionSettled) return;
    this.interruptSent = true;
    this.control(this.host.native.interrupt(), () => {
      this.host.fail('interrupt_uncertain');
      this.stop('OpenCode did not accept the interruption.');
    });
  }

  /** The native event source or server is gone: effects stop at once and the session is fenced. */
  private lose(reason: string): void {
    this.failure ??= error('transport', 'opencode_native_failed', display(reason, 400));
    this.host.fail('native_failed');
    this.abort.abort();
    this.channel.wake();
  }

  private refuseNative(code: string, message: string): void {
    this.failure ??= error('protocol', code, message);
    this.host.fail(code);
    this.interrupt('interrupted');
    this.channel.wake();
  }

  private readonly output: TurnOutput = (type, payload, options) => {
    let output: AgentProviderOutput;
    try { output = this.event(type, payload, options); } catch {
      this.host.fail('event_invalid');
      this.stop(`The driver could not represent a ${type} observation.`);
      return;
    }
    this.queue({ kind: 'output', output });
  };

  /** Withdraws approvals and stops tools at once, then waits for OpenCode's own execution result. */
  interrupt(ending: TurnEnding): void {
    if (this.ending) return;
    this.ending = ending;
    this.abort.abort();
    this.sendInterrupt();
    if (this.finishing) return;
    this.unconfirmed = setTimeout(() => this.stop('OpenCode did not confirm the interruption in time.'), INTERRUPT_CONFIRM_MS);
    this.unconfirmed.unref();
  }

  /** Ends the turn without waiting for OpenCode; the session is no longer usable afterwards. */
  stop(reason: string): void {
    this.host.fail('turn_stopped');
    if (!this.ending) this.failure ??= error('provider', 'opencode_turn_stopped', reason);
    this.stopped = true;
    this.abort.abort();
    this.channel.wake();
  }

  /** The reader is gone: OpenCode is interrupted and later observations are no longer kept. */
  abandon(): void {
    this.finishing = true;
    this.usage.abandon();
    this.interrupt('interrupted');
  }

  resolveRequest(input: AgentProviderResolveRequestInput): AgentRequestResolutionResult {
    return this.approvals.resolve(input);
  }

  /** Runs one owned call to settlement and always answers the plugin exactly once. */
  private call({ call, controller }: QueuedCall): void {
    if (this.abort.signal.aborted || controller.signal.aborted) { this.refuse(call.id, controller.signal.aborted ? CANCELED : ENDING_REFUSAL); return; }
    this.inflight += 1;
    const signal = AbortSignal.any([this.abort.signal, controller.signal]);
    const reference = `${call.messageID}\u0000${call.callID}`;
    void (async () => {
      const itemId = parseAgentItemId(`opencode-item:${randomUUID()}`);
      let start: NodeProviderToolStart | undefined;
      let result: NodeProviderToolResult | undefined;
      try {
        if (this.host.nativeRefs.has(reference) || this.host.nativeRefs.size >= NATIVE_REFS) {
          if (this.host.nativeRefs.size >= NATIVE_REFS) this.host.fail('native_reference_bound');
          result = { tool: null, status: 'refused', text: 'Tool call refused: this native tool call was already dispatched.', isError: true, changes: [] };
        } else {
          this.host.nativeRefs.add(reference);
          result = await this.host.tools.call({ tool: call.tool, input: call.input, signal, observer: {
            started: (observed) => { start = observed; this.output('item.started', startedItem(itemId, observed)); },
            approve: (action, approvalSignal) => this.approvals.open(itemId, action, approvalSignal),
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
      try { this.host.native.reply(call.id, { text: result.text, isError: result.isError }); }
      catch { /* a failed endpoint is reported through its own signal */ }
    })().finally(() => {
      this.calls.delete(call.id);
      this.inflight -= 1;
      this.channel.wake();
    });
  }

  /** Yields observations until OpenCode reports the result or the turn stops, then joins calls and controls before the terminal result. */
  async *run(prompt: string, onStarted: (() => void) | undefined): AsyncGenerator<AgentProviderOutput> {
    yield this.event('turn.started', {});
    for (const output of this.usage.pending()) yield output;
    let succeeded = false;
    const unprompted = this.abort.signal.aborted;
    if (unprompted) this.executionSettled = true;
    else {
      try {
        await this.host.native.prompt(prompt);
        this.prompted = true;
        onStarted?.();
        if (this.interruptWanted) this.sendInterrupt();
      } catch {
        this.failure ??= error('transport', 'opencode_prompt_failed', 'OpenCode did not accept the prompt.');
        this.host.fail('prompt_failed');
      }
    }
    while (!this.executionSettled && !this.failure && !this.stopped) {
      const item = this.channel.take();
      if (item === undefined) { await this.channel.wait(); continue; }
      if (item.kind === 'output') { yield item.output; continue; }
      if (item.kind === 'call') { this.call(item); continue; }
      const event = item.event;
      if (event.kind === 'text') {
        const mapped = this.texts.map(event);
        if (Array.isArray(mapped)) for (const output of mapped) yield output;
        else this.refuseNative(mapped.code, mapped.message);
        continue;
      }
      if (event.kind === 'execution_started') continue;
      this.executionSettled = true;
      this.nativeOutcome = event.kind === 'execution_succeeded' ? 'succeeded' : event.kind === 'execution_interrupted' ? 'interrupted' : 'failed';
      if (event.kind === 'execution_succeeded') succeeded = true;
      else if (this.ending) continue;
      else if (event.kind === 'execution_interrupted') {
        this.failure ??= error('provider', 'opencode_turn_interrupted', 'OpenCode interrupted the turn without a request.');
        this.host.fail('native_interrupted');
      } else this.failure ??= error('provider', 'opencode_turn_failed', `OpenCode ended the turn without success: ${display(event.message, 400)}`);
    }
    this.finishing = true;
    clearTimeout(this.unconfirmed);
    this.abort.abort();
    for (;;) {
      const item = this.channel.take();
      if (item?.kind === 'output') yield item.output;
      else if (item?.kind === 'call') this.call(item);
      else if (item === undefined) {
        if (this.inflight === 0) break;
        await this.channel.wait();
      }
    }
    if (!this.failure) {
      const grants = await this.host.native.savedGrants().catch(() => -1);
      if (grants !== 0) {
        this.failure ??= error('protocol', 'opencode_saved_grants', 'OpenCode retained a permission grant.');
        this.host.fail('saved_grants');
      }
    }
    while (this.host.controls.size > 0) await Promise.all(this.host.controls);
    if (this.usage.failure) throw this.usage.failure;
    if (unprompted) this.usage.abandon(true);
    else {
      for (const output of await this.usage.settle(this.nativeOutcome, !this.stopped)) {
        if (this.usage.failure) throw this.usage.failure;
        yield output;
      }
    }
    if (this.usage.failure) throw this.usage.failure;
    const failure = this.failure;
    const outcome = failure ? 'failed' : this.ending === 'expired' ? 'expired' : this.ending === 'interrupted' || !succeeded ? 'canceled' : 'completed';
    yield this.event('turn.completed', { structuredOutput: { kind: 'not_requested' }, outcome, ...(failure ? { error: failure } : {}) });
    if (this.usage.failure) throw this.usage.failure;
  }
}
