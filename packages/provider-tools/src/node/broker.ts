// ------------------------------------------------------------------------------------------------
//                broker.ts - The sole serial owner of one session's tool decisions and effects
// ------------------------------------------------------------------------------------------------

import { NodeProviderToolsError } from '../errors.js';
import type { NodeProviderToolName } from '../types.js';
import { runCommand } from './command.js';
import type {
  NodeProviderEditApproval, NodeProviderToolApprovalRequest, NodeProviderToolCallInput, NodeProviderToolObserver, NodeProviderToolResult,
  NodeProviderToolSession, NodeProviderToolStart,
} from './contracts.js';
import { parseToolCall, type ToolCall } from './definitions.js';
import {
  editTool, notApproved, patchTool, readFileTool, refused, refusedAs, writeTool, type ApprovalAnswer, type OperationContext, type OperationOutcome,
} from './files.js';
import type { HelperProcess } from './helper.js';
import type { VerifiedExecutable } from './identity.js';
import { FIXED_TOOL_LIMITS, type ParsedToolOptions } from './options.js';
import type { FileRestrictions } from './restrictions.js';
import { globTool, grepTool } from './search.js';

export interface ToolSessionInput {
  readonly helper: HelperProcess;
  readonly bubblewrap: VerifiedExecutable;
  readonly restrictions: FileRestrictions;
  readonly options: ParsedToolOptions;
  readonly editApproval: NodeProviderEditApproval;
}

function clip(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= FIXED_TOOL_LIMITS.resultBytes) return text;
  return `${new TextDecoder().decode(bytes.subarray(0, FIXED_TOOL_LIMITS.resultBytes - 64)).replace(/\uFFFD+$/u, '')}\n[result truncated]`;
}

