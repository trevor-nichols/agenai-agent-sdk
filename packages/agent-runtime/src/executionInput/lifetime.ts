import type { AgentError, AgentProviderKey, AgentTurnId } from "@agen-ai/agent-protocol";

import { AgentProviderContractError, AgentProviderDelegatedOperationError } from "../contractErrors.js";
import { throwIfAgentOperationAborted } from "../foundation.js";
import { serializedAgentJsonValueBytes } from "../internal/serializedJsonBytes.js";
import type { AgentExecutionInput, AgentExecutionInputMessage, AgentExecutionInputMessageId,
  AgentExecutionInputOutcome, AgentExecutionInputReceipt, AgentExecutionInputSupport } from "./types.js";
import { parseAgentExecutionInputMessage, validateAgentExecutionInputReceipt } from "./validation.js";

const RECEIPT_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = 30_000;
const MAX_SESSION_IDENTITIES = 4_096;
const MAX_SESSION_ID_BYTES = 1_048_576;

export function createExecutionInputCensus(providerKey: AgentProviderKey, exhausted: () => void) {
  const identities = new Set<AgentExecutionInputMessageId>();
  let retainedBytes = 0;
  return {
    claim(messageId: AgentExecutionInputMessageId): void {
      if (identities.has(messageId)) throw new AgentProviderContractError(providerKey, "execution_input_identity_reused",
        "Execution input reused a message ID in this session generation.");
      const bytes = Buffer.byteLength(messageId, "utf8");
      if (identities.size >= MAX_SESSION_IDENTITIES || retainedBytes + bytes > MAX_SESSION_ID_BYTES) {
        exhausted();
        throw new AgentProviderContractError(providerKey, "execution_input_identity_limit_exceeded",
          "Execution input exhausted this session generation's bounded message identity census.");
      }
      identities.add(messageId);
      retainedBytes += bytes;
    },
  };
}

type UnconfirmedReason = Extract<AgentExecutionInputOutcome, { status: "unconfirmed" }>["reason"];
type SupportedInput = Extract<AgentExecutionInput, { kind: "supported" }>;
type InputPhase =
  | Readonly<{ kind: "reserved" }>
  | Readonly<{ kind: "accepting"; port: SupportedInput }>
  | Readonly<{ kind: "closing" | "draining"; reason?: UnconfirmedReason }>
  | Readonly<{ kind: "settled" }>;
type MessagePhase =
  | Readonly<{ kind: "entered" | "accepted"; payload: AgentExecutionInputMessage }>
  | Readonly<{ kind: "settled" }>;
interface MessageEntry {
  readonly messageId: AgentExecutionInputMessageId;
  readonly bytes: number;
  readonly observation: ReturnType<typeof Promise.withResolvers<AgentExecutionInputOutcome>>;
  phase: MessagePhase;
}

function unconfirmed(messageId: AgentExecutionInputMessageId, reason: UnconfirmedReason): AgentExecutionInputOutcome {
  return Object.freeze({ status: "unconfirmed", messageId, reason });
}
function uncertainError(): AgentError {
  return Object.freeze({ category: "transport", code: "execution_input_delivery_uncertain",
    message: "The native execution-input receipt was not authoritatively observed.", recovery: Object.freeze({ kind: "none" }) });
}

