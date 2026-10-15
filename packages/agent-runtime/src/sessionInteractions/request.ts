import { parseAgentSessionDecisionResponseFor, type AgentSessionDecisionChoiceId } from "@agen-ai/agent-protocol";
import { throwIfAgentOperationAborted } from "../foundation.js";
import { AgentProviderContractError } from "../contractErrors.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import type { AgentRequestResolutionResult } from "../sessions.js";
import { validateAgentRequestResolutionResult } from "../turnExecution/receipts.js";
import { sessionInteractionError, type SessionInteractionOwner } from "./lifetime.js";
import type { AgentSessionDecisionResponseInput, AgentSessionInteraction, AgentSessionInteractionTerminal } from "./types.js";
import { interactionContractError, validateSessionInteractionTerminal, type CapturedSessionInteractionCandidate } from "./validation.js";

type Candidate = CapturedSessionInteractionCandidate & Pick<AgentSessionInteraction, "request">;
type Attempt = { readonly choiceId: AgentSessionDecisionChoiceId; readonly deadline: number;
  receipt?: AgentRequestResolutionResult; actualReceipt?: AgentRequestResolutionResult };
type RequestState = { readonly kind: "pending" } | { readonly kind: "answering"; readonly attempt: Attempt }
  | { readonly kind: "terminal"; readonly terminal: AgentSessionInteractionTerminal; readonly attempt?: Attempt };

export class SessionInteractionRequest {
  readonly handle: AgentSessionInteraction;
  private state: RequestState = { kind: "pending" };
  private readonly presentation = new AbortController();
  private resolveTerminal!: (terminal: AgentSessionInteractionTerminal) => void;
  private callback: Promise<void> | undefined;
  private callbackSettled = false;
  private responseWork = 0;
  private rawTerminalSettled = false;
  private nativeTerminal: AgentSessionInteractionTerminal | undefined;
  private lastAttempt: Attempt | undefined;
  private stopped: AgentSessionInteractionTerminal | undefined;
  private unavailable = false;
  private retired = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private terminalTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly nativeAborted = () => {
    this.unavailable = true;
    this.presentation.abort(new DOMException("The provider interaction was stopped.", "AbortError"));
    this.expectTerminal();
  };

  constructor(private readonly owner: SessionInteractionOwner, private readonly candidate: Candidate,
    private readonly retire: () => void) {
    const terminal = new Promise<AgentSessionInteractionTerminal>((resolve) => { this.resolveTerminal = resolve; });
    this.handle = Object.freeze({ request: candidate.request, signal: this.presentation.signal, terminal,
      respond: (input: AgentSessionDecisionResponseInput) => this.respond(input) });
  }

  observe(): void {
    this.candidate.signal.addEventListener("abort", this.nativeAborted, { once: true });
    this.expiryTimer = setTimeout(() => this.expire(), Math.max(0, Date.parse(this.handle.request.expiresAt) - Date.now()));
    void this.candidate.terminal.then((candidate) => {
      this.rawTerminalSettled = true;
      if (this.terminalTimer) clearTimeout(this.terminalTimer);
      try {
        this.nativeTerminal = validateSessionInteractionTerminal(candidate);
        this.observeTerminal();
      } catch (cause) { this.protocolFailure(cause); }
      this.maybeRetire();
    }, (cause) => {
      this.rawTerminalSettled = true;
      if (this.terminalTimer) clearTimeout(this.terminalTimer);
      this.protocolFailure(cause);
      this.maybeRetire();
    });
    if (this.candidate.signal.aborted) this.nativeAborted();
  }

  setCallback(callback: Promise<void>): void {
    this.callback = callback;
    void callback.then(() => { this.callbackSettled = true; this.maybeRetire(); },
      () => { this.callbackSettled = true; this.maybeRetire(); });
  }

  private expire(): void {
    if (this.state.kind === "terminal") return;
    this.stop(Object.freeze({ kind: "expired" }));
    this.owner.fail(interactionContractError(this.owner.providerKey, "Session interaction expired before final delivery."));
  }

  private protocolFailure(cause: unknown): void {
    const error = sessionInteractionError("session_interaction_failed", "Provider session interaction protocol failed.");
    this.stop(Object.freeze({ kind: "failed", error }));
    this.owner.fail(cause instanceof AgentProviderContractError ? cause
      : new AgentProviderContractError(this.owner.providerKey, "invalid_session_interaction",
        "Provider session interaction protocol failed.", { cause }));
  }

