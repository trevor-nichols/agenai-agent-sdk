import type { AgentProviderSession } from '@agen-ai/agent-runtime';
// ------------------------------------------------------------------------------------------------
//                session-mcp.ts - Public ACP registry and owned session binding fixtures
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import type { AcpJsonObject, AcpStandardMcpServer } from '@agen-ai/acp-transport';
import { parseAgentTurnId } from '@agen-ai/agent-protocol';
import {
  AGENT_HOST_TOOL_SCHEMA_DIALECT, createAgentProviderRegistry,
  type AgentHostToolInvocation, type AgentHostToolResult, type AgentProviderOutput, type AgentSessionHostBinding,
} from '@agen-ai/agent-runtime';
import { createAcpProviderDriver, type CreateAcpProviderDriverOptions } from '../../src/index.js';
import { createHostPeer, hostDefinition, hostProviderKey, hostSessionContext, type HostPeerFrame } from '../node-fixtures/host-peer.js';

export { fixtureDeferred } from '../node-fixtures/host-peer.js';
export type BindingPeer = ReturnType<typeof createHostPeer>;
export const context = hostSessionContext;

export function server(name: string, type: 'http' | 'sse' = 'http', value = '') {
  return { type, name, url: `http://127.0.0.1:12345/${name}`, headers: value ? [{ name: 'Authorization', value }] : [] } satisfies AcpStandardMcpServer;
}

export function bindingFixture(id: string, options: {
  readonly placement?: 'system' | 'developer' | 'tool_context';
  readonly invoke?: (input: AgentHostToolInvocation) => Promise<AgentHostToolResult> | AgentHostToolResult;
  readonly release?: () => Promise<void> | void;
} = {}) {
  const calls: AgentHostToolInvocation[] = [];
  let releases = 0;
  const binding: AgentSessionHostBinding = {
    bindingId: id,
    tools: [{ name: 'scoped_identity', description: 'Return this session authority.', inputSchema: {
      $schema: AGENT_HOST_TOOL_SCHEMA_DIALECT, type: 'object', properties: {}, additionalProperties: false,
    } }],
    instructions: { placement: options.placement ?? 'tool_context', text: `Guidance for ${id}.` },
    invoke(input) { calls.push(input); return options.invoke?.(input) ?? { kind: 'success', value: { owner: id } }; },
    async release() { releases += 1; await options.release?.(); },
  };
  return { binding, calls, get releases() { return releases; } };
}

export async function createBindingHarness(options: Omit<CreateAcpProviderDriverOptions, 'providerKey' | 'createConnection'> & {
  readonly agentCapabilities?: AcpJsonObject;
  readonly authMethods?: readonly AcpJsonObject[];
  readonly onFrame?: (peer: BindingPeer, frame: HostPeerFrame, index: number) => boolean | void;
  readonly releaseConnection?: (peer: BindingPeer, index: number) => Promise<void> | void;
} = {}) {
  const { agentCapabilities, authMethods, onFrame, releaseConnection, ...driverOptions } = options;
  const peers: BindingPeer[] = [];
  const driver = createAcpProviderDriver({ ...driverOptions, providerKey: hostProviderKey, createConnection() {
    const index = peers.length;
    const peer = createHostPeer({ protocolVersion: 1, authMethods: [...authMethods ?? []], agentCapabilities: agentCapabilities ?? {
      mcpCapabilities: { http: true, sse: true }, loadSession: true, sessionCapabilities: { resume: {} },
    } });
    peers.push(peer);
    peer.handle((frame) => {
      if (onFrame?.(peer, frame, index)) return true;
      if (frame.method === 'session/load' || frame.method === 'session/resume') {
        peer.send({ jsonrpc: '2.0', id: frame.id, result: {} });
        return true;
      }
    });
    return { ownership: 'owned', stdout: peer.stdout, stdin: peer.stdin, async release() {
      await releaseConnection?.(peer, index);
      peer.destroy();
    } };
  } });
  try {
    const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [hostDefinition] });
    const instance = registry.requireInstance(hostDefinition.instanceId);
    return { registry, instance, adapter: instance.adapter, peers,
      async close() { try { await registry.dispose(); } finally { for (const peer of peers) peer.destroy(); } },
    };
  } catch (error) { for (const peer of peers) peer.destroy(); throw error; }
}

export function invoke(binding: AgentSessionHostBinding, invocationId: string) {
  return Promise.resolve().then(() => binding.invoke({ invocationId, toolName: 'scoped_identity', arguments: {} }));
}

export async function prompt(session: Pick<AgentProviderSession, 'startTurn'>, id: string) {
  const outputs: AgentProviderOutput[] = [];
  for await (const output of session.startTurn(turn(id)).outputs) outputs.push(output);
  assert.ok(outputs.some((output) => output.kind === 'event' && output.event.type === 'turn.completed'));
  return outputs;
}

function turn(id: string) {
  return { turnId: parseAgentTurnId(id), interactionMode: 'default' as const, parts: [{ type: 'text' as const, text: 'Do bounded work.' }] };
}
