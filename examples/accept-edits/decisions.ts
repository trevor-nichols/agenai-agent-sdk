import type { AgentApprovalRequest, AgentRequest, AgentRequestResolution } from '@agen-ai/agent-protocol';
import type { NodeProviderToolApprovalRequest } from '@agen-ai/provider-tools/node';
import { z } from 'zod/v4';
import type { AcceptEditsApprovals } from './config.js';

export type AcceptEditsAction = NodeProviderToolApprovalRequest;
export type AcceptEditsDecision = 'approve_once' | 'deny_once';
export type AcceptEditsDecider = (action: AcceptEditsAction, signal: AbortSignal) => AcceptEditsDecision | Promise<AcceptEditsDecision>;

const action = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), command: z.string().min(1) }),
  z.strictObject({ kind: z.literal('edit'), paths: z.array(z.string().min(1)).min(1), reason: z.enum(['host_policy', 'restricted']) }),
  z.strictObject({ kind: z.literal('read'), path: z.string().min(1) }),
]);
const context = z.object({ data: z.strictObject({ action }) });

/**
 * Reads the exact action the owned tools are waiting on. Display text is never parsed; a request
 * without this provider context is treated as unknown and can only be denied.
 */
export function exactAction(request: AgentRequest, requestContext: unknown): AcceptEditsAction | undefined {
  if (request.requestKind !== 'approval') return undefined;
  const parsed = context.safeParse(requestContext);
  return parsed.success ? Object.freeze(parsed.data.data.action) : undefined;
}

/**
 * Selects the one option whose consequence is exactly this action, once. A request that does not
 * offer exactly one such option is canceled rather than answered with a broader grant.
 */
export function onceResolution(request: AgentApprovalRequest, decision: AcceptEditsDecision): Readonly<{ resolution: AgentRequestResolution; exact: boolean }> {
  const wanted = decision === 'approve_once' ? 'approved' : 'denied';
  const matches = request.options.filter((option) => option.decision === wanted && option.consequence.kind === 'scoped'
    && option.consequence.persistence === 'once' && option.consequence.scope.kind === 'exact_action');
  const [choice] = matches;
  if (matches.length !== 1 || !choice) {
    return { resolution: { requestKind: 'approval', requestId: request.requestId, disposition: 'canceled' }, exact: false };
  }
  return { resolution: { requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: choice.optionId }, exact: true };
}

/** Approves only byte-identical commands and listed paths; everything else is denied once. */
export function exactListDecider(approvals: Extract<AcceptEditsApprovals, { kind: 'exact' }>): AcceptEditsDecider {
  const commands = new Set(approvals.commands);
  const edits = new Set(approvals.edits);
  const reads = new Set(approvals.reads);
  return (candidate) => {
    switch (candidate.kind) {
      case 'command': return commands.has(candidate.command) ? 'approve_once' : 'deny_once';
      case 'edit': return candidate.paths.every((path) => edits.has(path)) ? 'approve_once' : 'deny_once';
      case 'read': return reads.has(candidate.path) ? 'approve_once' : 'deny_once';
    }
  };
}
