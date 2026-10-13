// ------------------------------------------------------------------------------------------------
//                session-mcp-setup.test.ts - Negotiated placement and bounded static/dynamic setup
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProviderContractError } from '@agen-ai/agent-runtime';
import { bindingFixture, context, createBindingHarness, prompt, server } from './fixtures/session-mcp.js';

const unsupported = (error: unknown) => error instanceof AgentProviderContractError && error.code === 'host_binding_unsupported';

for (const transport of [undefined, 'http', 'sse'] as const) {
  test(`${transport ?? 'no factory'} rejects an unavailable session binding before factory or native opening`, async (t) => {
    let factories = 0;
    const harness = await createBindingHarness({ ...(transport === undefined ? {} : {
      agentCapabilities: { mcpCapabilities: { [transport === 'http' ? 'sse' : 'http']: true } },
      sessionMcpBinding: { transport, create() { factories += 1; return { mcpServers: [server('dynamic', transport)], release() {} }; } },
    }) });
    t.after(() => harness.close());
    const host = bindingFixture(`unsupported:${transport}`);
    await assert.rejects(async () => harness.adapter.createSession({ ...context('session:unsupported'), hostBinding: host.binding }), unsupported);
    assert.equal(factories, 0);
    assert.equal(harness.peers[0]!.frames.some((frame) => frame.method?.startsWith('session/')), false);
    assert.equal(host.releases, 1);
  });
}

for (const placement of ['system', 'developer'] as const) {
  test(`MCP guidance does not claim a trusted ${placement} instruction channel`, async (t) => {
    let factories = 0;
    const harness = await createBindingHarness({ sessionMcpBinding: { transport: 'http', create() {
      factories += 1; return { mcpServers: [server('dynamic')], release() {} };
    } } });
    t.after(() => harness.close());
    const host = bindingFixture(`placement:${placement}`, { placement });
    await assert.rejects(async () => harness.adapter.createSession({ ...context('session:placement'), hostBinding: host.binding }), unsupported);
    assert.equal(factories, 0);
    assert.equal(harness.peers[0]!.frames.some((frame) => frame.method === 'session/new'), false);
    assert.equal(host.releases, 1);
  });
}

for (const transport of ['http', 'sse'] as const) test(`${transport} accepts 32 combined entries without leaking dynamic setup into another session`, async (t) => {
  const staticServers = Array.from({ length: 31 }, (_, index) => server(`static-${index}`));
  let factories = 0;
  let releases = 0;
  const dynamic = server('dynamic', transport);
  const harness = await createBindingHarness({ mcpServers: staticServers, sessionMcpBinding: { transport, create() {
    factories += 1; return { mcpServers: [dynamic], release() { releases += 1; } };
  } } });
  t.after(() => harness.close());
  const host = bindingFixture('bounded:parent');
  const first = await harness.adapter.createSession({ ...context('session:bound'), hostBinding: host.binding });
  assert.deepEqual(harness.peers[0]!.frames.find((frame) => frame.method === 'session/new')?.params?.mcpServers, [...staticServers, dynamic]);
  await prompt(first, 'turn:bound');
  await first.close({ reason: 'shutdown' });
  await harness.adapter.createSession(context('session:static-only'));
  assert.deepEqual(harness.peers[1]!.frames.find((frame) => frame.method === 'session/new')?.params?.mcpServers, staticServers);
  assert.equal(staticServers.length, 31);
  assert.equal(factories, 1);
  assert.equal(releases, 1);
  assert.equal(host.releases, 1);
});

const invalidSetup = [
  { name: 'duplicate names', staticServers: [server('same')], dynamicServers: [server('same')] },
  { name: '33 combined entries', staticServers: Array.from({ length: 32 }, (_, index) => server(`static-${index}`)), dynamicServers: [server('dynamic')] },
  { name: 'combined 512 KiB overflow', staticServers: Array.from({ length: 16 }, (_, index) => server(`static-${index}`, 'http', 's'.repeat(16_384))),
    dynamicServers: Array.from({ length: 16 }, (_, index) => server(`dynamic-${index}`, 'http', 'd'.repeat(16_384))) },
  { name: 'undeclared transport', staticServers: [], dynamicServers: [server('dynamic', 'sse')] },
  { name: 'empty dynamic lease', staticServers: [], dynamicServers: [] },
];
for (const setup of invalidSetup) {
  test(`${setup.name} rejects before native opening and releases the acquired session resources`, async (t) => {
    let factoryReleases = 0;
    let connectionReleases = 0;
    const harness = await createBindingHarness({ mcpServers: setup.staticServers, releaseConnection() { connectionReleases += 1; },
      sessionMcpBinding: { transport: 'http', create() {
        return { mcpServers: setup.dynamicServers, release() { factoryReleases += 1; } };
      } },
    });
    t.after(() => harness.close());
    const host = bindingFixture(`invalid:${setup.name}`);
    await assert.rejects(async () => harness.adapter.createSession({ ...context('session:invalid-setup'), hostBinding: host.binding }), TypeError);
    assert.equal(harness.peers[0]!.frames.some((frame) => frame.method === 'session/new'), false);
    assert.equal(connectionReleases, 1);
    assert.equal(factoryReleases, 1);
    assert.equal(host.releases, 1);
  });
}
