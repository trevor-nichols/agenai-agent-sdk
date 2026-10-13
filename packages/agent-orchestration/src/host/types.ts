// ------------------------------------------------------------------------------------------------
//                types.ts - Trusted registry, resource and authority composition
// ------------------------------------------------------------------------------------------------

import type { AgentArtifactCandidate, AgentProviderRegistry, AgentProviderSession, AgentSessionHostBinding, MaybePromise } from "@agen-ai/agent-runtime";
import type { AgentConfigurationCatalog, AgentRequest, AgentSessionBinding, AgentSessionConfiguration } from "@agen-ai/agent-protocol";
import type { DelegationTarget, DelegationTargetCatalog, DelegationTargetReference } from "../catalog/types.js";
import type { DelegationPolicySnapshot } from "../policy/types.js";
import type { DelegationParentScope, DelegationResultReference, DelegationRunRecord, DelegationTaskRecord } from "../tasks/types.js";

export interface DelegationExecutionLease {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly release: () => MaybePromise<void>;
}

export interface DelegationHostPolicy {
  readonly scope: DelegationParentScope;
  readonly catalog: DelegationTargetCatalog;
  readonly policy: DelegationPolicySnapshot;
}

export interface DelegationContinuation {
  readonly runId: string;
  readonly binding: AgentSessionBinding;
  readonly target: DelegationTarget;
}

export interface DelegationChildResources {
  readonly workingDirectory: Readonly<{
    policy: "shared" | "isolated";
    authorizedRef: string;
    path: string;
  }>;
  readonly hostBinding?: AgentSessionHostBinding;
  readonly continuation?: Readonly<{ kind: "resume"; allowTargetChange: boolean }>;
  /** Owns unclaimed binding cleanup; shares once-success release state with hostBinding.release. */
  readonly release: () => MaybePromise<void>;
}

export interface DelegationAppliedConfiguration {
  readonly target: DelegationTargetReference;
  readonly configuration: AgentSessionConfiguration;
}

declare const requestHandleBrand: unique symbol;
export interface DelegationHostRequestHandle {
  readonly [requestHandleBrand]: true;
}

export interface DelegationHostRequest {
  readonly handle: DelegationHostRequestHandle;
  readonly task: DelegationTaskRecord;
  readonly run: DelegationRunRecord;
  readonly request: AgentRequest;
}

export interface DelegationHost {
  readonly registry: AgentProviderRegistry;
  readonly currentPolicy: (scope: DelegationParentScope) => DelegationHostPolicy;
  readonly assertResultAccess: (input: Readonly<{ scope: DelegationParentScope; task?: DelegationTaskRecord }>) => void;
  readonly assertControl: (input: Readonly<{ scope: DelegationParentScope; task: DelegationTaskRecord }>) => void;
  readonly assertRequestAccess: (input: DelegationHostRequest) => void;
  readonly acquireExecution: (input: Readonly<{
    scope: DelegationParentScope;
    task: DelegationTaskRecord;
    run: DelegationRunRecord;
    target: DelegationTarget;
    signal: AbortSignal;
  }>) => MaybePromise<DelegationExecutionLease>;
  readonly acquireChildResources: (input: Readonly<{
    scope: DelegationParentScope;
    task: DelegationTaskRecord;
    run: DelegationRunRecord;
    target: DelegationTarget;
    continuation?: DelegationContinuation;
    signal: AbortSignal;
  }>) => MaybePromise<DelegationChildResources>;
  readonly verifyAppliedConfiguration: (input: Readonly<{
    task: DelegationTaskRecord;
    run: DelegationRunRecord;
    target: DelegationTarget;
    session: AgentProviderSession;
    observedConfiguration?: AgentConfigurationCatalog;
    signal: AbortSignal;
  }>) => MaybePromise<DelegationAppliedConfiguration>;
  readonly onRequest: (input: DelegationHostRequest & Readonly<{ signal: AbortSignal }>) => MaybePromise<void>;
  readonly publishArtifact?: (input: Readonly<{
    task: DelegationTaskRecord;
    run: DelegationRunRecord;
    candidate: AgentArtifactCandidate;
    signal: AbortSignal;
  }>) => MaybePromise<DelegationResultReference>;
}
