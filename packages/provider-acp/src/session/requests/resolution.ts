import type { AcpJsonValue } from '@agen-ai/acp-transport';
import { parseAgentRequestResolutionFor } from '@agen-ai/agent-protocol';
import type { AgentProviderResolveRequestInput, AgentRequestResolutionResult } from '@agen-ai/agent-runtime';

import { AcpProviderSessionError } from '../errors.js';
import type { NativeTurn } from '../turn.js';
import { canceledRequestReply, type PendingSessionRequests, type PendingSessionRequest } from './pending.js';

export function resolveAcpRequest(
  requests: PendingSessionRequests,
  turn: NativeTurn,
  request: PendingSessionRequest,
  mapped: NonNullable<PendingSessionRequest['mapped']>,
  input: AgentProviderResolveRequestInput,
): AgentRequestResolutionResult {
  const resolution = parseAgentRequestResolutionFor(mapped.request, input.resolution);
  if (!requests.canAnswer(request)) return requestUnavailable();
  let reply: AcpJsonValue | undefined;
  if (mapped.kind === 'permission') {
    if (resolution.requestKind !== 'approval') throw new AcpProviderSessionError('acp_request_kind_invalid', 'The ACP permission requires approval resolution.');
    const nativeId = resolution.disposition === 'selected' ? mapped.permission.nativeOptions.get(resolution.optionId) : undefined;
    if (resolution.disposition === 'selected' && nativeId === undefined) throw new AcpProviderSessionError('acp_option_not_offered', 'The ACP permission option was not offered.');
    reply = resolution.disposition === 'selected' ? { outcome: { outcome: 'selected', optionId: nativeId! } } : canceledRequestReply('permission');
  } else {
    reply = mapped.flow.resolve(resolution);
    request.mapped = { ...mapped, request: mapped.flow.request };
  }
  if (reply !== undefined && !requests.answer(request, reply)) return requestUnavailable();
  turn.waiting = undefined;
  turn.transition = reply === undefined ? { nextRequest: request } : {};
  return { status: 'delivered' };
}

function requestUnavailable(): AgentRequestResolutionResult {
  return { status: 'rejected', requestState: 'unavailable', error: {
    category: 'invalid_request', code: 'acp_request_not_pending',
    message: 'The ACP request callback is no longer available.', recovery: { kind: 'none' },
  } };
}
