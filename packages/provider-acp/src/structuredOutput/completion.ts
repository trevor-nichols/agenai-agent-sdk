import type { AcpJsonObject, AcpResponseReceived } from '@agen-ai/acp-transport';
import type { AgentOutputSchema, AgentStructuredOutputResult, AgentStructuredOutputUnavailableReason, AgentTurnCompletedPayload } from '@agen-ai/agent-protocol';
import { createAgentStructuredOutputCandidate } from '@agen-ai/agent-runtime';
import { AcpProviderSessionError } from '../session/errors.js';
import { nativeBytes, nativeObject } from '../session/native.js';

const GROK_STRUCTURED_METADATA_BYTES_LIMIT = 32_768;
const GROK_STRUCTURED_ERROR_BYTES_LIMIT = 4_096;

/** The existing transport owns JSON-RPC response correlation and safe JSON/frame parsing. */
function structuredOutputResult(
  response: AcpResponseReceived,
  schema: AgentOutputSchema | undefined,
  nativeSessionId: string,
): AgentStructuredOutputResult {
  if (!schema) return { kind: 'not_requested' };
  const unavailable = (reason: AgentStructuredOutputUnavailableReason) => createAgentStructuredOutputCandidate({
    schema, candidate: { kind: 'unavailable', reason },
  });
  if (response.kind === 'error') return unavailable('provider_error');
  const result = nativeObject(response.result, 'structured prompt response');
  const meta: AcpJsonObject | undefined = result._meta === undefined ? undefined : nativeObject(result._meta, 'structured response metadata');
  if (meta && nativeBytes(meta) > GROK_STRUCTURED_METADATA_BYTES_LIMIT) return unavailable('output_limit_exceeded');
  if (meta?.sessionId !== undefined && meta.sessionId !== nativeSessionId) {
    throw new AcpProviderSessionError('acp_structured_output_identity_mismatch',
      'Structured output metadata identifies a different native session.');
  }
  const hasOutput = meta !== undefined && Object.hasOwn(meta, 'structuredOutput');
  const hasError = meta !== undefined && Object.hasOwn(meta, 'structuredOutputError');
  if (hasOutput && hasError) {
    throw new AcpProviderSessionError('acp_structured_output_ambiguous',
      'Structured output response contains both a value and an error.');
  }
  if (hasError && (typeof meta?.structuredOutputError !== 'string' || !meta.structuredOutputError.trim()
    || Buffer.byteLength(meta.structuredOutputError, 'utf8') > GROK_STRUCTURED_ERROR_BYTES_LIMIT)) {
    throw new AcpProviderSessionError('acp_structured_output_error_invalid',
      'Structured output error must be a bounded nonempty native error string.');
  }
  if (result.stopReason === 'refusal') return unavailable('refused');
  if (result.stopReason !== 'end_turn') return unavailable('incomplete');
  // Grok uses the same free-text error for native validation and exhausted fallback retries.
  // It provides no discriminator that would justify claiming native_retries_exhausted.
  if (hasError) return unavailable('provider_error');
  if (!hasOutput) return unavailable('missing_output');
  return createAgentStructuredOutputCandidate({ schema, candidate: { kind: 'json_value', value: meta?.structuredOutput } });
}

export function acpStructuredOutputCompletion(
  completion: AgentTurnCompletedPayload,
  response: AcpResponseReceived,
  schema: AgentOutputSchema | undefined,
  nativeSessionId: string,
): AgentTurnCompletedPayload {
  const structuredOutput = structuredOutputResult(response, schema, nativeSessionId);
  if (completion.outcome === 'completed') return { ...completion, structuredOutput };
  if (structuredOutput.kind === 'json') {
    throw new AcpProviderSessionError('acp_structured_output_terminal_invalid',
      'A structured output value requires successful native completion.');
  }
  return { ...completion, structuredOutput };
}