/** One execution's admission and observations; the existing execution owns its native output reader. */
export function createExecutionInputOwner(input: Readonly<{
  providerKey: AgentProviderKey;
  turnId: AgentTurnId;
  support: Extract<AgentExecutionInputSupport, { kind: "supported" }>;
  census: ReturnType<typeof createExecutionInputCensus>;
  signal: AbortSignal;
  requireAdmission: () => void;
  fence: () => void;
}>) {
  let phase: InputPhase = { kind: "reserved" };
  let enteredMessages = 0;
  let retainedBytes = 0;
  let failure: Error | undefined;
  let uncertain = false;
  const messages = new Map<AgentExecutionInputMessageId, MessageEntry>();
  const work = new Set<Promise<void>>();
  const observe = (entry: MessageEntry, outcome: AgentExecutionInputOutcome) => entry.observation.resolve(outcome);
  const closeAdmission = (reason?: UnconfirmedReason): void => {
    if (phase.kind === "settled") return;
    if (phase.kind === "reserved" || phase.kind === "accepting") phase = { kind: "closing", ...(reason === undefined ? {} : { reason }) };
    else if (reason !== undefined && phase.reason === undefined) phase = { kind: phase.kind, reason };
    if (reason !== undefined) for (const entry of messages.values()) observe(entry, unconfirmed(entry.messageId, reason));
  };
  const fail = (cause: unknown): Error => {
    failure ??= cause instanceof Error ? cause : new Error("Execution-input observation failed.", { cause });
    input.fence();
    closeAdmission("correlation_lost");
    return failure;
  };
  const fenceUncertainty = (): void => {
    uncertain = true;
    input.fence();
    closeAdmission("correlation_lost");
  };
  const finish = (entry: MessageEntry): void => {
    if (entry.phase.kind === "settled") return;
    entry.phase = { kind: "settled" };
    messages.delete(entry.messageId);
    retainedBytes -= entry.bytes;
  };
  const track = (promise: Promise<void>): void => {
    work.add(promise);
    void promise.then(() => work.delete(promise), (cause) => { work.delete(promise); fail(cause); });
  };
  const unavailable = (): never => {
    throw new AgentProviderContractError(input.providerKey, "active_turn_mismatch",
      "Execution input requires the exact entered execution with open admission.");
  };
  const sendMessage = async (candidate: AgentExecutionInputMessage): Promise<AgentExecutionInputReceipt> => {
    const message = parseAgentExecutionInputMessage(candidate);
    throwIfAgentOperationAborted(message.signal);
    input.requireAdmission();
    if (phase.kind !== "accepting") return unavailable();
    const port = phase.port;
    const bytes = serializedAgentJsonValueBytes({ messageId: message.messageId,
      parts: message.parts.map((part) => ({ type: part.type, text: part.text })),
      ...(message.summary === undefined ? {} : { summary: message.summary }) });
    if (enteredMessages >= input.support.limits.maxMessagesPerExecution
      || messages.size >= input.support.limits.maxOutstandingMessages
      || retainedBytes + bytes > input.support.limits.maxBufferedBytes) {
      throw new AgentProviderContractError(input.providerKey, "execution_input_capacity_exhausted",
        "Execution input exceeds this execution's bounded message capacity.");
    }
    input.census.claim(message.messageId);
    const observation = Promise.withResolvers<AgentExecutionInputOutcome>();
    const entry: MessageEntry = { messageId: message.messageId, bytes, observation, phase: { kind: "entered", payload: message } };
    messages.set(entry.messageId, entry);
    enteredMessages += 1;
    retainedBytes += bytes;
    const receipt = Promise.withResolvers<AgentExecutionInputReceipt>();
    const context = { providerKey: input.providerKey, turnId: input.turnId, messageId: message.messageId, support: input.support };
    // Reservation and entry are synchronous; neither a sibling send nor terminal observation can interleave.
    const signal = message.signal === undefined ? input.signal : AbortSignal.any([input.signal, message.signal]);
    let waitState: "waiting" | "settled" = "waiting";
    const deadlineAt = Date.now() + RECEIPT_TIMEOUT_MS;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", lost); };
    const lost = () => {
      if (waitState === "settled") return;
      waitState = "settled";
      cleanup();
      fenceUncertainty();
      receipt.resolve(Object.freeze({ status: "delivery_uncertain", messageId: entry.messageId, error: uncertainError() }));
    };
    const deliver = (value: AgentExecutionInputReceipt) => {
      if (waitState === "settled") return;
      if (Date.now() >= deadlineAt) { lost(); return; }
      waitState = "settled"; cleanup(); receipt.resolve(value);
    };
    const rejectReceipt = (cause: unknown) => {
      if (waitState === "settled") return;
      waitState = "settled"; cleanup(); receipt.reject(cause);
    };
    const timer = setTimeout(lost, RECEIPT_TIMEOUT_MS);
    signal.addEventListener("abort", lost, { once: true });
    let actual: Promise<AgentExecutionInputReceipt>;
    try { actual = Promise.resolve(port.sendMessage({ ...message, signal })); }
    catch (cause) {
      fail(cause);
      rejectReceipt(new AgentProviderDelegatedOperationError(input.providerKey, "send_execution_input", cause));
      finish(entry);
      return receipt.promise;
    }
    const actualReceipt = actual.then((value) => validateAgentExecutionInputReceipt(value, context));
    track(actualReceipt.then(async (result) => {
      if (result.status === "accepted") {
        if (entry.phase.kind !== "settled") entry.phase = { kind: "accepted", payload: message };
        deliver(Object.freeze({ status: "accepted", messageId: entry.messageId, settled: observation.promise }));
        try {
          const outcome = await result.settled;
          observe(entry, outcome);
          if (outcome.status === "unconfirmed" && outcome.reason === "correlation_lost") {
            fail(new AgentProviderContractError(input.providerKey, "execution_input_correlation_lost",
              "Provider lost ownership correlation for an accepted execution input."));
          }
        }
        catch (cause) { fail(cause); }
        finally { finish(entry); }
      } else {
        if (result.status === "delivery_uncertain") fenceUncertainty();
        deliver(result);
        finish(entry);
      }
    }, (cause) => {
      const delegated = new AgentProviderDelegatedOperationError(input.providerKey, "send_execution_input", cause);
      fail(cause);
      rejectReceipt(delegated);
      finish(entry);
    }));
    // A public wait can end while the actual invocation remains owned until native cleanup.
    if (signal.aborted) lost();
    return receipt.promise;
  };
  const join = async (producer?: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentProviderContractError(
      input.providerKey, "invalid_operation_result", "Execution-input ownership did not drain before its deadline.")), DRAIN_TIMEOUT_MS); });
    try {
      if (producer !== undefined) await Promise.race([Promise.all([producer, ...work]), deadline]);
      while (work.size > 0) await Promise.race([Promise.all([...work]), deadline]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  return {
    port: Object.freeze({ kind: "supported" as const, support: input.support, sendMessage }),
    attach(port: SupportedInput): void {
      if (phase.kind === "reserved") phase = { kind: "accepting", port };
      else if (phase.kind !== "closing") throw new AgentProviderContractError(input.providerKey, "invalid_operation_result",
        "Provider execution-input port was attached more than once.");
    },
    closeAdmission,
    async drain(producer?: Promise<void>): Promise<void> {
      closeAdmission();
      phase = { kind: "draining", ...(phase.kind === "closing" && phase.reason !== undefined ? { reason: phase.reason } : {}) };
      try { await join(producer); } catch (cause) { fail(cause); }
      if (failure) throw failure;
      phase = { kind: "settled" };
    },
    join,
    get failed() { return failure !== undefined; },
    get retainsOwnership() { return uncertain || failure !== undefined || work.size > 0; },
  };
}