export class ToolSession implements NodeProviderToolSession {
  private fenceReason: string | undefined;
  private closed = false;
  private admitted = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();
  private readonly settledFiles = new AbortController().signal;
  private readonly unsettled: (() => Promise<void>)[] = [];
  private helperClosed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly input: ToolSessionInput) {}

  get fence(): string | undefined { return this.fenceReason; }

  idle(): Promise<void> { return this.tail; }

  call(input: NodeProviderToolCallInput): Promise<NodeProviderToolResult> {
    if (this.closed) return Promise.resolve(this.result(null, refusedAs('unavailable', 'Tool call refused: the tool session is closed.')));
    if (this.admitted >= this.input.options.limits.pendingCalls) {
      return Promise.resolve(this.result(null, refusedAs('unavailable', 'Tool call refused: too many tool calls are already pending.')));
    }
    this.admitted += 1;
    const signal = AbortSignal.any([input.signal, this.lifetime.signal]);
    let entered = false;
    const run = this.tail.then(() => { entered = true; return this.enter(input, signal); });
    this.tail = run.then(() => {}, () => {});
    const early = new Promise<NodeProviderToolResult>((resolve) => {
      const abort = () => { if (!entered) resolve(this.result(null, refused('Tool call canceled before it ran.', 'canceled'))); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      const detach = () => signal.removeEventListener('abort', abort);
      void run.then(detach, detach);
    });
    const release = () => { this.admitted -= 1; };
    void run.then(release, release);
    return Promise.race([run, early]);
  }

  /**
   * Refuses new calls, withdraws approvals, stops commands and joins them, and closes the helper once.
   * Every unsettled namespace stays retained and the close keeps rejecting until each is proven gone.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort(new NodeProviderToolsError('closed', 'The tool session is closing.'));
    const actual = (async () => {
      await this.tail;
      const errors: unknown[] = [];
      for (const settle of [...this.unsettled]) {
        try {
          await settle();
          this.unsettled.splice(this.unsettled.indexOf(settle), 1);
        } catch (error) { errors.push(error); }
      }
      if (!this.helperClosed) {
        try {
          await this.input.helper.close();
          this.helperClosed = true;
        } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        const code = errors[0] instanceof NodeProviderToolsError ? errors[0].code : 'helper_unavailable';
        throw new NodeProviderToolsError(code, 'The tool session did not settle.', { cause: new AggregateError(errors) });
      }
    })();
    this.closing = actual;
    void actual.catch(() => { this.closing = undefined; });
    return actual;
  }

  private result(tool: NodeProviderToolName | null, outcome: OperationOutcome, extra: Partial<NodeProviderToolResult> = {}): NodeProviderToolResult {
    return Object.freeze({
      tool, status: outcome.status, text: clip(outcome.text), isError: outcome.status !== 'completed', ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
      changes: Object.freeze([...(outcome.changes ?? [])]), ...extra,
      ...(outcome.fence ?? this.fenceReason ? { fence: outcome.fence ?? this.fenceReason } : {}),
    });
  }

  private async enter(input: NodeProviderToolCallInput, signal: AbortSignal): Promise<NodeProviderToolResult> {
    if (signal.aborted) return this.result(null, refused('Tool call canceled before it ran.', 'canceled'));
    const parsed = parseToolCall(input.tool, input.input);
    const tool = parsed.ok ? parsed.call.tool : null;
    if (this.fenceReason) return this.result(tool, refusedAs('unavailable', `Tool call refused: the session is fenced (${this.fenceReason}).`));
    if (!parsed.ok) return this.result(null, refusedAs('invalid_input', `Tool call refused: ${parsed.reason}.`));
    const { call } = parsed;
    let reported = false;
    const context: OperationContext = {
      client: this.input.helper.client,
      restrictions: this.input.restrictions,
      workspace: this.input.options.workspaceDirectory,
      limits: this.input.options.limits,
      editApproval: this.input.editApproval,
      signal: this.settledFiles,
      cancellation: signal,
      started: (start: NodeProviderToolStart) => { if (!reported) { reported = true; input.observer.started(start); } },
      approve: (request) => this.approve(input.observer, request, signal),
    };
    let outcome: OperationOutcome;
    let extra: Partial<NodeProviderToolResult> = {};
    try {
      if (call.tool === 'bash') ({ outcome, extra } = await this.command(context, call, signal));
      else outcome = await this.dispatch(context, call);
    } catch (cause) {
      const reason = cause instanceof NodeProviderToolsError ? cause.code : 'helper_failed';
      outcome = { status: 'failed', text: 'Tool failed before it settled; the session is fenced.', fence: reason };
    }
    if (outcome.fence) this.fenceReason ??= outcome.fence;
    return this.result(call.tool, outcome, extra);
  }

  private dispatch(context: OperationContext, call: Exclude<ToolCall, { tool: 'bash' }>): Promise<OperationOutcome> {
    switch (call.tool) {
      case 'read': return readFileTool(context, call.input);
      case 'glob': return globTool(context, call.input);
      case 'grep': return grepTool(context, call.input);
      case 'write': return writeTool(context, call.input);
      case 'edit': return editTool(context, call.input);
      case 'patch': return patchTool(context, call.input);
    }
  }

  private async command(context: OperationContext, call: Extract<ToolCall, { tool: 'bash' }>, signal: AbortSignal) {
    const { command } = call.input;
    if (Buffer.byteLength(command) > FIXED_TOOL_LIMITS.commandBytes) {
      return { outcome: refusedAs('invalid_input', `Command refused: it exceeds ${FIXED_TOOL_LIMITS.commandBytes} bytes.`), extra: {} };
    }
    context.started({ kind: 'command', command });
    const answer = await context.approve({ kind: 'command', command });
    if (answer !== 'approved') return { outcome: notApproved(answer, 'Command'), extra: {} };
    if (signal.aborted) return { outcome: notApproved('canceled', 'Command'), extra: {} };
    const limits = this.input.options.limits;
    const result = await runCommand({ bubblewrap: this.input.bubblewrap, workspace: this.input.options.workspaceDirectory, command,
      timeoutMs: Math.min(call.input.timeout ?? limits.commandTimeoutMs, limits.commandTimeoutMs), outputBytes: limits.outputBytes, signal });
    if (result.unsettled) this.unsettled.push(result.unsettled);
    const status = result.reason === 'exited' ? `exit ${result.exitCode ?? `signal ${result.signal}`}` : result.reason;
    const text = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}${result.truncated ? '\n[output truncated]' : ''}\n[${status}]`;
    const outcome: OperationOutcome = {
      status: result.reason === 'canceled' ? 'canceled' : result.joined && result.reason === 'exited' && result.exitCode === 0 ? 'completed' : 'failed',
      text: result.joined ? text : `${text}\n[the command namespace did not settle; the session is fenced]`,
      ...(result.joined ? {} : { fence: 'command_unjoined' }),
    };
    return { outcome, extra: { command: Object.freeze({ reason: result.reason, exitCode: result.exitCode, signal: result.signal,
      durationMs: result.durationMs, outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      truncated: result.truncated, joined: result.joined }) } };
  }

  /** Bounds one host decision by cancellation and the fixed expiry; neither performs an effect. */
  private async approve(observer: NodeProviderToolObserver, request: NodeProviderToolApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    if (signal.aborted) return 'canceled';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('expired'), FIXED_TOOL_LIMITS.approvalTimeoutMs);
    const cancel = () => controller.abort('canceled');
    signal.addEventListener('abort', cancel, { once: true });
    const withdrawn = new Promise<ApprovalAnswer>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(controller.signal.reason === 'expired' ? 'expired' : 'canceled'), { once: true });
    });
    try {
      const decision = observer.approve(Object.freeze(request), controller.signal)
        .then((value): ApprovalAnswer => value === 'approved' ? 'approved' : 'denied', (): ApprovalAnswer => 'canceled');
      return await Promise.race([decision, withdrawn]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (!controller.signal.aborted) controller.abort('settled');
    }
  }
}
