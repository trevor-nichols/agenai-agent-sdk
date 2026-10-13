// ------------------------------------------------------------------------------------------------
//                session-mcp-authority.test.ts - Session-specific factory authority and configuration
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentHostToolResult, AgentSessionHostBinding } from '@agen-ai/agent-runtime';
import type { AcpSessionMcpBindingFactory } from '../src/index.js';
import { hostDefinition } from './node-fixtures/host-peer.js';
import { bindingFixture, context, createBindingHarness, fixtureDeferred, invoke, prompt, server, type BindingPeer } from './fixtures/session-mcp.js';

test('independent native sessions and exact resume receive their own callback authority and fresh MCP setup', { timeout: 3_000 }, async (t) => {
  const factories: Parameters<AcpSessionMcpBindingFactory>[0][] = [];
  const callbacks = new Map<string, AgentSessionHostBinding>();
  const invoked: AgentHostToolResult[] = [];
  const harness = await createBindingHarness({ sessionMcpBinding: { transport: 'http', create(input) {
    factories.push(input);
    const entry = server(`owned-${input.sessionId}`);
    assert.ok(entry.type === 'http');
    callbacks.set(entry.url, input.hostBinding);
    return { mcpServers: [entry], release() { callbacks.delete(entry.url); } };
  } }, onFrame(peer, frame, index) {
    if (frame.method !== 'session/prompt') return;
    const setup = peer.frames.find((candidate) => ['session/new', 'session/resume'].includes(candidate.method ?? ''));
    const entries = setup?.params?.mcpServers as { url: string }[];
    assert.equal(entries.length, 1);
    const callback = callbacks.get(entries[0]!.url);
    assert.ok(callback);
    void invoke(callback, `callback:${index}:${invoked.length}`).then((result) => {
      invoked.push(result);
      peer.send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
    }, () => peer.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'Callback failed.' } }));
    return true;
  } });
  t.after(() => harness.close());
  const first = bindingFixture('parent:first');
  const second = bindingFixture('parent:second');
  const resumed = bindingFixture('parent:resumed');
  const aContext = { ...context('session:first'), workingDirectory: '/approved/first', hostBinding: first.binding };
  const bContext = { ...context('session:second'), workingDirectory: '/approved/second', hostBinding: second.binding };
  const a = await harness.adapter.createSession(aContext);
  const b = await harness.adapter.createSession(bContext);
  await prompt(a, 'turn:first');
  await prompt(b, 'turn:second');
  await a.close({ reason: 'replaced' });
  assert.equal(harness.adapter.resumption.kind, 'supported');
  if (harness.adapter.resumption.kind !== 'supported') throw new Error('Expected native resumption.');
  const cContext = { ...context('session:resumed'), workingDirectory: '/approved/resumed', hostBinding: resumed.binding, binding: a.binding };
  const c = await harness.adapter.resumption.resumeSession(cContext);
  await prompt(c, 'turn:resumed');
  await prompt(b, 'turn:second-again');
  assert.deepEqual(invoked, ['parent:first', 'parent:second', 'parent:resumed', 'parent:second'].map((owner) => ({ kind: 'success', value: { owner } })));
  assert.deepEqual(factories.map((input) => ({ instanceId: input.instanceId, sessionId: input.sessionId,
    workingDirectory: input.workingDirectory, operation: input.operation, bindingId: input.hostBinding.bindingId })),
  [aContext, bContext, cContext].map((input, index) => ({ instanceId: hostDefinition.instanceId, sessionId: input.sessionId,
    workingDirectory: input.workingDirectory, operation: index === 2 ? 'resume' : 'create', bindingId: input.hostBinding.bindingId })));
  for (const [index, host] of [first, second, resumed].entries()) {
    assert.notEqual(factories[index]!.hostBinding, host.binding);
    assert.ok(factories[index]!.signal instanceof AbortSignal);
  }
  assert.equal(first.releases, 1);
  assert.equal(second.releases, 0);
  assert.equal(resumed.releases, 0);
  assert.equal(harness.peers[2]!.frames.find((frame) => frame.method === 'session/resume')?.params?.sessionId, a.binding.conversationId);
});

test('an admitted selectable configuration is acknowledged before the bound session can prompt', { timeout: 3_000 }, async (t) => {
  const setter = fixtureDeferred<{ peer: BindingPeer; id: string | number }>();
  const model = (currentValue: string) => ({ id: 'native:model', name: 'Model', type: 'select', currentValue,
    options: [{ value: 'native:small', name: 'Small' }, { value: 'native:large', name: 'Large' }] });
  let factories = 0;
  const harness = await createBindingHarness({ configuration: 'selectable', sessionMcpBinding: { transport: 'http', create() {
    factories += 1; return { mcpServers: [server('configuration')], release() {} };
  } }, onFrame(peer, frame) {
    if (frame.method === 'session/new') {
      peer.send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'native-session', configOptions: [model('native:small')] } });
      return true;
    }
    if (frame.method === 'session/set_config_option') {
      assert.equal(frame.params?.configId, 'native:model');
      assert.equal(frame.params?.value, 'native:large');
      assert.ok(frame.id !== undefined);
      setter.resolve({ peer, id: frame.id });
      return true;
    }
  } });
  t.after(() => harness.close());
  const configuration = { kind: 'selected' as const, revision: context().configuration.revision, catalogRevision: 1, selections: [] };
  const bootstrap = await harness.adapter.createSession({ ...context('configuration:bootstrap'), configuration });
  assert.equal(bootstrap.configuration.kind, 'selectable');
  if (bootstrap.configuration.kind !== 'selectable') throw new Error('Expected selectable configuration.');
  const catalog = await bootstrap.configuration.listConfiguration();
  const field = catalog.fields[0];
  assert.ok(field?.fieldKind === 'single_select');
  const choice = field.options.find((option) => option.label === 'Large');
  assert.ok(choice);
  await bootstrap.close({ reason: 'replaced' });
  const host = bindingFixture('configuration:parent');
  let opened = false;
  const pending = Promise.resolve(harness.adapter.createSession({ ...context('configuration:selected'), hostBinding: host.binding,
    configuration: { ...configuration, catalogRevision: catalog.revision,
      selections: [{ key: field.key, fieldRevision: field.revision, value: { fieldKind: 'single_select', optionId: choice.optionId } }] },
  })).then((session) => { opened = true; return session; });
  const dispatched = await setter.promise;
  assert.equal(opened, false);
  assert.equal(factories, 1);
  assert.equal(harness.peers[1]!.frames.some((frame) => frame.method === 'session/prompt'), false);
  dispatched.peer.send({ jsonrpc: '2.0', id: dispatched.id, result: { configOptions: [model('native:large')] } });
  const selected = await pending;
  await prompt(selected, 'configuration:turn');
  assert.deepEqual(harness.peers[1]!.frames.filter((frame) => frame.method?.startsWith('session/')).map((frame) => frame.method),
    ['session/new', 'session/set_config_option', 'session/prompt']);
});
