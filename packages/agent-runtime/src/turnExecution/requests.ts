import type { AgentProviderKey, AgentRequest, AgentTurnId } from "@agen-ai/agent-protocol";
import { throwAgentProviderContractError } from "../contractErrors.js";
import type { AgentSessionAdmission } from "../sessionAdmission.js";

export interface PendingAgentRequest {
  readonly request: AgentRequest;
  readonly turnId: AgentTurnId;
}

export interface SuspendedAgentTurnRequests {
  readonly restore: () => void;
  readonly withdraw: () => void;
}

type RequestEligibility =
  | Readonly<{ kind: "pending" | "withheld"; pending: PendingAgentRequest }>
  | Readonly<{ kind: "claimed"; pending: PendingAgentRequest; attempt: symbol }>
  | Readonly<{ kind: "retired" }>;

interface RequestEntry {
  eligibility: RequestEligibility;
  canonicalRetirementObserved: boolean;
  readonly suspensions: Set<symbol>;
}

export function createAgentTurnRequestAdmission(input: Readonly<{
  providerKey: AgentProviderKey;
  sessionAdmission: AgentSessionAdmission;
  pendingRequests: Map<string, PendingAgentRequest>;
  canRestore: () => boolean;
  canRestoreRequest: (pending: PendingAgentRequest) => boolean;
}>) {
  const requests = new Map<string, RequestEntry>();
  const invalidSequence = (message: string): never =>
    throwAgentProviderContractError(input.providerKey, "invalid_turn_sequence", message);
  const retire = (requestId: string, entry: RequestEntry): void => {
    entry.eligibility = { kind: "retired" };
    entry.suspensions.clear();
    input.pendingRequests.delete(requestId);
  };
  const restoreReadyRequest = (): void => {
    if (!input.canRestore() || input.pendingRequests.size > 0) return;
    for (const [requestId, entry] of requests) {
      if (entry.eligibility.kind !== "withheld" || entry.suspensions.size > 0) continue;
      const pending = entry.eligibility.pending;
      if (!input.canRestoreRequest(pending)) { retire(requestId, entry); continue; }
      entry.eligibility = { kind: "pending", pending };
      input.pendingRequests.set(requestId, pending);
      return;
    }
  };
  const withdraw = (): void => {
    for (const [requestId, entry] of requests) retire(requestId, entry);
  };
  const claim = (requestId: string, pending: PendingAgentRequest) => {
    const entry = requests.get(requestId);
    if (!entry || entry.eligibility.kind !== "pending" || entry.eligibility.pending !== pending) {
      return throwAgentProviderContractError(input.providerKey, "request_resolution_mismatch",
        "Resolution does not identify an answerable request in this execution.");
    }
    const attempt = Symbol("request response");
    entry.eligibility = { kind: "claimed", pending, attempt };
    input.pendingRequests.delete(requestId);
    restoreReadyRequest();
    return {
      restore(): void {
        if (entry.eligibility.kind !== "claimed" || entry.eligibility.attempt !== attempt || !input.canRestore()) return;
        entry.eligibility = { kind: "withheld", pending };
        restoreReadyRequest();
      },
      retire(): void {
        if (entry.eligibility.kind !== "claimed" || entry.eligibility.attempt !== attempt) return;
        retire(requestId, entry);
        restoreReadyRequest();
      },
    };
  };
  const suspend = (): SuspendedAgentTurnRequests => {
    const token = Symbol("interruption");
    const affected: RequestEntry[] = [];
    for (const [requestId, entry] of requests) {
      if (entry.eligibility.kind === "retired") continue;
      affected.push(entry);
      entry.suspensions.add(token);
      if (entry.eligibility.kind === "pending") {
        entry.eligibility = { kind: "withheld", pending: entry.eligibility.pending };
        input.pendingRequests.delete(requestId);
      }
    }
    let settled = false;
    return {
      restore(): void {
        if (settled) return;
        settled = true;
        for (const entry of affected) entry.suspensions.delete(token);
        restoreReadyRequest();
      },
      withdraw(): void {
        if (settled) return;
        settled = true;
        withdraw();
      },
    };
  };
  return {
    claim, suspend, withdraw,
    open(pending: PendingAgentRequest): void {
      if (input.pendingRequests.size > 0) invalidSequence("Provider opened more than one pending request for a session.");
      const requestId = pending.request.requestId;
      input.sessionAdmission.claimRequest(requestId, "invalid_turn_sequence");
      requests.set(requestId, { eligibility: { kind: "pending", pending }, canonicalRetirementObserved: false,
        suspensions: new Set() });
      input.pendingRequests.set(requestId, pending);
    },
    unavailable(requestId: string): void {
      const entry = requests.get(requestId);
      if (!entry) return invalidSequence("Provider retired a request not opened in this execution.");
      if (entry.canonicalRetirementObserved) return invalidSequence("Provider retired the same request more than once.");
      entry.canonicalRetirementObserved = true;
      retire(requestId, entry);
      restoreReadyRequest();
    },
    *unclaimedRequests(): Iterable<PendingAgentRequest> {
      for (const entry of requests.values()) {
        if (entry.eligibility.kind === "pending" || entry.eligibility.kind === "withheld") yield entry.eligibility.pending;
      }
    },
    hasUnclaimedRequest(): boolean {
      for (const entry of requests.values()) {
        if (entry.eligibility.kind === "pending" || entry.eligibility.kind === "withheld") return true;
      }
      return false;
    },
    hasOpened(requestId: string): boolean { return requests.has(requestId); },
  };
}

export type AgentTurnRequestAdmission = ReturnType<typeof createAgentTurnRequestAdmission>;
