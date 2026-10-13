import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createAcpClient, type AcpJsonObject, type AcpJsonValue } from '@agen-ai/acp-transport';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId,
  type AgentCapabilities,
  type AgentConfigurationCatalog,
  type AgentConfigurationSelectionInput,
} from '@agen-ai/agent-protocol';

import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver } from '../src/index.js';
import { createSessionPeer } from './fixtures/session-peer.js';
import { createAcpSessionConfiguration } from '../src/configuration/control.js';

type Frame = { readonly id?: string | number; readonly method?: string; readonly params?: AcpJsonObject };
const capability = { kind: 'selectable' as const, fieldKinds: ['boolean', 'single_select'] as const, maxFields: 100 };
const configurationRevision = parseAgentConfigurationRevisionId('configuration:fixture');
const nativeBooleanId = `native / ${'boolean'.repeat(50)}`;
const hasReason = (reason: string) => (error: unknown): boolean => error instanceof Error && 'reasonCode' in error && error.reasonCode === reason;

function booleanOption(currentValue = false): AcpJsonObject {
  return { id: nativeBooleanId, name: 'Enabled', type: 'boolean', currentValue };
}

function selectOption(currentValue = 'native:small'): AcpJsonObject {
  return {
    id: 'native:model', name: 'Model', description: 'Choose a model', type: 'select', currentValue,
    options: [
      { group: 'fast', name: 'Fast models', options: [{ value: 'native:small', name: 'Small' }] },
      { group: 'quality', name: 'Quality models', options: [{ value: 'native:large', name: 'Large', description: 'More capable' }] },
    ],
  };
}

function selection(catalog: AgentConfigurationCatalog, label: string, value?: string | boolean): AgentConfigurationSelectionInput {
  const field = catalog.fields.find((candidate) => candidate.label === label);
  assert.ok(field);
  if (field.fieldKind === 'boolean') return {
    key: field.key, expectedCatalogRevision: catalog.revision, expectedFieldRevision: field.revision,
    value: { fieldKind: 'boolean', value: typeof value === 'boolean' ? value : !field.currentValue },
  };
  assert.equal(field.fieldKind, 'single_select');
  if (field.fieldKind !== 'single_select') throw new Error('Expected a selector.');
  const option = field.options.find((candidate) => candidate.label === value);
  assert.ok(option);
  return { key: field.key, expectedCatalogRevision: catalog.revision, expectedFieldRevision: field.revision, value: { fieldKind: 'single_select', optionId: option.optionId } };
}

function fixture(options: {
  readonly capability?: AgentCapabilities['configuration'];
  readonly maxSnapshotBytes?: number;
  readonly onRequest?: (frame: Frame, peer: { readonly send: (frame: unknown) => void; readonly batch: (frames: readonly unknown[]) => void }) => void;
} = {}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const frames: Frame[] = [];
  const retired: Error[] = [];
  const send = (frame: unknown) => { stdout.write(`${JSON.stringify(frame)}\n`); };
  const batch = (batch: readonly unknown[]) => { stdout.write(batch.map((frame) => JSON.stringify(frame)).join('\n') + '\n'); };
  let buffer = '';
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline)) as Frame;
      buffer = buffer.slice(newline + 1);
      frames.push(frame);
      options.onRequest?.(frame, { send, batch });
      newline = buffer.indexOf('\n');
    }
  });
  const client = createAcpClient({
    stdout, stdin, schemaProfile: 'schema-v1.23.0', schemaChannel: 'stable',
    notificationHandlers: { 'session/update': ({ params }) => {
      assert.ok(params !== null && typeof params === 'object' && !Array.isArray(params));
      const update = params.update;
      assert.ok(update !== null && typeof update === 'object' && !Array.isArray(update));
      configuration.observeUpdate(update);
    } },
  });
  const configuration = createAcpSessionConfiguration({
    capability: options.capability ?? capability, client, getSessionId: () => 'native-session', assertUsable() {},
    onFailure(error) { retired.push(error); },
    timeoutMs: 1_000, maxSnapshotBytes: options.maxSnapshotBytes,
  });
  const control = configuration.control;
  const selectable = () => {
    assert.equal(control.kind, 'selectable');
    if (control.kind !== 'selectable') throw new Error('Expected selectable configuration.');
    return control;
  };
  return {
    configuration, control, selectable, frames, retired, send,
    async dispose() { await client.dispose(); stdout.destroy(); stdin.destroy(); },
  };
}

