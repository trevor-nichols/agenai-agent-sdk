import type { AgentError, AgentProviderKey, AgentSessionId } from "@agen-ai/agent-protocol";
import { AgentProviderContractError, AgentProviderSessionCleanupError } from "../contractErrors.js";
import type { MaybePromise } from "../foundation.js";
import type { AgentSessionAdmission } from "../sessionAdmission.js";
import type { AgentSessionValidationOwner } from "../sessionValidation.js";
import type { AgentNativeContinuationContext, AgentNativeContinuationSupport } from "../nativeContinuations/types.js";
import type { AgentProviderSessionInteraction, AgentProviderSessionInteractionContext, AgentSessionInteractionContext, AgentSessionInteractionOpeningOperation,
  AgentSessionInteractionSupport, AgentSessionInteractionTerminal } from "./types.js";
import { SessionInteractionRequest } from "./request.js";
import { captureSessionInteractionCandidate, interactionContractError, validateSessionInteractionCandidate,
  validateSessionInteractionContext, validateNativeContinuationContext, type ValidatedSessionInteractionContext } from "./validation.js";

type OwnerState = "opening" | "open" | "mutation-fenced" | "stopping" | "cleanup-pending" | "closed";

export function sessionInteractionError(code: string, message: string, uncertain = false): AgentError {
  return Object.freeze({ category: uncertain ? "unknown" : "invalid_request", code, message,
    recovery: Object.freeze({ kind: uncertain ? "unknown" : "none" }) });
}

