import type { AgentInstanceId } from '@agen-ai/agent-protocol';
import type { AgentApprovalPolicyKind } from '@agen-ai/agent-runtime';

export type GrokDockerApprovalPolicy = Extract<AgentApprovalPolicyKind, 'host' | 'provider_auto_review' | 'provider_bypass'>;

/** One fresh native process and session, with its policy fixed before launch. */
export interface GrokDockerApprovalIdentity {
  readonly instanceId: AgentInstanceId;
  readonly nativeSessionId: string;
  readonly policy: GrokDockerApprovalPolicy;
}