test('managed configuration ignores native selectors and rejects selected opening without dispatch', async (t) => {
  const peer = fixture({ capability: { kind: 'managed' } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [{ unsupported: true }] });
  assert.equal(peer.control.kind, 'managed');
  await peer.configuration.applyOpeningConfiguration({ kind: 'managed', revision: configurationRevision });
  await assert.rejects(peer.configuration.applyOpeningConfiguration({ kind: 'selected', revision: configurationRevision, catalogRevision: 1, selections: [] }), hasReason('acp_configuration_kind_unsupported'));
  assert.deepEqual(peer.frames, []);
});

test('unobserved catalogs remain unknown through default bootstrap; explicit empty replaces them truthfully', async (t) => {
  const peer = fixture();
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: null });
  await peer.configuration.applyOpeningConfiguration({ kind: 'selected', revision: configurationRevision, catalogRevision: 1, selections: [] });
  assert.throws(() => peer.selectable().listConfiguration(), hasReason('acp_configuration_catalog_unknown'));
  await assert.rejects(peer.configuration.applyOpeningConfiguration({ kind: 'selected', revision: configurationRevision, catalogRevision: 999, selections: [] }), hasReason('acp_configuration_catalog_unknown'));
  peer.configuration.observeUpdate({ sessionUpdate: 'config_option_update', configOptions: [] });
  const catalog = await peer.selectable().listConfiguration();
  assert.deepEqual(catalog.fields, []);
  assert.ok(catalog.revision > 0);
  peer.configuration.observeUpdate({ sessionUpdate: 'config_option_update', configOptions: [booleanOption()] });
  assert.ok((await peer.selectable().listConfiguration()).revision > 1);
  await peer.configuration.applyOpeningConfiguration({ kind: 'selected', revision: configurationRevision, catalogRevision: 1, selections: [] });
  assert.deepEqual(peer.frames, []);
});

test('grouped selections and boolean toggles dispatch exact native values and retain independent field revisions', async (t) => {
  const peer = fixture({ onRequest(frame, native) {
    if (frame.method !== 'session/set_config_option') return;
    native.send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: [booleanOption(true), selectOption(frame.params?.configId === 'native:model' ? 'native:large' : 'native:small')] } });
  } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [selectOption(), booleanOption()] });
  const first = await peer.selectable().listConfiguration();
  assert.deepEqual(first.fields.map((field) => [field.scope, field.applicationTiming, field.mutable]), [['session', 'immediate', true], ['session', 'immediate', true]]);
  assert.ok(first.fields.every((field) => field.key.length <= 256));
  const selected = first.fields.find((field) => field.label === 'Model');
  assert.equal(selected?.fieldKind, 'single_select');
  if (selected?.fieldKind !== 'single_select') throw new Error('Expected selector.');
  assert.deepEqual(selected.options.map((option) => option.label).sort(), ['Fast models: Small', 'Quality models: Large']);
  let started = 0;
  assert.equal((await peer.selectable().applyConfigurationSelection({ selection: selection(first, 'Enabled', true), onProviderExecutionStarted() { started += 1; assert.equal(peer.frames.length, 0); } })).status, 'completed');
  const second = await peer.selectable().listConfiguration();
  assert.ok(second.revision > first.revision);
  assert.equal(second.fields.find((field) => field.label === 'Model')?.revision, selected.revision);
  assert.equal((await peer.selectable().applyConfigurationSelection({ selection: selection(second, 'Model', 'Quality models: Large') })).status, 'completed');
  assert.deepEqual(peer.frames.map((frame) => [frame.method, frame.params]), [
    ['session/set_config_option', { sessionId: 'native-session', configId: nativeBooleanId, type: 'boolean', value: true }],
    ['session/set_config_option', { sessionId: 'native-session', configId: 'native:model', value: 'native:large' }],
  ]);
  assert.equal(started, 1);
});

test('a setter response cannot overwrite a newer notification received in the same read', async (t) => {
  const peer = fixture({ onRequest(frame, native) {
    if (frame.method === 'session/set_config_option') native.batch([
      { jsonrpc: '2.0', id: frame.id, result: { configOptions: [booleanOption(true)] } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'config_option_update', configOptions: [booleanOption(false)] } } },
    ]);
  } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [booleanOption()] });
  const catalog = await peer.selectable().listConfiguration();
  assert.equal((await peer.selectable().applyConfigurationSelection({ selection: selection(catalog, 'Enabled', true) })).status, 'completed');
  assert.equal((await peer.selectable().listConfiguration()).fields[0]?.currentValue, false);
});