  private observeTerminal(): void {
    const terminal = this.nativeTerminal;
    if (!terminal) return;
    if (terminal.kind === "failed") {
      this.stop(terminal);
      this.owner.fail(interactionContractError(this.owner.providerKey, "Provider session interaction producer failed."));
      return;
    }
    if (terminal.kind === "expired") {
      this.stop(terminal);
      this.owner.fail(interactionContractError(this.owner.providerKey, "Provider session interaction expired."));
      return;
    }
    // Uncertainty fences the owner even after this handle's immutable terminal settled.
    if (terminal.kind === "delivery_uncertain") this.owner.fence(terminal.error, this);
    const attempt = this.lastAttempt;
    if (terminal.kind !== "answered" && this.state.kind !== "terminal") {
      this.stopped ??= terminal;
      this.unavailable = true;
      this.presentation.abort(new DOMException("The provider interaction is no longer answerable.", "AbortError"));
    }
    if (attempt && !attempt.actualReceipt) return;
    if (attempt?.actualReceipt && this.receiptContradiction(attempt, attempt.actualReceipt)) {
      throw interactionContractError(this.owner.providerKey,
        "Provider session interaction terminal contradicts its response delivery receipt.");
    }
    if (terminal.kind === "answered") {
      if (!attempt || terminal.choiceId !== attempt.choiceId || attempt.actualReceipt?.status !== "delivered") {
        throw interactionContractError(this.owner.providerKey, "Provider interaction acceptance disagrees with its delivery receipt.");
      }
      this.finalize(terminal, attempt);
      return;
    }
    if (this.state.kind === "terminal") return;
    this.finalize(this.stopped ?? terminal, attempt);
  }

  private expectTerminal(deadline = Date.now() + this.owner.limits.responseTimeoutMs): void {
    if (this.rawTerminalSettled || this.terminalTimer) return;
    const active = this.state.kind === "answering" ? this.state.attempt.deadline
      : this.state.kind === "terminal" && this.state.attempt ? this.state.attempt.deadline : deadline;
    this.terminalTimer = setTimeout(() => {
      this.terminalTimer = undefined;
      if (!this.rawTerminalSettled) this.protocolFailure(interactionContractError(this.owner.providerKey,
        "Provider did not settle its stopped session interaction terminal."));
    }, Math.max(0, Math.min(active, deadline) - Date.now()));
  }

  private finalize(terminal: AgentSessionInteractionTerminal, attempt?: Attempt, nativeRetirementExpected = true): void {
    if (this.state.kind === "terminal") return;
    this.state = { kind: "terminal", terminal, ...(attempt === undefined ? {} : { attempt }) };
    this.unavailable = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.presentation.abort(new DOMException("The session interaction is no longer answerable.", "AbortError"));
    this.resolveTerminal(terminal);
    if (nativeRetirementExpected && (!attempt || attempt.actualReceipt || this.responseWork === 0)) this.expectTerminal();
    this.maybeRetire();
  }

  stop(terminal: AgentSessionInteractionTerminal, nativeRetirementExpected = true): void {
    this.stopped ??= terminal;
    this.unavailable = true;
    this.presentation.abort(new DOMException("The session interaction was stopped.", "AbortError"));
    if (this.state.kind === "pending") this.finalize(this.stopped, undefined, nativeRetirementExpected);
    if (nativeRetirementExpected) this.expectTerminal();
  }

  private refusal(active = false): AgentRequestResolutionResult {
    return Object.freeze({ status: "rejected", requestState: active ? "pending" : "unavailable",
      error: sessionInteractionError(active ? "session_interaction_response_active" : "session_interaction_unavailable",
        active ? "A session interaction response is already active." : "The session interaction is no longer available.") });
  }

  private uncertain(attempt: Attempt, cause?: unknown): AgentRequestResolutionResult {
    const error = sessionInteractionError("session_interaction_delivery_uncertain",
      "Session interaction response delivery could not be confirmed.", true);
    const receipt = Object.freeze({ status: "delivery_uncertain", error } as const);
    attempt.receipt ??= receipt;
    this.finalize(Object.freeze({ kind: "delivery_uncertain", error }), attempt);
    this.owner.fence(cause === undefined ? error : new AgentProviderContractError(this.owner.providerKey,
      "invalid_session_interaction", "Session interaction response delivery failed after provider entry.", { cause }), this);
    return receipt;
  }

  private receiptContradiction(attempt: Attempt, result: AgentRequestResolutionResult): boolean {
    const terminal = this.nativeTerminal;
    if (!terminal) return false;
    if (result.status === "delivery_uncertain") return terminal.kind === "rejected";
    if (terminal.kind === "answered") return terminal.choiceId !== attempt.choiceId || result.status !== "delivered";
    if (result.status === "delivered") return true;
    if (terminal.kind === "delivery_uncertain") return true;
    return result.requestState === "pending" && terminal.kind === "rejected";
  }

