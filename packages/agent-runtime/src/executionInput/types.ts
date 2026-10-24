import type {
  AgentError,
  AgentOperationInputCapability,
  AgentTurnId,
  AgentTurnInputContent,
} from "@agen-ai/agent-protocol";

declare const executionInputMessageIdBrand: unique symbol;

/** Process-local submission identity; distinct from a turn or human request ID. */
export type AgentExecutionInputMessageId = string & {
  readonly [executionInputMessageIdBrand]: true;
};

export type AgentExecutionInputSupport =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      delivery: "current_or_owned_continuation";
      consumptionReporting: "message_ids" | "unavailable";
      input: AgentOperationInputCapability;
      limits: Readonly<{
        maxOutstandingMessages: number;
        maxMessagesPerExecution: number;
        maxBufferedBytes: number;
      }>;
    }>;

/** Initial admission accepts text only, using the canonical turn-content bounds. */
export interface AgentExecutionInputMessage extends AgentTurnInputContent {
  readonly messageId: AgentExecutionInputMessageId;
  readonly signal?: AbortSignal;
}

/** Consumption is attribution to native work, not proof that the instruction was obeyed. */
export type AgentExecutionInputOutcome =
  | Readonly<{
      status: "consumed";
      messageId: AgentExecutionInputMessageId;
      turnId: AgentTurnId;
      placement: "original_native_command" | "owned_native_continuation";
    }>
  | Readonly<{
      status: "unconfirmed";
      messageId: AgentExecutionInputMessageId;
      reason:
        | "provider_does_not_report_consumption"
        | "closed"
        | "interrupted"
        | "native_failed"
        | "correlation_lost";
    }>;

/** In-process receipt and settlement handle; never a wire or persistence format. */
export type AgentExecutionInputReceipt =
  | Readonly<{
      status: "accepted";
      messageId: AgentExecutionInputMessageId;
      settled: Promise<AgentExecutionInputOutcome>;
    }>
  | Readonly<{
      status: "rejected";
      messageId: AgentExecutionInputMessageId;
      error: AgentError;
    }>
  | Readonly<{
      status: "delivery_uncertain";
      messageId: AgentExecutionInputMessageId;
      error: AgentError;
    }>;

/** Keep the sole outputs reader running while awaiting a receipt and its settlement. */
export type AgentExecutionInput =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      support: Extract<AgentExecutionInputSupport, { kind: "supported" }>;
      sendMessage: (input: AgentExecutionInputMessage) => Promise<AgentExecutionInputReceipt>;
    }>;