export function waitForInteractionWork<Result>(work: Promise<Result>, timeoutMs: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Session interaction cleanup did not finish before its deadline.")), timeoutMs);
    work.then((result) => { clearTimeout(timer); resolve(result); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export class SessionInteractionOwner {
  readonly admission: AgentSessionAdmission;
  readonly facade: AgentProviderSessionInteractionContext;
  readonly openingSignal: AbortSignal;
  readonly limits: ValidatedSessionInteractionContext["limits"];
  readonly failure: Promise<unknown>;
  private readonly controller = new AbortController();
  private readonly requests = new Map<string, SessionInteractionRequest>();
  private readonly work = new Set<Promise<unknown>>();
  private state: OwnerState = "opening";
  private retainedBytes = 0;
  private fatal: { readonly cause: unknown; observed: boolean } | undefined;
  private fenceCause: unknown;
  private resolveFailure!: (cause: unknown) => void;
  private removeOpeningAbort: () => void = () => {};
  private automaticClose: (() => Promise<void>) | undefined;
  private cleanupAttempt: Promise<void> | null = null;
  private cleanupDeadline = 0;
  private cleanupComplete = false;
  private retainedCleanup: (() => MaybePromise<void>) | undefined;
  private cleanupFailure: { readonly cause: unknown } | undefined;
  private adopted = false;
  private bound = false;
  private returned = false;
  private readonly waiting = new Map<() => void, "form" | "plan_review">();
  private associationTimer: ReturnType<typeof setTimeout> | undefined;
  private prebindingCount = 0;
  private prebindingBytes = 0;
  private readonly preparations = new Set<() => Promise<void>>();
  private stoppedExecution: AgentSessionValidationOwner["activeTurn"] = null;
  readonly continuations: AgentNativeContinuationContext | undefined;
  private readonly context: ValidatedSessionInteractionContext;

  constructor(readonly providerKey: AgentProviderKey, readonly sessionId: AgentSessionId,
    context: AgentSessionInteractionContext, readonly validationOwner: AgentSessionValidationOwner,
    readonly operation: AgentSessionInteractionOpeningOperation, readonly support: AgentSessionInteractionSupport,
    readonly nativeSupport: AgentNativeContinuationSupport, continuations?: AgentNativeContinuationContext, signal?: AbortSignal) {
    this.admission = validationOwner.sessionAdmission;
    this.continuations = validateNativeContinuationContext(continuations);
    try { this.context = validateSessionInteractionContext(context); }
    catch (cause) { throw new AgentProviderContractError(providerKey, "invalid_session_interaction",
      "Session interaction context is invalid.", { cause }); }
    this.limits = this.context.limits;
    this.openingSignal = this.controller.signal;
    this.failure = new Promise((resolve) => { this.resolveFailure = resolve; });
    const { requestTimeoutMs: _timeout, ...nonHumanLimits } = this.limits;
    const onRequest = (candidate: AgentProviderSessionInteraction) => this.offer(candidate);
    this.facade = this.context.humanWait === "bounded"
      ? Object.freeze({ humanWait: Object.freeze({ kind: "bounded" }), limits: this.limits, onRequest })
      : Object.freeze({ humanWait: Object.freeze({ kind: "until_withdrawn_or_closed" }), limits: Object.freeze(nonHumanLimits), onRequest });
    if (signal) {
      const aborted = () => this.fail(signal.reason ?? new DOMException("Session opening was aborted.", "AbortError"));
      signal.addEventListener("abort", aborted, { once: true });
      this.removeOpeningAbort = () => signal.removeEventListener("abort", aborted);
      if (signal.aborted) aborted();
    }
  }

  track<Result>(promise: Promise<Result>): Promise<Result> {
    this.work.add(promise);
    void promise.then(() => this.work.delete(promise), () => this.work.delete(promise));
    return promise;
  }

  get accepting(): boolean { return this.state === "opening" || this.state === "open"; }
  get hasLiveRequests(): boolean {
    for (const request of this.requests.values()) if (request.blocksExecutionInput) return true;
    return false;
  }

  requireUsable(): void {
    if (this.fatal) throw this.fatal.cause;
    this.validationOwner.requireUsable();
    if (!this.accepting) throw this.fenceCause ?? new AgentProviderContractError(this.providerKey,
      this.state === "closed" ? "session_closed" : "session_unusable", "Session interactions no longer permit provider mutation.");
  }

  private offer(candidate: AgentProviderSessionInteraction): Promise<void> {
    let captured: ReturnType<typeof captureSessionInteractionCandidate>;
    try {
      captured = captureSessionInteractionCandidate(candidate, (terminal) => { this.track(terminal); });
      const validated = validateSessionInteractionCandidate(captured, this.sessionId, this.context);
      this.requireUsable();
      if (this.support.kind !== "supported" || !this.support.mappings.some((entry) => entry.openingOperation === this.operation && entry.requestKind === validated.request.kind)) {
        throw interactionContractError(this.providerKey, "Provider offered an undeclared session request kind.");
      }
      if (validated.kind === "prepared") this.requireContinuation(validated.request.kind);
      if (validated.signal.aborted) throw interactionContractError(this.providerKey, "Provider offered an unavailable session interaction.");
      const bytes = Buffer.byteLength(JSON.stringify(validated.request), "utf8");
      if (this.requests.has(validated.request.requestId) || this.requests.size >= this.limits.maxRetainedRequests
        || this.retainedBytes + bytes > this.limits.maxRetainedBytes) {
        throw interactionContractError(this.providerKey, "Session interaction identity or retained capacity is unavailable.");
      }
      this.admission.claimRequest(validated.request.requestId, "invalid_session_interaction");
      const request = new SessionInteractionRequest(this, validated, () => {
        this.requests.delete(validated.request.requestId);
        this.retainedBytes -= bytes;
      });
      this.requests.set(validated.request.requestId, request);
      this.retainedBytes += bytes;
      request.observe();
      let resolveCallback!: () => void;
      let rejectCallback!: (cause: unknown) => void;
      const callback = new Promise<void>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
      const present = () => {
        this.waiting.delete(present);
        if (!this.accepting || request.handle.signal.aborted) { resolveCallback(); return; }
        try { Promise.resolve(this.context.onRequest(request.handle)).then(resolveCallback, rejectCallback); }
        catch (cause) { rejectCallback(cause); }
      };
      request.setCallback(callback);
      this.track(callback);
      void callback.catch((cause) => this.fail(cause));
      if (validated.kind === "direct" || this.canPresent(validated.request.kind)) present();
      else {
        this.waiting.set(present, validated.request.kind as "form" | "plan_review");
        if (!this.bound) {
          this.prebindingCount += 1; this.prebindingBytes += bytes;
          if (this.prebindingCount > 16 || this.prebindingBytes > 1_048_576) throw new AgentProviderContractError(this.providerKey,
            "native_continuation_limit_exceeded", "Prebinding association exceeded its retained material budget.");
          this.associationTimer ??= setTimeout(() => this.fail(new AgentProviderContractError(this.providerKey,
            "invalid_native_continuation", "Prebinding association did not finish before its deadline.")), 30_000);
        }
      }
      return callback;
    } catch (cause) {
      const failure = cause instanceof AgentProviderContractError ? cause : new AgentProviderContractError(this.providerKey,
        "invalid_session_interaction", "Provider offered an invalid session interaction.", { cause });
      this.fail(failure);
      const rejected = Promise.reject<void>(failure);
      void rejected.catch(() => {});
      return rejected;
    }
  }

  requireContinuation(kind: "form" | "plan_review"): void {
    if (!this.continuations || this.nativeSupport.kind !== "supported" || !this.nativeSupport.mappings.some((entry) => entry.openingOperation === this.operation && entry.requestKind === kind)) {
      throw new AgentProviderContractError(this.providerKey, "native_continuations_unsupported", "Provider native continuation requires its exact supported tuple and a host output handler.");
    }
  }
  private canPresent(kind: "form" | "plan_review"): boolean {
    return this.bound && this.nativeSupport.kind === "supported" && this.nativeSupport.mappings.some((entry) => entry.openingOperation === this.operation && entry.requestKind === kind && (entry.timing !== "after_open_return" || this.returned));
  }
  bind(): void {
    this.requireUsable(); this.bound = true;
    if (this.associationTimer) clearTimeout(this.associationTimer);
    this.prebindingCount = 0; this.prebindingBytes = 0;
    this.presentWaiting();
  }
  markReturned(): void { this.returned = true; this.presentWaiting(); }
  private presentWaiting(): void {
    for (const [present, kind] of this.waiting) if (!this.accepting || this.canPresent(kind)) present();
  }
  async cleanupFailedPreparation(): Promise<void> {
    if (this.cleanupComplete) return;
    // Failed preparation allocation belongs to the original opening or adopted native owner.
    if (this.retainedCleanup) return this.close(this.retainedCleanup, false);
    if (this.automaticClose) return this.automaticClose();
    throw new Error("Opening cleanup has not acquired its native session owner.");
  }
  quiesce(): void { if (this.adopted && this.automaticClose) void this.automaticClose().catch(() => {}); }
  retainPreparation(cleanup: () => Promise<void>): () => void {
    this.preparations.add(cleanup);
    return () => { this.preparations.delete(cleanup); };
  }
  installClose(close: () => Promise<void>): void { this.automaticClose = close; this.validationOwner.installClose(close); }

  adopt(): void {
    this.requireUsable();
    this.removeOpeningAbort();
    this.state = "open";
    this.adopted = true;
  }

  fence(cause: unknown, source: SessionInteractionRequest): void {
    if (!this.accepting) return;
    this.validationOwner.fence();
    this.fenceCause = new AgentProviderContractError(this.providerKey, "session_unusable",
      "Provider session cannot be reused after uncertain session interaction delivery.", { cause });
    this.state = "mutation-fenced";
    if (!this.adopted) {
      this.resolveFailure(this.fenceCause);
      this.controller.abort(new DOMException("Session opening lost confirmed interaction delivery.", "AbortError"));
    }
    const terminal = Object.freeze({ kind: "failed", error: sessionInteractionError("session_interaction_delivery_uncertain",
      "A session interaction response could not be confirmed.", true) } as const);
    for (const request of this.requests.values()) if (request !== source) request.stop(terminal, false);
  }

  fail(cause: unknown): void {
    if (!this.fatal) {
      this.fatal = { cause, observed: false };
      this.resolveFailure(cause);
    }
    this.stop(Object.freeze({ kind: "failed", error: sessionInteractionError("session_interaction_failed",
      "The session interaction owner failed.") }));
    if (this.adopted && this.automaticClose) {
      // Automatic cleanup is observed here; the sticky cause is reported by the owning session.
      void this.automaticClose().catch(() => {});
    }
  }

  stop(terminal: AgentSessionInteractionTerminal = Object.freeze({ kind: "session_closed" })): void {
    if (this.state !== "closed" && this.state !== "cleanup-pending") this.state = "stopping";
    this.stoppedExecution ??= this.validationOwner.activeTurn;
    this.validationOwner.stop();
    this.stoppedExecution?.owner.stop(new DOMException("The session interaction owner was stopped.", "AbortError"));
    this.removeOpeningAbort();
    if (this.associationTimer) clearTimeout(this.associationTimer);
    this.presentWaiting();
    this.controller.abort(new DOMException("The session interaction owner was stopped.", "AbortError"));
    for (const request of this.requests.values()) request.stop(terminal);
  }

  async join(): Promise<void> {
    await Promise.all([...this.preparations].map((cleanup) => cleanup()));
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
    await Promise.all([...this.requests.values()].map((request) => request.join()));
    await this.stoppedExecution?.owner.join();
  }

  close(cleanup: () => MaybePromise<void>, explicit: boolean): Promise<void> {
    this.retainedCleanup ??= cleanup;
    this.stop();
    if (!this.cleanupComplete && !this.cleanupAttempt) {
      this.state = "cleanup-pending";
      this.cleanupDeadline = Date.now() + this.limits.cleanupTimeoutMs;
      const attempt = Promise.resolve().then(cleanup).then(() => { this.cleanupComplete = true; this.state = "closed"; });
      this.cleanupAttempt = attempt;
      void attempt.then(() => { if (this.cleanupAttempt === attempt) this.cleanupAttempt = null; },
        (cause) => { this.cleanupFailure = { cause }; if (this.cleanupAttempt === attempt) this.cleanupAttempt = null; });
    }
    const actual = this.cleanupAttempt ?? Promise.resolve();
    return waitForInteractionWork(actual, this.cleanupComplete ? this.limits.cleanupTimeoutMs
      : Math.max(0, this.cleanupDeadline - Date.now())).then(() => {
      if (explicit && this.fatal && !this.fatal.observed) {
        this.fatal.observed = true;
        if (this.cleanupFailure) throw new AggregateError([this.fatal.cause, this.cleanupFailure.cause],
          "Session interactions failed; retained cleanup subsequently completed.");
        throw this.fatal.cause;
      }
      if (explicit) this.cleanupFailure = undefined;
    }, (cleanupError) => {
      const causes: unknown[] = [cleanupError];
      if (explicit && this.fatal && !this.fatal.observed) { this.fatal.observed = true; causes.unshift(this.fatal.cause); }
      throw new AgentProviderSessionCleanupError({ providerKey: this.providerKey, errors: causes,
        retryCleanup: () => this.close(cleanup, true) });
    });
  }
}

export function createSessionInteractionOwner(input: Readonly<{
  providerKey: AgentProviderKey; sessionId: AgentSessionId; operation: AgentSessionInteractionOpeningOperation;
  support: AgentSessionInteractionSupport; nativeSupport: AgentNativeContinuationSupport;
  validationOwner: AgentSessionValidationOwner; context?: AgentSessionInteractionContext;
  continuations?: AgentNativeContinuationContext; signal?: AbortSignal;
}>): SessionInteractionOwner | undefined {
  if (input.context === undefined) {
    if (input.continuations !== undefined) throw new AgentProviderContractError(input.providerKey, "native_continuations_unsupported", "Native continuations require session interaction handlers.");
    return undefined;
  }
  if (input.support.kind === "unsupported" || !input.support.mappings.some((entry) => entry.openingOperation === input.operation)) {
    throw new AgentProviderContractError(input.providerKey, "session_interactions_unsupported",
      "Provider does not support session interactions for this opening operation.");
  }
  let parsed: ValidatedSessionInteractionContext;
  try { parsed = validateSessionInteractionContext(input.context); }
  catch (cause) { throw new AgentProviderContractError(input.providerKey, "invalid_session_interaction", "Session interaction context is invalid.", { cause }); }
  if (!input.support.humanWait.includes(parsed.humanWait)) throw new AgentProviderContractError(input.providerKey,
    "session_interactions_unsupported", "Provider does not support the selected human wait policy.");
  if (input.continuations !== undefined && (input.nativeSupport.kind !== "supported" || !input.nativeSupport.mappings.some((entry) => entry.openingOperation === input.operation))) {
    throw new AgentProviderContractError(input.providerKey, "native_continuations_unsupported", "Provider does not support continuations for this opening operation.");
  }
  return new SessionInteractionOwner(input.providerKey, input.sessionId, input.context, input.validationOwner,
    input.operation, input.support, input.nativeSupport, input.continuations, input.signal);
}
