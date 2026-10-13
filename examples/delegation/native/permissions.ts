import type { AgentApprovalRequest, AgentItemSnapshot } from '@agen-ai/agent-protocol';
import { NativeQualificationError } from './host-contracts.js';
import type { NativeManagedPermissionTool } from './permission-contracts.js';

/** Derived only after the caller validates the complete selected native permission proof. */
export interface NativeParentPermissionPolicy {
  readonly profile: 'grok-1.0.50-managed-mcp-once-v1';
  readonly proofDigest: string;
  readonly executableSha256: string;
}

export function captureParentPermissionPolicy(policy: NativeParentPermissionPolicy | undefined, executableSha256: string): NativeParentPermissionPolicy | undefined {
  if (!policy) return undefined;
  if (policy.profile !== 'grok-1.0.50-managed-mcp-once-v1' || !/^sha256:[a-f0-9]{64}$/u.test(policy.proofDigest)
    || policy.executableSha256 !== executableSha256) throw new NativeQualificationError('approval_not_authorized');
  return Object.freeze({ ...policy });
}

export function selectManagedParentPermission(request: AgentApprovalRequest, item: AgentItemSnapshot | undefined) {
  if (request.subject.kind !== 'tool' || !item || request.subject.itemId !== item.itemId
    || item.itemKind !== 'dynamic_tool_call' || (item.status !== 'pending' && item.status !== 'in_progress')
    || item.details?.toolName !== undefined || request.subject.title !== item.title || request.prompt !== item.title) {
    throw new NativeQualificationError('approval_not_authorized');
  }
  const toolName: NativeManagedPermissionTool = item.title === 'agenai_delegation__delegation_targets' ? 'delegation_targets'
    : item.title === 'agenai_delegation__delegate_task' ? 'delegate_task'
      : (() => { throw new NativeQualificationError('approval_not_authorized'); })();
  const approved = request.options.filter((option) => option.decision === 'approved');
  const option = approved[0];
  if (approved.length !== 1 || !option || option.label !== 'allow once' || option.persistence !== 'once'
    || option.scope.kind !== 'exact_action') throw new NativeQualificationError('approval_not_authorized');
  return { toolName, option, item, itemStatus: item.status };
}
