import { assertBoundedAcpJson, DEFAULT_ACP_PROTOCOL_LIMITS, type AcpJsonObject } from '@agen-ai/acp-transport';
import { parseAgentOutputSchema, type AgentCapabilities, type AgentOutputSchema, type AgentStructuredOutputRequest } from '@agen-ai/agent-protocol';
import { AgentProviderContractError } from '@agen-ai/agent-runtime';

export function prepareAcpStructuredOutput(
  request: AgentStructuredOutputRequest | undefined,
  capabilities: AgentCapabilities,
): Readonly<{ schema: AgentOutputSchema; promptMeta: AcpJsonObject }> | undefined {
  if (request === undefined) return undefined;
  if (capabilities.turns.structuredOutput.kind === 'unsupported') {
    throw new AgentProviderContractError(capabilities.providerKey, 'structured_output_unsupported',
      'The ACP provider has no selected native structured output mapping.');
  }
  const schema = parseAgentOutputSchema(request.schema);
  // Convert the neutral schema type to validated transport JSON at the native boundary.
  assertBoundedAcpJson(schema, DEFAULT_ACP_PROTOCOL_LIMITS);
  return { schema, promptMeta: { outputSchema: schema } };
}
