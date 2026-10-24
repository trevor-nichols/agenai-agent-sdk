import { AgentHistoryError } from '../../lifecycle/errors.js';

export async function grokRequest<T>(operation: () => Promise<T>, signal: AbortSignal, state = false): Promise<T> {
  signal.throwIfAborted();
  try { return await operation(); }
  catch (error) {
    if (error instanceof AgentHistoryError) throw error;
    if (signal.aborted) throw new AgentHistoryError('cancelled', 'The Grok history request was cancelled.');
    if (error !== null && typeof error === 'object') {
      if ('code' in error && error.code === -32602 && state && 'data' in error && error.data === 'session not found') {
        throw new AgentHistoryError('not_found', 'The saved Grok session is missing.');
      }
      if ('code' in error && error.code === -32601) throw new AgentHistoryError('unsupported_scope', 'The Grok peer does not implement the required history method.');
      if ('reasonCode' in error && typeof error.reasonCode === 'string') {
        if (error.reasonCode === 'acp_request_deadline_exceeded') throw new AgentHistoryError('deadline_exceeded', 'The Grok history request exceeded its deadline.');
        if (error.reasonCode === 'acp_request_aborted') throw new AgentHistoryError('cancelled', 'The Grok history request was cancelled.');
        if (error.reasonCode === 'acp_stdout_frame_too_large' || error.reasonCode.endsWith('_limit_exceeded')) {
          throw new AgentHistoryError('limit_exhausted', 'The Grok response exceeds its bounded transport policy.');
        }
      }
    }
    throw new AgentHistoryError('native_failure', 'The native Grok history request failed.');
  }
}