test('catalog revisions change only with full mapped state and removed fields retire their old selection authority', async (t) => {
  const peer = fixture();
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [booleanOption()] });
  const first = await peer.selectable().listConfiguration();
  peer.configuration.observeUpdate({ sessionUpdate: 'config_option_update', configOptions: [booleanOption()] });
  assert.equal((await peer.selectable().listConfiguration()).revision, first.revision);
  peer.configuration.observeUpdate({ sessionUpdate: 'config_option_update', configOptions: [] });
  peer.configuration.observeUpdate({ sessionUpdate: 'config_option_update', configOptions: [booleanOption()] });
  const restored = await peer.selectable().listConfiguration();
  assert.ok(restored.fields[0]!.revision > first.fields[0]!.revision);
  await assert.rejects(async () => peer.selectable().applyConfigurationSelection({ selection: selection(first, 'Enabled', true) }), hasReason('acp_configuration_selection_invalid'));
  assert.deepEqual(peer.frames, []);
});

test('empty optional descriptions preserve selectable configuration and its revision across native updates', async (t) => {
  const peer = fixture({ onRequest(frame, native) {
    if (frame.method === 'session/set_config_option') native.send({ jsonrpc: '2.0', id: frame.id,
      result: { configOptions: [{ ...booleanOption(true), description: '' }] } });
  } });
  t.after(() => peer.dispose());
  const configOptions = [{ ...booleanOption(), description: '' }, {
    ...selectOption(), description: '', options: [{ value: 'native:small', name: 'Small', description: '' }],
  }];
  peer.configuration.observeSetup({ configOptions });
  const first = await peer.selectable().listConfiguration();
  assert.ok(first.fields.every((field) => field.description === undefined));
  const model = first.fields.find((field) => field.label === 'Model');
  assert.ok(model?.fieldKind === 'single_select');
  assert.equal(model.options[0]!.description, undefined);
  peer.configuration.observeUpdate({ sessionUpdate: 'config_option_update', configOptions: [booleanOption(), {
    ...selectOption(), description: null, options: [{ value: 'native:small', name: 'Small' }],
  }] });
  assert.equal((await peer.selectable().listConfiguration()).revision, first.revision);
  assert.equal((await peer.selectable().applyConfigurationSelection({ selection: selection(first, 'Enabled', true) })).status, 'completed');
  assert.deepEqual(peer.retired, []);
});

const invalidSelections: readonly [string, (valid: AgentConfigurationSelectionInput) => AgentConfigurationSelectionInput][] = [
  ['stale catalog', (valid) => ({ ...valid, expectedCatalogRevision: valid.expectedCatalogRevision + 1 })],
  ['stale field', (valid) => ({ ...valid, expectedFieldRevision: valid.expectedFieldRevision + 1 })],
  ['unknown key', (valid) => ({ ...valid, key: 'not-offered' })],
  ['unoffered value', (valid) => ({ ...valid, value: { fieldKind: 'single_select', optionId: 'not-offered' } })],
  ['wrong field kind', (valid) => ({ ...valid, value: { fieldKind: 'bounded_integer', value: 2 } })],
];
for (const [name, change] of invalidSelections) test(`${name} is rejected before execution observation or native setter dispatch`, async (t) => {
  const peer = fixture();
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [selectOption()] });
  const valid = selection(await peer.selectable().listConfiguration(), 'Model', 'Quality models: Large');
  let started = false;
  await assert.rejects(async () => peer.selectable().applyConfigurationSelection({ selection: change(valid), onProviderExecutionStarted() { started = true; } }), hasReason('acp_configuration_selection_invalid'));
  assert.equal(started, false);
  assert.deepEqual(peer.frames, []);
});

