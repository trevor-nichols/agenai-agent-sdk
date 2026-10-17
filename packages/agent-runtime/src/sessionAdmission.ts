import type { AgentProviderKey, AgentRequestId } from "@agen-ai/agent-protocol";
import { throwAgentProviderContractError } from "./contractErrors.js";

const MAX_REQUEST_IDENTITIES = 4_096;
const MAX_REQUEST_ID_BYTES = 1_048_576;

export function createAgentSessionAdmission<Execution = unknown>(providerKey: AgentProviderKey) {
  const requestIds = new Set<AgentRequestId>();
  let requestIdBytes = 0;
  type Slot = { readonly token: object; readonly kind: "reserved" } | { readonly token: object; readonly kind: "installed"; readonly execution: Execution };
  let slot: Slot | undefined;
  let stopped = false;
  return {
    reserveExecution(): object {
      if (stopped) throwAgentProviderContractError(providerKey, "session_unusable", "Session admission is stopped.");
      if (slot) throwAgentProviderContractError(providerKey, "concurrent_turn", "Provider session already owns an execution.");
      const token = Object.freeze({});
      slot = { kind: "reserved", token };
      return token;
    },
    installExecution(token: object, execution: Execution): void {
      if (stopped || !slot || slot.token !== token || slot.kind !== "reserved") {
        throwAgentProviderContractError(providerKey, "invalid_native_continuation", "Execution reservation is no longer installable.");
      }
      slot = { kind: "installed", token, execution };
    },
    releaseExecution(token: object): void { if (slot?.token === token) slot = undefined; },
    get execution(): Execution | null { return slot?.kind === "installed" ? slot.execution : null; },
    ownsExecution(token: object): boolean { return !stopped && slot?.token === token; },
    stop(): void { stopped = true; },

    claimRequest(requestId: AgentRequestId, duplicateCode: "invalid_turn_sequence" | "invalid_session_interaction"): void {
      if (requestIds.has(requestId)) {
        throwAgentProviderContractError(providerKey, duplicateCode, "Provider reused a request ID within this session generation.");
      }
      const bytes = Buffer.byteLength(requestId, "utf8");
      if (requestIds.size >= MAX_REQUEST_IDENTITIES || requestIdBytes + bytes > MAX_REQUEST_ID_BYTES) {
        throwAgentProviderContractError(providerKey, "request_identity_limit_exceeded",
          "Provider exceeded this session generation's bounded request identity capacity.");
      }
      requestIds.add(requestId);
      requestIdBytes += bytes;
    },
  };
}

export type AgentSessionAdmission = Pick<ReturnType<typeof createAgentSessionAdmission>, "claimRequest">;