  private async respond(input: AgentSessionDecisionResponseInput): Promise<AgentRequestResolutionResult> {
    if (input === null || typeof input !== "object"
      || !hasExactOwnKeys(input, Object.hasOwn(input, "signal") ? ["choiceId", "signal"] : ["choiceId"])) {
      throw new TypeError("Session interaction response must contain a choice and an optional AbortSignal.");
    }
    const responseSignal = input.signal;
    if (responseSignal !== undefined && !(responseSignal instanceof AbortSignal)) {
      throw new TypeError("Session interaction response signal must be an AbortSignal.");
    }
    const response = parseAgentSessionDecisionResponseFor(this.handle.request, { choiceId: input.choiceId });
    throwIfAgentOperationAborted(responseSignal);
    const deadline = new AbortController();
    const signal = AbortSignal.any([this.presentation.signal, deadline.signal, ...(responseSignal ? [responseSignal] : [])]);
    if (Date.parse(this.handle.request.expiresAt) <= Date.now()) this.expire();
    if (this.unavailable || !this.owner.accepting || this.state.kind === "terminal") return this.refusal();
    if (this.state.kind === "answering") return this.refusal(true);
    const attempt: Attempt = { choiceId: response.choiceId, deadline: Date.now() + this.owner.limits.responseTimeoutMs };
    this.lastAttempt = attempt;
    this.state = { kind: "answering", attempt };
    this.responseWork += 1;
    // Claim and invoke without yielding: close/another response cannot enter between these steps.
    let entered: Promise<AgentRequestResolutionResult>;
    try { entered = Promise.resolve(this.candidate.respond({ ...response, signal })); }
    catch (cause) { entered = Promise.reject(cause); }
    const actual = this.owner.track(entered.then((candidate) => {
      const result = validateAgentRequestResolutionResult(candidate, this.owner.providerKey);
      attempt.actualReceipt = result;
      if (this.state.kind === "terminal") {
        try { this.observeTerminal(); } catch (cause) { this.protocolFailure(cause); }
        this.expectTerminal(attempt.deadline);
      }
      return result;
    }));
    void actual.then(() => { this.responseWork -= 1; this.maybeRetire(); },
      () => { this.responseWork -= 1; this.maybeRetire(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => { deadline.abort(new DOMException("Session interaction response timed out.", "TimeoutError")); resolve(null); },
        Math.max(0, attempt.deadline - Date.now()));
    });
    let result: AgentRequestResolutionResult | null;
    let responseFailure: unknown;
    try { result = await Promise.race([actual, timeout]); }
    catch (cause) { responseFailure = cause; result = null; }
    if (timer) clearTimeout(timer);
    if (result === null) return this.uncertain(attempt, responseFailure);
    if (this.receiptContradiction(attempt, result)) {
      const uncertain = this.uncertain(attempt);
      this.protocolFailure(interactionContractError(this.owner.providerKey,
        "Provider session interaction terminal contradicts its response delivery receipt."));
      return uncertain;
    }
    attempt.receipt = result;
    if (result.status === "delivery_uncertain") {
      this.finalize(Object.freeze({ kind: "delivery_uncertain", error: result.error }), attempt);
      this.owner.fence(result.error, this);
    } else if (result.status === "delivered") {
      this.finalize(Object.freeze({ kind: "answered", choiceId: attempt.choiceId }), attempt);
    } else if (result.requestState === "unavailable") {
      this.finalize(this.stopped ?? Object.freeze({ kind: "rejected", error: result.error }), attempt);
    } else if (this.stopped || this.unavailable || !this.owner.accepting) {
      result = this.refusal();
      if (this.stopped || !this.owner.accepting) this.finalize(this.stopped ?? Object.freeze({ kind: "session_closed" }), attempt);
      else {
        this.state = { kind: "pending" };
        this.expectTerminal(attempt.deadline);
      }
    } else {
      this.state = { kind: "pending" };
    }
    try { this.observeTerminal(); } catch (cause) { this.protocolFailure(cause); }
    return result;
  }

  private maybeRetire(): void {
    if (this.retired || this.state.kind !== "terminal" || !this.callbackSettled
      || this.responseWork !== 0 || !this.rawTerminalSettled) return;
    this.retired = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.terminalTimer) clearTimeout(this.terminalTimer);
    this.candidate.signal.removeEventListener("abort", this.nativeAborted);
    this.retire();
  }

  async join(): Promise<void> {
    await Promise.allSettled([this.candidate.terminal, ...(this.callback ? [this.callback] : [])]);
  }
}