const invalidCatalogs: readonly [string, AcpJsonValue][] = [
  ['empty field identifier', [{ ...booleanOption(), id: '' }]],
  ['empty field label', [{ ...booleanOption(), name: '' }]],
  ['non-string description', [{ ...booleanOption(), description: false }]],
  ['duplicate fields', [booleanOption(), booleanOption()]],
  ['unoffered current value', [selectOption('native:missing')]],
  ['empty selector', [{ ...selectOption(), options: [] }]],
  ['duplicate grouped values', [{ ...selectOption(), options: [{ group: 'one', name: 'One', options: [{ value: 'native:small', name: 'Small' }] }, { group: 'two', name: 'Two', options: [{ value: 'native:small', name: 'Small again' }] }] }]],
  ['duplicate groups', [{ ...selectOption(), options: [{ group: 'one', name: 'One', options: [{ value: 'native:small', name: 'Small' }] }, { group: 'one', name: 'Other', options: [{ value: 'native:large', name: 'Large' }] }] }]],
  ['oversized label', [{ ...booleanOption(), name: 'x'.repeat(201) }]],
  ['unrepresentable grouped label', [{ ...selectOption(), options: [{ group: 'one', name: 'x'.repeat(200), options: [{ value: 'native:small', name: 'Small' }] }] }]],
  ['oversized description', [{ ...booleanOption(), description: 'x'.repeat(2_001) }]],
  ['too many fields', Array.from({ length: 101 }, (_, index) => ({ ...booleanOption(), id: `native:${index}` }))],
  ['too many values', [{ ...selectOption(), options: Array.from({ length: 101 }, (_, index) => ({ value: `native:${index}`, name: `Value ${index}` })) }]],
  ['unmapped field kind', [{ id: 'native:text', name: 'Text', type: 'text', currentValue: 'value' }]],
];
for (const [name, configOptions] of invalidCatalogs) test(`${name} rejects the whole catalog and retires earlier selection authority`, async (t) => {
  const peer = fixture();
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [booleanOption()] });
  const old = selection(await peer.selectable().listConfiguration(), 'Enabled', true);
  assert.throws(() => peer.configuration.observeUpdate({ sessionUpdate: 'config_option_update', configOptions }), hasReason('acp_configuration_catalog_invalid'));
  assert.throws(() => peer.selectable().listConfiguration(), hasReason('acp_configuration_catalog_invalid'));
  await assert.rejects(async () => peer.selectable().applyConfigurationSelection({ selection: old }), hasReason('acp_configuration_catalog_invalid'));
  assert.deepEqual(peer.frames, []);
});

test('catalogs outside frozen field-kind, field-count or byte ceilings cannot be exposed', async (t) => {
  for (const options of [
    { capability: { ...capability, fieldKinds: ['single_select'] as const }, configOptions: [booleanOption()] },
    { capability: { ...capability, maxFields: 1 }, configOptions: [booleanOption(), selectOption()] },
    { maxSnapshotBytes: 20, configOptions: [booleanOption()] },
  ]) {
    const peer = fixture(options);
    t.after(() => peer.dispose());
    assert.throws(() => peer.configuration.observeSetup({ configOptions: options.configOptions }), hasReason('acp_configuration_catalog_invalid'));
  }
});

test('legacy modes map through the offered native mode setter and yield to explicit config state', async (t) => {
  const peer = fixture({ onRequest(frame, native) { if (frame.method === 'session/set_mode') native.send({ jsonrpc: '2.0', id: frame.id, result: {} }); } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask', description: '' }, { id: 'architect', name: 'Architect', description: '' }] } });
  const catalog = await peer.selectable().listConfiguration();
  const requested = selection(catalog, 'Session mode', 'Architect');
  await peer.selectable().applyConfigurationSelection({ selection: requested });
  assert.deepEqual(peer.frames[0]?.params, { sessionId: 'native-session', modeId: 'architect' });
  assert.equal((await peer.selectable().listConfiguration()).fields[0]?.currentValue, requested.value.fieldKind === 'single_select' ? requested.value.optionId : undefined);
  peer.configuration.observeUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' });
  assert.notEqual((await peer.selectable().listConfiguration()).fields[0]?.currentValue, requested.value.fieldKind === 'single_select' ? requested.value.optionId : undefined);
  peer.configuration.observeUpdate({ sessionUpdate: 'config_option_update', configOptions: [] });
  peer.configuration.observeUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'architect' });
  assert.deepEqual((await peer.selectable().listConfiguration()).fields, []);
});

test('opening selections preserve their offered field revisions across dependent native catalog changes', async (t) => {
  const peer = fixture({ onRequest(frame, native) {
    if (frame.method === 'session/set_config_option') native.send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: [booleanOption(true), { ...selectOption(), description: 'The model contract changed' }] } });
  } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [booleanOption(), selectOption()] });
  const catalog = await peer.selectable().listConfiguration();
  const offered = [selection(catalog, 'Enabled', true), selection(catalog, 'Model', 'Quality models: Large')];
  await assert.rejects(peer.configuration.applyOpeningConfiguration({
    kind: 'selected', revision: configurationRevision, catalogRevision: catalog.revision,
    selections: offered.map((item) => ({ key: item.key, fieldRevision: item.expectedFieldRevision, value: item.value })),
  }), hasReason('acp_configuration_selection_invalid'));
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.frames[0]?.params?.configId, nativeBooleanId);
});

