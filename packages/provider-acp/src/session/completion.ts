import type { AcpResponseReceived } from '@agen-ai/acp-transport';
import type { AgentError, AgentTurnCompletedPayload } from '@agen-ai/agent-protocol';

import { AcpProviderSessionError } from './errors.js';
import { nativeObject, nativeString } from './native.js';

export function acpTurnCompletion(response: AcpResponseReceived, cancelReason: string | undefined): AgentTurnCompletedPayload {
  if (response.kind === 'error') return {
    structuredOutput: { kind: 'not_requested' },
    outcome: 'failed', error: promptFailure(response.error.code),
  };
  const reason = nativeString(nativeObject(response.result, 'prompt response').stopReason, 'prompt stop reason');
  if (reason === 'cancelled') return { structuredOutput: { kind: 'not_requested' }, outcome: cancelReason === 'timeout' ? 'expired' : 'canceled' };
  if (reason === 'end_turn') return { structuredOutput: { kind: 'not_requested' }, outcome: 'completed' };
  if (reason === 'max_tokens') return { structuredOutput: { kind: 'not_requested' }, outcome: 'completed', reason: 'The agent reached its token limit.' };
  if (reason === 'max_turn_requests') return { structuredOutput: { kind: 'not_requested' }, outcome: 'completed', reason: 'The agent reached its request limit.' };
  if (reason === 'refusal') return { structuredOutput: { kind: 'not_requested' }, outcome: 'completed', reason: 'The agent declined the request.' };
  throw new AcpProviderSessionError('acp_stop_reason_invalid', 'ACP returned an unsupported prompt stop reason.');
}

/** Only schema-v1.23.0 standard meanings apply to this provider's fixed stable profile. */
function promptFailure(code: number): AgentError {
  switch (code) {
    case -32000: return {
      category: 'authentication', code: 'authentication_required', message: 'The agent requires authentication before accepting the prompt.',
      recovery: { kind: 'user_action', action: 'authenticate' },
    };
    case -32602: return {
      category: 'invalid_request', code: 'invalid_request', message: 'The agent rejected the prompt parameters.',
      recovery: { kind: 'unknown' },
    };
    case -32603: return {
      category: 'provider', code: 'provider_internal_error', message: 'The agent encountered an internal error while processing the prompt.',
      recovery: { kind: 'unknown' },
    };
    case -32700:
    case -32600:
    case -32601: return {
      category: 'protocol', code: 'provider_protocol_error', message: 'The agent rejected the prompt protocol request.',
      recovery: { kind: 'unknown' },
    };
    default: return {
      category: 'unknown', code: 'provider_request_failed', message: 'The agent rejected the prompt request.',
      recovery: { kind: 'unknown' },
    };
  }
}
