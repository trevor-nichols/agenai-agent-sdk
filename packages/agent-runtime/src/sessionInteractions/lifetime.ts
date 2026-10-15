import type { AgentError, AgentProviderKey, AgentSessionId } from "@agen-ai/agent-protocol";
import { AgentProviderContractError, AgentProviderSessionCleanupError } from "../contractErrors.js";
import type { MaybePromise } from "../foundation.js";
import type { AgentSessionInteraction, AgentSessionInteractionContext, AgentSessionInteractionOpeningOperation,
  AgentSessionInteractionSupport, AgentSessionInteractionTerminal } from "./types.js";
import { SessionInteractionRequest } from "./request.js";
import { captureSessionInteractionCandidate, interactionContractError, validateSessionInteractionCandidate,
  validateSessionInteractionContext, type ValidatedSessionInteractionContext } from "./validation.js";

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
  readonly facade: AgentSessionInteractionContext;
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
  private cleanupFailure: { readonly cause: unknown } | undefined;
  private adopted = false;
  private readonly context: ValidatedSessionInteractionContext;

  constructor(readonly providerKey: AgentProviderKey, readonly sessionId: AgentSessionId,
    context: AgentSessionInteractionContext, signal?: AbortSignal) {
    try { this.context = validateSessionInteractionContext(context); }
    catch (cause) { throw new AgentProviderContractError(providerKey, "invalid_session_interaction",
      "Session interaction context is invalid.", { cause }); }
    this.limits = this.context.limits;
    this.openingSignal = this.controller.signal;
    this.failure = new Promise((resolve) => { this.resolveFailure = resolve; });
    this.facade = Object.freeze({ limits: this.limits, onRequest: (candidate: AgentSessionInteraction) => this.offer(candidate) });
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

  requireUsable(): void {
    if (this.fatal) throw this.fatal.cause;
    if (!this.accepting) throw this.fenceCause ?? new AgentProviderContractError(this.providerKey,
      this.state === "closed" ? "session_closed" : "session_unusable", "Session interactions no longer permit provider mutation.");
  }

  private offer(candidate: AgentSessionInteraction): Promise<void> {
    let captured: ReturnType<typeof captureSessionInteractionCandidate>;
    try {
      captured = captureSessionInteractionCandidate(candidate, (terminal) => { this.track(terminal); });
      const validated = validateSessionInteractionCandidate(captured, this.sessionId, this.limits.requestTimeoutMs);
      this.requireUsable();
      if (validated.signal.aborted) throw interactionContractError(this.providerKey, "Provider offered an unavailable session interaction.");
      const bytes = Buffer.byteLength(JSON.stringify(validated.request), "utf8");
      if (this.requests.has(validated.request.requestId) || this.requests.size >= this.limits.maxRetainedRequests
        || this.retainedBytes + bytes > this.limits.maxRetainedBytes) {
        throw interactionContractError(this.providerKey, "Session interaction identity or retained capacity is unavailable.");
      }
      const request = new SessionInteractionRequest(this, validated, () => {
        this.requests.delete(validated.request.requestId);
        this.retainedBytes -= bytes;
      });
      this.requests.set(validated.request.requestId, request);
      this.retainedBytes += bytes;
      request.observe();
      let callback: Promise<void>;
      try { callback = Promise.resolve(this.context.onRequest(request.handle)); }
      catch (cause) {
        callback = Promise.reject(cause);
      }
      request.setCallback(callback);
      this.track(callback);
      void callback.catch((cause) => this.fail(cause));
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

  installClose(close: () => Promise<void>): void { this.automaticClose = close; }

  adopt(): void {
    this.requireUsable();
    this.removeOpeningAbort();
    this.state = "open";
    this.adopted = true;
  }

  fence(cause: unknown, source: SessionInteractionRequest): void {
    if (!this.accepting) return;
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
    this.removeOpeningAbort();
    this.controller.abort(new DOMException("The session interaction owner was stopped.", "AbortError"));
    for (const request of this.requests.values()) request.stop(terminal);
  }

  async join(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
    await Promise.all([...this.requests.values()].map((request) => request.join()));
  }

  close(cleanup: () => MaybePromise<void>, explicit: boolean): Promise<void> {
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
  support: AgentSessionInteractionSupport; context?: AgentSessionInteractionContext; signal?: AbortSignal;
}>): SessionInteractionOwner | undefined {
  if (input.context === undefined) return undefined;
  if (input.support.kind === "unsupported" || !input.support.openingOperations.includes(input.operation)) {
    throw new AgentProviderContractError(input.providerKey, "session_interactions_unsupported",
      "Provider does not support session interactions for this opening operation.");
  }
  return new SessionInteractionOwner(input.providerKey, input.sessionId, input.context, input.signal);
}
