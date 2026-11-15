import { writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { parseAgentCapabilities } from '@agen-ai/agent-protocol';
import type { AgentApprovalPolicySupport, AgentProviderDriver, AgentProviderSession } from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';
import { createAcpProviderDriver } from '@agen-ai/provider-acp';

// Teaching-only policy declarations. No native provider, reviewer, credential or process exists here.
export function createSyntheticApprovalFixture(markerPath: string, marker: string) {
  const template = createFakeAgentProvider();
  const fake = createFakeAgentProvider({ capabilities: parseAgentCapabilities({
    ...template.capabilities, configuration: { kind: 'managed' },
  }) });
  const support = {
    kind: 'supported', policies: [
      { policy: 'host', operations: ['create'] },
      { policy: 'provider_auto_review', operations: ['create'] },
      { policy: 'provider_bypass', operations: ['create'] },
    ],
  } satisfies AgentApprovalPolicySupport;
  let outputReaders = 0;
  const driver: AgentProviderDriver = { ...fake.driver, supportsMultipleInstances: false,
    async materialize(definition) {
      const instance = await fake.driver.materialize(definition);
      const sessions: AgentProviderSession[] = [];
      return { ...instance,
        async dispose() {
          for (const session of sessions) await session.close({ reason: 'shutdown' });
          await instance.dispose();
        },
        adapter: { ...instance.adapter, approvalPolicy: support,
          async createSession(input) {
            const original = await instance.adapter.createSession(input);
            const session: AgentProviderSession = { ...original,
              // This is this fixture's synthetic contract result, never native verification evidence.
              ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: {
                policy: input.approvalPolicy, verification: 'controlled_configuration' as const,
              } }),
              startTurn(turn) {
                const execution = original.startTurn(turn);
                return { ...execution,
                  outputs: { [Symbol.asyncIterator]() {
                    outputReaders += 1;
                    return execution.outputs[Symbol.asyncIterator]();
                  } },
                  async resolveRequest(answer) {
                    const receipt = await execution.resolveRequest(answer);
                    if (receipt.status === 'delivered' && answer.resolution.requestKind === 'approval'
                      && answer.resolution.disposition === 'selected' && answer.resolution.optionId === 'approval:allow-once') {
                      writeFileSync(markerPath, marker, { flag: 'wx', mode: 0o600 });
                    }
                    return receipt;
                  },
                };
              },
            };
            sessions.push(session);
            return session;
          },
        },
      };
    },
  };
  return { driver, definition: fake.definition,
    observe() {
      const snapshot = fake.snapshot();
      return { sessions: snapshot.createdSessionIds.length, turns: snapshot.turnIds.length, outputReaders,
        sessionsClosed: Object.values(snapshot.closeCounts).reduce((total, count) => total + count, 0),
        instancesDisposed: snapshot.instanceDisposeCount };
    },
  };
}

// An actual generic ACP driver with an owned, in-memory scripted peer. It advertises no policy support.
export function createGenericAcpFixture(markerPath: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let pending = '';
  let sessionOpenings = 0;
  let prompts = 0;
  let connectionsReleased = 0;
  const send = (frame: { readonly id: number | string; readonly result: unknown }) =>
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const frame = JSON.parse(pending.slice(0, end)) as { id: number | string; method: string };
      pending = pending.slice(end + 1);
      if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (frame.method === 'session/new') {
        sessionOpenings += 1;
        send({ id: frame.id, result: { sessionId: 'generic-acp:conversation' } });
      } else if (frame.method === 'session/prompt') {
        prompts += 1;
        writeFileSync(markerPath, 'generic-acp-omitted\n', { flag: 'wx', mode: 0o600 });
        send({ id: frame.id, result: { stopReason: 'end_turn' } });
      }
    }
  });
  const driver = createAcpProviderDriver({ providerKey: 'approval-policy-generic-acp', createConnection() {
    let released = false;
    return { ownership: 'owned', stdin, stdout, release() {
      if (released) return;
      released = true;
      connectionsReleased += 1;
      stdin.destroy(); stdout.destroy();
    } };
  } });
  return { driver, observe: () => ({ sessionOpenings, prompts, connectionsReleased }) };
}
