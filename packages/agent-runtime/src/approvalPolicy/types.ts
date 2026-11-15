export type AgentApprovalPolicy =
  | Readonly<{ kind: "host" }>
  | Readonly<{ kind: "provider_accept_edits" }>
  | Readonly<{ kind: "provider_auto_review" }>
  | Readonly<{ kind: "provider_bypass" }>;

export type AgentApprovalPolicyKind = AgentApprovalPolicy["kind"];
export type AgentApprovalPolicyOperation = "create" | "resume" | "branch";

export interface AgentApprovalPolicyDescriptor {
  readonly policy: AgentApprovalPolicyKind;
  readonly operations: readonly [AgentApprovalPolicyOperation, ...AgentApprovalPolicyOperation[]];
}

export type AgentApprovalPolicySupport =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      policies: readonly [AgentApprovalPolicyDescriptor, ...AgentApprovalPolicyDescriptor[]];
    }>;

export interface AgentSessionApprovalPolicy {
  readonly policy: AgentApprovalPolicy;
  readonly verification: "native_observation" | "controlled_configuration";
}