test('an observed opening selection completes through the acknowledged native setter', async (t) => {
  const peer = fixture({ onRequest(frame, native) {
    if (frame.method === 'session/set_config_option') native.send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: [booleanOption(true)] } });
  } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [booleanOption()] });
  const catalog = await peer.selectable().listConfiguration();
  const offered = selection(catalog, 'Enabled', true);
  await peer.configuration.applyOpeningConfiguration({
    kind: 'selected', revision: configurationRevision, catalogRevision: catalog.revision,
    selections: [{ key: offered.key, fieldRevision: offered.expectedFieldRevision, value: offered.value }],
  });
  assert.equal((await peer.selectable().listConfiguration()).fields[0]?.currentValue, true);
  assert.equal(peer.frames.length, 1);
  assert.deepEqual(peer.retired, []);
});

test('a throwing execution observer preserves its error and the undispatched session remains usable', async (t) => {
  const peer = fixture({ onRequest(frame, native) {
    if (frame.method === 'session/set_config_option') native.send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: [booleanOption(true)] } });
  } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [booleanOption()] });
  const offered = selection(await peer.selectable().listConfiguration(), 'Enabled', true);
  const failure = new Error('Host observer rejected execution.');
  await assert.rejects(async () => peer.selectable().applyConfigurationSelection({ selection: offered, onProviderExecutionStarted() { throw failure; } }), (error) => error === failure);
  assert.deepEqual(peer.frames, []);
  assert.deepEqual(peer.retired, []);
  assert.equal((await peer.selectable().applyConfigurationSelection({ selection: offered })).status, 'completed');
});

test('aborted or concurrent mutations do not dispatch another native selection', async (t) => {
  let dispatched!: () => void;
  const dispatch = new Promise<void>((resolve) => { dispatched = resolve; });
  const peer = fixture({ onRequest(frame) { if (frame.method === 'session/set_config_option') dispatched(); } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [booleanOption()] });
  const selected = selection(await peer.selectable().listConfiguration(), 'Enabled', true);
  await assert.rejects(async () => peer.selectable().applyConfigurationSelection({ selection: selected, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual(peer.retired, []);
  const abort = new AbortController();
  const pending = Promise.resolve(peer.selectable().applyConfigurationSelection({ selection: selected, signal: abort.signal }));
  await dispatch;
  await assert.rejects(async () => peer.selectable().applyConfigurationSelection({ selection: selected }), hasReason('acp_configuration_busy'));
  abort.abort();
  await assert.rejects(pending, hasReason('acp_request_aborted'));
  assert.equal(peer.retired.length, 1);
  assert.throws(() => peer.selectable().listConfiguration(), hasReason('acp_request_aborted'));
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/set_config_option').length, 1);
});

test('native acknowledgements that do not confirm the requested value never report completion', async (t) => {
  const peer = fixture({ onRequest(frame, native) { if (frame.method === 'session/set_config_option') native.send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: [booleanOption(false)] } }); } });
  t.after(() => peer.dispose());
  peer.configuration.observeSetup({ configOptions: [booleanOption()] });
  let started = false;
  await assert.rejects(async () => peer.selectable().applyConfigurationSelection({ selection: selection(await peer.selectable().listConfiguration(), 'Enabled', true), onProviderExecutionStarted() { started = true; } }), hasReason('acp_configuration_selection_unconfirmed'));
  assert.equal(started, true);
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.retired.length, 1);
  assert.throws(() => peer.selectable().listConfiguration(), hasReason('acp_configuration_selection_unconfirmed'));
});

test('new-session metadata preceding the binding response is admitted before the response configuration snapshot', { timeout: 3_000 }, async (t) => {
  const providerKey = parseAgentProviderKey('metadata-fixture');
  const instanceId = parseAgentInstanceId('metadata:instance');
  const option = (currentValue: boolean) => ({ id: 'enabled', name: 'Enabled', type: 'boolean', currentValue });
  const peer = createSessionPeer({ onSetup(peer, frame) { peer.batch([
    peer.update({ sessionUpdate: 'config_option_update', configOptions: [option(false)] }),
    { jsonrpc: '2.0', id: frame.id, result: { sessionId: peer.sessionId, configOptions: [option(true)] } },
  ]); } });
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease, configuration: 'selectable' });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{ providerKey, instanceId, driverConfiguration: {} }] });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const session = await registry.requireInstance(instanceId).adapter.createSession({ sessionId: parseAgentSessionId('metadata:session'), workingDirectory: '/fixture',
    configuration: { kind: 'selected', revision: configurationRevision, catalogRevision: 1, selections: [] }, onBindingCreated() {} });
  assert.equal(session.configuration.kind, 'selectable');
  if (session.configuration.kind !== 'selectable') throw new Error('Expected selectable configuration.');
  const catalog = await session.configuration.listConfiguration();
  const field = catalog.fields[0];
  assert.ok(field?.fieldKind === 'boolean');
  assert.equal(field.currentValue, true);
});
