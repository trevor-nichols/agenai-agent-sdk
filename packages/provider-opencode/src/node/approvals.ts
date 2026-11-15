// ------------------------------------------------------------------------------------------------
//                approvals.ts - One turn's pending host approvals: opening, withdrawal and resolution
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { parseAgentRequestId, parseAgentRequestResolutionFor, type AgentItemId, type AgentRequest } from '@agen-ai/agent-protocol';
import type { AgentProviderResolveRequestInput, AgentRequestResolutionResult } from '@agen-ai/agent-runtime';
import type { NodeProviderToolApprovalRequest } from '@agen-ai/provider-tools/node';
import { APPROVE_ONCE, buildApproval, turnError, type turnEvents } from './events.js';

export type TurnOutput = (type: string, payload: unknown, options?: Parameters<ReturnType<typeof turnEvents>>[2]) => void;

interface PendingRequest { readonly request: AgentRequest; readonly decide: (decision: 'approved' | 'denied') => void }

/** Every decision is once-only; an aborted signal withdraws its request and denies the action. */
export class TurnApprovals {
  private readonly requests = new Map<string, PendingRequest>();

  constructor(private readonly output: TurnOutput) {}

  open(itemId: AgentItemId, action: NodeProviderToolApprovalRequest, signal: AbortSignal): Promise<'approved' | 'denied'> {
    const requestId = parseAgentRequestId(`opencode-request:${randomUUID()}`);
    const built = buildApproval(requestId, itemId, action);
    if (!built || signal.aborted) {
      if (!built) this.output('provider.diagnostic', { code: 'approval_action_oversized', message: 'The exact action exceeds the approval context bound and was refused.' });
      return Promise.resolve('denied');
    }
    return new Promise((resolve) => {
      this.requests.set(requestId, { request: built.request, decide: resolve });
      this.output('request.opened', { request: built.request }, { requestContext: built.context });
      this.output('turn.state_changed', { state: 'waiting_for_request', requestId });
      signal.addEventListener('abort', () => {
        if (!this.requests.delete(requestId)) return;
        this.output('request.unavailable', { requestId, reason: signal.reason === 'expired' ? 'expired' : 'withdrawn' });
        this.output('turn.state_changed', { state: 'running' });
        resolve('denied');
      }, { once: true });
    });
  }

  resolve(input: AgentProviderResolveRequestInput): AgentRequestResolutionResult {
    const pending = this.requests.get(input.resolution.requestId);
    if (!pending) return { status: 'rejected', requestState: 'unavailable', error: turnError('invalid_request', 'request_unavailable', 'The approval request is no longer pending.') };
    let resolution;
    try { resolution = parseAgentRequestResolutionFor(pending.request, input.resolution); } catch {
      return { status: 'rejected', requestState: 'pending', error: turnError('invalid_request', 'resolution_invalid', 'The resolution does not answer this approval request.') };
    }
    input.onProviderExecutionStarted?.();
    this.requests.delete(resolution.requestId);
    this.output('turn.state_changed', { state: 'running' });
    pending.decide(resolution.disposition === 'selected' && resolution.optionId === APPROVE_ONCE ? 'approved' : 'denied');
    return { status: 'delivered' };
  }
}
