import assert from 'node:assert/strict';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId, parseAgentTurnId, type AgentEvent, type AgentRequest } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderOutput } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver, type AcpProviderLimits } from '../../src/index.js';
import type { SessionPeer } from './session-peer.js';

export const providerKey = parseAgentProviderKey('acp-session-fixture');
export const definition = { providerKey, instanceId: parseAgentInstanceId('fixture:instance'), driverConfiguration: {} };
export const configuration = { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('fixture:configuration') };
export const turnInput = (id = 'turn:1', text = 'hello') => ({
  turnId: parseAgentTurnId(id), interactionMode: 'default' as const, parts: [{ type: 'text' as const, text }],
});
export const events = (outputs: readonly AgentProviderOutput[]): AgentEvent[] => outputs.flatMap((output) => output.kind === 'event' ? [output.event] : []);
export const collect = async (stream: AsyncIterable<AgentProviderOutput>): Promise<AgentProviderOutput[]> => {
  const outputs: AgentProviderOutput[] = [];
  for await (const output of stream) outputs.push(output);
  return outputs;
};
export const selection = (request: AgentRequest) => {
  assert.equal(request.requestKind, 'approval');
  if (request.requestKind !== 'approval') throw new Error('Expected an approval request.');
  const option = request.options.find((candidate) => candidate.decision === 'approved');
  assert.ok(option);
  return { requestKind: 'approval' as const, requestId: request.requestId, disposition: 'selected' as const, optionId: option.optionId };
};
export async function open(peer: SessionPeer, limits?: Partial<AcpProviderLimits>) {
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease, limits });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [definition] });
  const session = await registry.requireInstance(definition.instanceId).adapter.createSession({
    sessionId: parseAgentSessionId('fixture:session'), workingDirectory: '/fixture', configuration, onBindingCreated() {},
  });
  return { registry, session };
}
