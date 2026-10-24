import type { AgentTurnOutcome } from '@agen-ai/agent-protocol';
import type {
  AgentExecutionInputMessage, AgentExecutionInputOutcome, AgentExecutionInputReceipt,
  AgentProviderTurnExecution,
} from '@agen-ai/agent-runtime';
import { deferred, within } from './support.js';

export type InputReceiptSummary =
  | Readonly<{ status: 'unsupported' }>
  | Readonly<{ status: 'accepted'; messageId: string }>
  | Readonly<{ status: 'rejected' | 'delivery_uncertain'; messageId: string; errorCode: string }>;

export interface ExecutionInputFlowReport {
  readonly receipt: InputReceiptSummary;
  readonly settlement: AgentExecutionInputOutcome | null;
  readonly output: Readonly<{ events: readonly string[]; text: string; outcomes: readonly AgentTurnOutcome[]; terminals: number }>;
  readonly outputWhileAwaitingReceipt: boolean;
  readonly outputWhileAwaitingSettlement: boolean;
}

function unreachable(value: never): never {
  throw new Error('The execution-input contract has an unhandled variant.', { cause: value });
}

function receiptSummary(receipt: AgentExecutionInputReceipt): InputReceiptSummary {
  switch (receipt.status) {
    case 'accepted': return { status: receipt.status, messageId: receipt.messageId };
    case 'rejected':
    case 'delivery_uncertain': return { status: receipt.status, messageId: receipt.messageId, errorCode: receipt.error.code };
    default: return unreachable(receipt);
  }
}

// The caller owns session close and instance disposal, including when this function rejects.
export function startExecutionInputFlow(
  execution: AgentProviderTurnExecution,
  message: AgentExecutionInputMessage,
) {
  const entered = deferred<void>();
  const joined = deferred<void>();
  const events: string[] = [];
  const outcomes: AgentTurnOutcome[] = [];
  let text = '';
  // Start exactly one reader before sending. Keep it running throughout both input waits.
  const draining = (async () => {
    try {
      for await (const output of execution.outputs) {
        if (output.kind !== 'event') continue;
        const event = output.event;
        events.push(event.type);
        if (event.type === 'turn.started') entered.resolve();
        if (event.type === 'content.delta' && event.payload.streamKind === 'assistant_text') text += event.payload.delta;
        if (event.type === 'turn.completed') outcomes.push(event.payload.outcome);
      }
    } catch (cause) { entered.reject(cause); throw cause; }
    finally { joined.resolve(); }
  })();
  // Observe failure immediately even when the submission receipt is still outstanding.
  void draining.catch(() => {});
  const result = (async (): Promise<ExecutionInputFlowReport> => {
    await within(entered.promise, 'Initial output');
    let receipt: InputReceiptSummary = { status: 'unsupported' };
    let settlement: AgentExecutionInputOutcome | null = null;
    let outputWhileAwaitingReceipt = false;
    let outputWhileAwaitingSettlement = false;
    const input = execution.input;
    if (input?.kind === 'supported') {
      const outputsBeforeReceipt = events.length;
      const received = await within(input.sendMessage(message), 'Submission receipt');
      outputWhileAwaitingReceipt = events.length > outputsBeforeReceipt;
      receipt = receiptSummary(received);
      switch (received.status) {
        case 'accepted': {
          const outputsBeforeSettlement = events.length;
          const outcome = await within(received.settled, 'Consumption observation');
          outputWhileAwaitingSettlement = events.length > outputsBeforeSettlement;
          switch (outcome.status) {
            case 'consumed':
              // Attribution to native work does not prove the instruction was obeyed.
              settlement = outcome;
              break;
            case 'unconfirmed':
              // Acceptance remains true. Missing consumption evidence is never a replay signal.
              settlement = outcome;
              break;
            default: unreachable(outcome);
          }
          break;
        }
        case 'rejected':
          // Definite native refusal supplies no consumption promise. Let the original turn finish.
          break;
        case 'delivery_uncertain':
          // Stop mutation and close after draining; never resend, steer, interrupt, or start a fallback turn.
          break;
        default: unreachable(received);
      }
    }
    await within(draining, 'Original output reader');
    return { receipt, settlement, output: { events, text, outcomes, terminals: outcomes.length },
      outputWhileAwaitingReceipt, outputWhileAwaitingSettlement };
  })();
  void result.catch(() => {});
  return { result, joined: joined.promise };
}
