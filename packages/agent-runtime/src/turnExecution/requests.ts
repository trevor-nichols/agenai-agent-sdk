// ------------------------------------------------------------------------------------------------
//                requests.ts - Exact callback admission across response and interruption outcomes
// ------------------------------------------------------------------------------------------------

import type { AgentRequest, AgentTurnId } from "@agen-ai/agent-protocol";

export interface PendingAgentRequest {
  readonly request: AgentRequest;
  readonly turnId: AgentTurnId;
}

export interface SuspendedAgentTurnRequests {
  readonly restore: () => void;
  readonly withdraw: () => void;
}

interface RequestAdmissionGeneration {
  readonly suspensions: Set<symbol>;
  readonly withheldRequests: Map<string, PendingAgentRequest>;
}

function createRequestAdmissionGeneration(): RequestAdmissionGeneration {
  return { suspensions: new Set(), withheldRequests: new Map() };
}

export function createAgentTurnRequestAdmission(input: Readonly<{
  pendingRequests: Map<string, PendingAgentRequest>;
  canRestore: () => boolean;
}>) {
  let generation = createRequestAdmissionGeneration();
  const withdraw = () => {
    generation = createRequestAdmissionGeneration();
    input.pendingRequests.clear();
  };
  const restoreReadyRequests = (requestGeneration: RequestAdmissionGeneration) => {
    if (requestGeneration !== generation || !input.canRestore()
      || requestGeneration.suspensions.size > 0 || input.pendingRequests.size > 0) return;
    for (const [requestId, pending] of requestGeneration.withheldRequests) {
      input.pendingRequests.set(requestId, pending);
    }
    requestGeneration.withheldRequests.clear();
  };
  const claim = (requestId: string, pending: PendingAgentRequest): (() => void) => {
    const claimedGeneration = generation;
    input.pendingRequests.delete(requestId);
    return () => {
      if (claimedGeneration !== generation || !input.canRestore()) return;
      claimedGeneration.withheldRequests.set(requestId, pending);
      restoreReadyRequests(claimedGeneration);
    };
  };
  const suspend = (): SuspendedAgentTurnRequests => {
    const suspendedGeneration = generation;
    const suspension = Symbol("interruption");
    suspendedGeneration.suspensions.add(suspension);
    for (const [requestId, pending] of input.pendingRequests) {
      suspendedGeneration.withheldRequests.set(requestId, pending);
    }
    input.pendingRequests.clear();
    return {
      restore() {
        if (!suspendedGeneration.suspensions.delete(suspension)) return;
        restoreReadyRequests(suspendedGeneration);
      },
      withdraw() {
        if (!suspendedGeneration.suspensions.delete(suspension)) return;
        if (suspendedGeneration === generation) withdraw();
      },
    };
  };
  return {
    claim, suspend, withdraw,
    observeRequest() { generation = createRequestAdmissionGeneration(); },
  };
}
