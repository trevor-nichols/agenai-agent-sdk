import {
  parseAgentError,
  parseAgentTurnId,
  parseAgentTurnInputContent,
  type AgentProviderKey,
  type AgentTextInputPart,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import { parseAgentProviderTechnicalId } from "../foundation.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import type {
  AgentExecutionInput,
  AgentExecutionInputMessage,
  AgentExecutionInputMessageId,
  AgentExecutionInputOutcome,
  AgentExecutionInputReceipt,
  AgentExecutionInputSupport,
} from "./types.js";

export const AGENT_EXECUTION_INPUT_LIMITS = Object.freeze({
  maxOutstandingMessages: 2,
  maxMessagesPerExecution: 16,
  maxBufferedBytes: 1_048_576,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Expected an execution-input object.");
  return value;
}

export function parseAgentExecutionInputMessageId(value: unknown): AgentExecutionInputMessageId {
  // The sole branding boundary validates the same bounded canonical syntax as other runtime IDs.
  return parseAgentProviderTechnicalId(value, "execution input message ID") as AgentExecutionInputMessageId;
}

function positiveLimit(value: unknown, ceiling: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new TypeError("Execution-input limits must be positive integers within SDK ceilings.");
  }
  return value;
}

function isUnsupported(value: unknown): boolean {
  return isRecord(value) && hasExactOwnKeys(value, ["kind"]) && value.kind === "unsupported";
}

export function validateAgentExecutionInputSupport(value: unknown): AgentExecutionInputSupport | undefined {
  if (value === undefined) return undefined;
  if (isUnsupported(value)) return Object.freeze({ kind: "unsupported" });
  const support = record(value);
  if (!hasExactOwnKeys(support, ["kind", "delivery", "consumptionReporting", "input", "limits"])
    || support.kind !== "supported" || support.delivery !== "current_or_owned_continuation"
    || (support.consumptionReporting !== "message_ids" && support.consumptionReporting !== "unavailable")) {
    throw new TypeError("Invalid execution-input support descriptor.");
  }
  const input = record(support.input);
  if (!hasExactOwnKeys(input, ["text", "images", "contentReferences"]) || input.text !== true
    || !isUnsupported(input.images) || !isUnsupported(input.contentReferences)) {
    throw new TypeError("Execution input currently supports text only.");
  }
  const limits = record(support.limits);
  if (!hasExactOwnKeys(limits, ["maxOutstandingMessages", "maxMessagesPerExecution", "maxBufferedBytes"])) {
    throw new TypeError("Invalid execution-input limits.");
  }
  const maxMessagesPerExecution = positiveLimit(limits.maxMessagesPerExecution, AGENT_EXECUTION_INPUT_LIMITS.maxMessagesPerExecution);
  const maxOutstandingMessages = positiveLimit(limits.maxOutstandingMessages, AGENT_EXECUTION_INPUT_LIMITS.maxOutstandingMessages);
  if (maxOutstandingMessages > maxMessagesPerExecution) {
    throw new TypeError("Outstanding execution inputs cannot exceed the execution message limit.");
  }
  return Object.freeze({
    kind: "supported", delivery: support.delivery, consumptionReporting: support.consumptionReporting,
    input: Object.freeze({ text: true, images: Object.freeze({ kind: "unsupported" }),
      contentReferences: Object.freeze({ kind: "unsupported" }) }),
    limits: Object.freeze({ maxOutstandingMessages, maxMessagesPerExecution,
      maxBufferedBytes: positiveLimit(limits.maxBufferedBytes, AGENT_EXECUTION_INPUT_LIMITS.maxBufferedBytes) }),
  });
}

export function validateAgentExecutionInputPort(
  candidate: AgentExecutionInput | undefined,
  declared: AgentExecutionInputSupport | undefined,
  providerKey: AgentProviderKey,
): AgentExecutionInput | undefined {
  try {
    if (candidate === undefined && declared?.kind !== "supported") return undefined;
    if (candidate?.kind === "unsupported" && hasExactOwnKeys(candidate, ["kind"]) && declared?.kind !== "supported") {
      return Object.freeze({ kind: "unsupported" });
    }
    if (candidate?.kind !== "supported" || declared?.kind !== "supported"
      || !hasExactOwnKeys(candidate, ["kind", "support", "sendMessage"]) || typeof candidate.sendMessage !== "function") {
      throw new TypeError("Execution input is undeclared or missing its supported port.");
    }
    const support = validateAgentExecutionInputSupport(candidate.support);
    if (support?.kind !== "supported" || support.delivery !== declared.delivery
      || support.consumptionReporting !== declared.consumptionReporting
      || support.limits.maxOutstandingMessages !== declared.limits.maxOutstandingMessages
      || support.limits.maxMessagesPerExecution !== declared.limits.maxMessagesPerExecution
      || support.limits.maxBufferedBytes !== declared.limits.maxBufferedBytes) {
      throw new TypeError("Execution-input support differs from the adapter declaration.");
    }
    return Object.freeze({ kind: "supported", support, sendMessage: candidate.sendMessage.bind(candidate) });
  } catch {
    return throwAgentProviderContractError(providerKey, "capability_port_mismatch",
      "Provider execution input does not match its adapter support declaration.");
  }
}

