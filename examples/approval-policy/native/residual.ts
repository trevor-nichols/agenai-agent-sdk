import type { AgentApprovalRequest, AgentRequestResolution } from '@agen-ai/agent-protocol';
import type { ResidualDecision } from './config.js';

export function residualResolution(request: AgentApprovalRequest, decision: ResidualDecision): Readonly<{ resolution: AgentRequestResolution; refused: boolean }> {
  const cancelled: AgentRequestResolution = { requestKind: 'approval', requestId: request.requestId, disposition: 'canceled' };
  if (decision.kind === 'cancel') return { resolution: cancelled, refused: false };
  const matches = request.options.filter((option) => option.decision === (decision.kind === 'approve_once' ? 'approved' : 'denied')
    && option.consequence.kind === 'scoped' && option.consequence.persistence === 'once' && option.consequence.scope.kind === 'exact_action');
  const [choice] = matches;
  if (matches.length !== 1 || !choice) return { resolution: cancelled, refused: true };
  return { resolution: { requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: choice.optionId }, refused: false };
}
