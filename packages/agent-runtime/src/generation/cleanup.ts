import { AgentProviderSessionCleanupError } from "../contractErrors.js";
import type { AgentProviderSession } from "../sessions.js";
import { AGENT_GENERATION_CLEANUP_TIMEOUT_MS, waitForGenerationWork } from "./deadline.js";

export function createGenerationCleanupOwner(input: Readonly<{
  turnId: Parameters<Extract<AgentProviderSession["interruption"], { kind: "supported" }>["interruptTurn"]>[0]["turnId"];
  stopCallbacks: () => void;
}>) {
  const pending = new Set<Promise<unknown>>();
  let opening: Promise<AgentProviderSession> | undefined;
  let session: AgentProviderSession | undefined;
  let openingCleanup: AgentProviderSessionCleanupError | undefined;
  let entered = false;
  let terminal = false;
  let interrupted = false;
  let stopping = false;
  let closed = false;
  let close: Promise<void> | undefined;
  let closeFailed = false;
  let attempt: Promise<void> | undefined;
  let cleanupSignal: AbortSignal | undefined;

  function retain<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }

  function startSessionCleanup(failed: boolean): void {
    if (!session || closed) return;
    if (failed && entered && !terminal && !interrupted && session.interruption.kind === "supported") {
      interrupted = true;
      try {
        retain(Promise.resolve(session.interruption.interruptTurn({ turnId: input.turnId, reason: "other",
          ...(cleanupSignal === undefined ? {} : { signal: cleanupSignal }),
        })));
      } catch { /* Close remains the native quiescence owner after an unavailable interruption. */ }
    }
    if (close) return;
    try { close = Promise.resolve(session.close({ reason: failed ? "error" : "idle", ...(cleanupSignal === undefined ? {} : { signal: cleanupSignal }) })); }
    catch (error) { close = Promise.reject(error); }
    const current = close;
    retain(current);
    void current.then(() => { closed = true; }, () => { if (close === current) closeFailed = true; });
  }

  return {
    retain,
    setOpening(work: Promise<AgentProviderSession>): void {
      opening = work;
      retain(work);
      void work.then((opened) => {
        session = opened;
        if (stopping) startSessionCleanup(true);
      }, (error: unknown) => {
        if (error instanceof AgentProviderSessionCleanupError) openingCleanup = error;
      });
    },
    markEntered(): void { entered = true; },
    markTerminal(): void { terminal = true; },
    cleanup(failed: boolean): Promise<void> {
      if (attempt) return attempt;
      stopping = true;
      if (closeFailed) { close = undefined; closeFailed = false; }
      input.stopCallbacks();
      const controller = new AbortController();
      cleanupSignal = controller.signal;
      const expiresAt = Date.now() + AGENT_GENERATION_CLEANUP_TIMEOUT_MS;
      const timeoutError = new Error("Object generation cleanup exceeded its deadline.");
      const timeout = setTimeout(() => controller.abort(timeoutError), AGENT_GENERATION_CLEANUP_TIMEOUT_MS);
      // Invoke native shutdown before joining any reader, handler, or response promise.
      startSessionCleanup(failed);
      const drain = async (): Promise<void> => {
        if (opening) {
          try { session = await opening; }
          catch (error) { if (error instanceof AgentProviderSessionCleanupError) openingCleanup = error; }
        }
        if (openingCleanup) await openingCleanup.retryCleanup();
        startSessionCleanup(failed);
        if (close) await close;
        while (pending.size > 0) await Promise.allSettled([...pending]);
      };
      const work = waitForGenerationWork(drain(), controller.signal).then(() => {
        if (Date.now() >= expiresAt) throw timeoutError;
      }).finally(() => {
        clearTimeout(timeout);
        cleanupSignal = undefined;
        attempt = undefined;
      });
      attempt = work;
      return work;
    },
  };
}

export type GenerationCleanupOwner = ReturnType<typeof createGenerationCleanupOwner>;