export function parseAgentExecutionInputMessage(value: unknown): Omit<AgentExecutionInputMessage, "parts"> & Readonly<{ parts: readonly AgentTextInputPart[] }> {
  const input = record(value);
  const keys = ["messageId", "parts", ...(Object.hasOwn(input, "summary") ? ["summary"] : []),
    ...(Object.hasOwn(input, "signal") ? ["signal"] : [])];
  if (!hasExactOwnKeys(input, keys) || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
    throw new TypeError("Invalid execution-input message envelope.");
  }
  const messageId = parseAgentExecutionInputMessageId(input.messageId);
  const content = parseAgentTurnInputContent({ parts: input.parts,
    ...(input.summary === undefined ? {} : { summary: input.summary }) });
  const parts = content.parts.map((part) => {
    if (part.type !== "text") throw new TypeError("Execution input currently accepts text parts only.");
    return Object.freeze({ type: part.type, text: part.text });
  });
  return Object.freeze({ messageId, parts: Object.freeze(parts),
    ...(content.summary === undefined ? {} : { summary: content.summary }),
    ...(input.signal === undefined ? {} : { signal: input.signal }) });
}

type ReceiptContext = Readonly<{
  providerKey: AgentProviderKey;
  messageId: AgentExecutionInputMessageId;
  turnId: AgentTurnId;
  support: Extract<AgentExecutionInputSupport, { kind: "supported" }>;
}>;

export function validateAgentExecutionInputOutcome(value: unknown, context: ReceiptContext): AgentExecutionInputOutcome {
  try {
    const outcome = record(value);
    const messageId = parseAgentExecutionInputMessageId(outcome.messageId);
    if (messageId !== context.messageId) throw new TypeError("Execution-input outcome changed message identity.");
    if (outcome.status === "consumed" && hasExactOwnKeys(outcome, ["status", "messageId", "turnId", "placement"])
      && context.support.consumptionReporting === "message_ids"
      && (outcome.placement === "original_native_command" || outcome.placement === "owned_native_continuation")) {
      const turnId = parseAgentTurnId(outcome.turnId);
      if (turnId !== context.turnId) throw new TypeError("Execution-input consumption changed execution identity.");
      return Object.freeze({ status: "consumed", messageId, turnId, placement: outcome.placement });
    }
    if (outcome.status === "unconfirmed" && hasExactOwnKeys(outcome, ["status", "messageId", "reason"])
      && (outcome.reason === "closed" || outcome.reason === "interrupted" || outcome.reason === "native_failed"
        || outcome.reason === "correlation_lost" || (outcome.reason === "provider_does_not_report_consumption"
          && context.support.consumptionReporting === "unavailable"))) {
      return Object.freeze({ status: "unconfirmed", messageId, reason: outcome.reason });
    }
    throw new TypeError("Invalid execution-input outcome.");
  } catch {
    return throwAgentProviderContractError(context.providerKey, "invalid_operation_result",
      "Provider returned an invalid execution-input outcome.");
  }
}

export function validateAgentExecutionInputReceipt(value: unknown, context: ReceiptContext): AgentExecutionInputReceipt {
  try {
    const receipt = record(value);
    // Observe an offered promise immediately, even if another receipt field proves invalid.
    const settlement = Object.hasOwn(receipt, "settled") ? Promise.resolve(receipt.settled) : undefined;
    void settlement?.catch(() => {});
    const messageId = parseAgentExecutionInputMessageId(receipt.messageId);
    if (messageId !== context.messageId) throw new TypeError("Execution-input receipt changed message identity.");
    if (receipt.status === "accepted" && hasExactOwnKeys(receipt, ["status", "messageId", "settled"])
      && isRecord(receipt.settled) && typeof receipt.settled.then === "function" && settlement) {
      const settled = settlement.then((outcome) => validateAgentExecutionInputOutcome(outcome, context), () =>
        throwAgentProviderContractError(context.providerKey, "invalid_operation_result",
          "Provider execution-input settlement rejected."));
      void settled.catch(() => {});
      return Object.freeze({ status: "accepted", messageId, settled });
    }
    if ((receipt.status === "rejected" || receipt.status === "delivery_uncertain")
      && hasExactOwnKeys(receipt, ["status", "messageId", "error"])) {
      return Object.freeze({ status: receipt.status, messageId, error: parseAgentError(receipt.error) });
    }
    throw new TypeError("Invalid execution-input receipt.");
  } catch {
    return throwAgentProviderContractError(context.providerKey, "invalid_operation_result",
      "Provider returned an invalid execution-input receipt.");
  }
}
