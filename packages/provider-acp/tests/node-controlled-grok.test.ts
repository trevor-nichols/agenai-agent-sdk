import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId,
  parseAgentTurnId } from '@agen-ai/agent-protocol';
import { createNodeAcpProviderDriver, type NodeAcpProtocolDialectSelection } from '../src/node/index.js';
import { isAgentProviderSessionCleanupErrorFor, type AgentProviderCreateSessionInput } from '@agen-ai/agent-runtime';
import { collectRemaining, takeUntilRequest } from './fixtures/session-peer.js';
import { assertProcessGone, posix, waitFor } from './fixtures/session-interactions.js';
import { controlledPeerExecutionBoundary } from './node-fixtures/execution-boundary.js';

const providerKey = parseAgentProviderKey('controlled-grok-fixture');
const instanceId = parseAgentInstanceId('controlled:instance');
const nativeSessionId = 'bac753c8-754b-43f4-85eb-d40fc91145e7';
const definition = { providerKey, instanceId, driverConfiguration: {} };
const configuration = { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('controlled:configuration') };
const configOptions: AcpJsonValue[] = [{ id: 'model', name: 'Model', category: 'model', type: 'select',
  currentValue: 'grok-4.6', options: [{ value: 'grok-4.6', name: 'Grok 4.6' }] },
{ id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: 'high',
  options: [{ value: 'high', name: 'High' }] }];
const opening: AcpJsonObject = { sessionId: nativeSessionId, models: { currentModelId: 'grok-4.6',
  availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }] }, configOptions,
_meta: { currentWorkingDirectory: '/workspace/work', 'x.ai/sessionDetail': {
  sessionId: nativeSessionId, cwd: '/workspace/work', currentModelId: 'grok-4.6', kind: 'build' } } };
const ordinaryPermission: AcpJsonObject = {
  sessionId: nativeSessionId,
  toolCall: { toolCallId: 'native:tool', kind: 'execute', title: 'Execute bounded command',
    rawInput: { variant: 'Bash', command: 'printf fixture' }, _meta: { 'x.ai/tool': {
      version: 1, name: 'run_terminal_command', kind: 'execute', namespace: 'grok_build' } } },
  options: [{ optionId: 'native:remember', name: 'Always', kind: 'allow_always' },
    { optionId: 'native:once', name: 'Yes', kind: 'allow_once' }, { optionId: 'native:no', name: 'No', kind: 'reject_once' }],
};

interface Frame { readonly id?: string | number; readonly method?: string; readonly params?: AcpJsonObject; readonly result?: AcpJsonValue }
interface Scenario {
  readonly initializeMeta?: AcpJsonObject;
  readonly opening?: AcpJsonObject;
  readonly openingUpdate?: AcpJsonObject;
  readonly turnUpdate?: AcpJsonObject;
  readonly permission?: AcpJsonObject;
}

function fixture(t: TestContext, policy: NodeAcpProtocolDialectSelection['policy'] | undefined, scenario: Scenario = {}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const frames: Frame[] = [];
  let partial = '';
  let promptId: string | number | undefined;
  let reservations = 0;
  let releases = 0;
  let bindingCount = 0;
  const send = (value: unknown) => { stdout.write(`${JSON.stringify(value)}\n`); };
  const update = (value: AcpJsonObject) => send({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: nativeSessionId, update: value } });
  stdin.on('data', (chunk: Buffer) => {
    partial += chunk.toString('utf8');
    let end: number;
    while ((end = partial.indexOf('\n')) >= 0) {
      const frame = JSON.parse(partial.slice(0, end)) as Frame;
      partial = partial.slice(end + 1);
      frames.push(frame);
      if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        _meta: scenario.initializeMeta ?? { agentVersion: '1.0.77', grokShell: true, currentWorkingDirectory: '/workspace/work',
          modelState: { currentModelId: 'grok-4.6' } } } });
      if (frame.method === 'session/new') {
        if (scenario.openingUpdate) update(scenario.openingUpdate);
        send({ jsonrpc: '2.0', id: frame.id, result: scenario.opening ?? opening });
      }
      if (frame.method === 'session/prompt') {
        promptId = frame.id;
        if (scenario.turnUpdate) update(scenario.turnUpdate);
        if (scenario.permission) send({ jsonrpc: '2.0', id: 'native:permission', method: 'session/request_permission', params: scenario.permission });
        else send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
      }
      if (frame.id === 'native:permission') send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    }
  });
  const options = { providerKey, launch: { executable: '/opt/agenai/bin/launch-grok', cwd: '/workspace/work' },
    executionBoundary: { reserve() {
      reservations += 1;
      let released = false;
      return { start() { return { stdin, stdout }; }, release() {
        if (!released) { releases += 1; released = true; stdin.destroy(); stdout.destroy(); }
      } };
    } },
    ...(policy === undefined ? {} : { protocolDialect: {
      mapping: 'grok-build-1.0.77-controlled-shell-v1' as const, instanceId, nativeSessionId, policy } }),
  };
  const driver = createNodeAcpProviderDriver(options);
  const materialize = async () => {
    const instance = await driver.materialize(definition);
    t.after(() => instance.dispose());
    return instance;
  };
  const create = async (instance: Awaited<ReturnType<typeof materialize>>) => instance.adapter.createSession({
    sessionId: parseAgentSessionId('controlled:session'), workingDirectory: '/workspace/work', configuration,
    onBindingCreated() { bindingCount += 1; },
  });
  return { driver, options, frames, materialize, create, update,
    observations: () => ({ reservations, releases, bindingCount }) };
}

const turnInput = { turnId: parseAgentTurnId('controlled:turn'), interactionMode: 'default' as const,
  parts: [{ type: 'text' as const, text: 'Run the bounded fixture command.' }] };

test('Node dialect reaches eager initialization and fixed fresh opening while omission preserves generic bytes', async (t) => {
  for (const policy of [undefined, 'host', 'provider_auto_review', 'provider_bypass'] as const) {
    const peer = fixture(t, policy);
    if (peer.options.protocolDialect) Object.assign(peer.options.protocolDialect, {
      instanceId: parseAgentInstanceId('mutated:instance'), nativeSessionId: 'ba8f6d09-dd88-4ffb-b9ad-9758421dd3d1',
    });
    const instance = await peer.materialize();
    const session = await peer.create(instance);
    assert.deepEqual(peer.frames.filter((frame) => frame.method === 'initialize').map((frame) => frame.params?._meta),
      [policy === undefined ? undefined : { clientType: 'extension', clientIdentifier: 'agenai-sdk-grok', mcpApps: false }]);
    if (policy !== undefined) assert.deepEqual(peer.frames[0]?.params?.clientCapabilities, {});
    assert.deepEqual(peer.frames.filter((frame) => frame.method === 'session/new').map((frame) => frame.params), [{
      cwd: '/workspace/work', mcpServers: [], ...(policy === undefined ? {} : { _meta: {
        sessionId: nativeSessionId, clientFsRead: false, clientFsWrite: false, clientTerminal: false } }),
    }]);
    assert.equal(instance.adapter.approvalPolicy?.kind ?? 'unsupported', 'unsupported');
    assert.equal(session.approvalPolicy, undefined);
    const outputs = await Array.fromAsync(session.startTurn(turnInput).outputs);
    assert.deepEqual(outputs.filter((output) => output.kind === 'event' && output.event.type === 'turn.completed')
      .map((output) => output.kind === 'event' && output.event.type === 'turn.completed' ? output.event.payload.outcome : null), ['completed']);
    await instance.dispose();
    assert.deepEqual(peer.observations(), { reservations: 1, releases: 1, bindingCount: 1 });
  }
});

test('wrong eager identity rejects before opening and releases the original execution reservation', async (t) => {
  const peer = fixture(t, 'host', { initializeMeta: { agentVersion: '1.0.76', grokShell: true,
    currentWorkingDirectory: '/workspace/work', modelState: { currentModelId: 'grok-4.6' } } });
  await assert.rejects(peer.materialize, { code: 'approval_policy_unavailable' });
  assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize']);
  assert.deepEqual(peer.observations(), { reservations: 1, releases: 1, bindingCount: 0 });
});

for (const [name, result] of [
  ['UUID', { ...opening, sessionId: 'other-session' }],
  ['cwd', { ...opening, _meta: { ...opening._meta as AcpJsonObject, currentWorkingDirectory: '/other' } }],
  ['model', { ...opening, models: { currentModelId: 'other-model' } }],
  ['unconfirmed', { sessionId: nativeSessionId }],
] as const) test(`controlled opening rejects ${name} mismatch before publishing a binding`, async (t) => {
  const peer = fixture(t, 'host', { opening: result });
  const instance = await peer.materialize();
  await assert.rejects(() => peer.create(instance), { code: name === 'unconfirmed' ? 'approval_policy_unconfirmed' : 'approval_policy_mismatch' });
  assert.deepEqual(peer.observations(), { reservations: 1, releases: 1, bindingCount: 0 });
  await assert.rejects(() => peer.create(instance), { code: 'approval_policy_unavailable' });
  assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize', 'session/new']);
});

for (const [policy, meta] of [
  ['host', undefined], ['provider_auto_review', { autoReview: { outcome: 'blocked', explanation: 'Native review blocked.' } }],
  ['provider_auto_review', { kind: 'grok_config', description: 'Native configuration confirmation.' }],
  ['provider_bypass', { kind: 'grok_config', description: 'Native configuration confirmation.' }],
] as const) test(`${policy} preserves a qualified exact host request without automatic selection (${meta?.kind ?? 'ordinary'})`, async (t) => {
  const peer = fixture(t, policy, { permission: { ...ordinaryPermission, ...(meta ? { _meta: meta } : {}) } });
  if (policy === 'host') Object.assign(peer.options.protocolDialect!, { policy: 'provider_bypass' });
  const session = await peer.create(await peer.materialize());
  const execution = session.startTurn(turnInput);
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const opened = (await takeUntilRequest(iterator)).find((output) => output.kind === 'event' && output.event.type === 'request.opened');
  assert.ok(opened?.kind === 'event' && opened.event.type === 'request.opened' && opened.event.payload.request.requestKind === 'approval');
  const request = opened.event.payload.request;
  assert.deepEqual(request.options.map((option) => ({ id: option.optionId, decision: option.decision, consequence: option.consequence })), [
    { id: 'acp:option:2', decision: 'approved', consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } },
    { id: 'acp:option:3', decision: 'denied', consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } },
  ]);
  assert.equal(peer.frames.filter((frame) => frame.id === 'native:permission').length, 0);
  assert.deepEqual(await execution.resolveRequest({ resolution: { requestKind: 'approval', requestId: request.requestId,
    disposition: 'selected', optionId: request.options[0]!.optionId } }), { status: 'delivered' });
  const outputs = await collectRemaining(iterator);
  assert.deepEqual(outputs.filter((output) => output.kind === 'event' && output.event.type === 'turn.completed')
    .map((output) => output.kind === 'event' && output.event.type === 'turn.completed' ? output.event.payload.outcome : null), ['completed']);
  assert.deepEqual(peer.frames.filter((frame) => frame.id === 'native:permission').map((frame) => frame.result),
    [{ outcome: { outcome: 'selected', optionId: 'native:once' } }]);
});

for (const [policy, meta, code] of [
  ['host', { autoReview: { outcome: 'blocked' } }, 'approval_policy_mismatch'],
  ['provider_auto_review', { autoReview: { outcome: 'failed' } }, 'approval_policy_unavailable'],
  ['provider_auto_review', { autoReview: { outcome: 'failed', explanation: 17 } }, 'approval_policy_mismatch'],
  ['provider_auto_review', { autoReview: { outcome: 'unknown' } }, 'approval_policy_mismatch'],
  ['provider_auto_review', { autoReview: 'blocked' }, 'approval_policy_mismatch'],
  ['provider_auto_review', undefined, 'approval_policy_mismatch'],
  ['provider_bypass', undefined, 'approval_policy_mismatch'],
  ['provider_bypass', { autoReview: { outcome: 'blocked' } }, 'approval_policy_mismatch'],
] as const) test(`${policy} cancels and retires an unqualified callback (${JSON.stringify(meta)})`, async (t) => {
  const peer = fixture(t, policy, { permission: { ...ordinaryPermission, ...(meta ? { _meta: meta } : {}) } });
  const instance = await peer.materialize();
  const session = await peer.create(instance);
  await assert.rejects(() => Array.fromAsync(session.startTurn(turnInput).outputs), { code });
  await tick();
  assert.deepEqual(peer.frames.filter((frame) => frame.id === 'native:permission').map((frame) => frame.result),
    [{ outcome: { outcome: 'cancelled' } }]);
  assert.throws(() => session.startTurn({ ...turnInput, turnId: parseAgentTurnId('controlled:next') }), { code });
  await instance.dispose();
  assert.deepEqual(peer.observations(), { reservations: 1, releases: 1, bindingCount: 1 });
});

for (const phase of ['opening', 'turn'] as const) {
  for (const [name, update] of [
    ['mode', { sessionUpdate: 'current_mode_update', currentModeId: 'auto' }],
    ['model', { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', name: 'Model', category: 'model',
      type: 'select', currentValue: 'changed', options: [{ value: 'changed', name: 'Changed' }] }] }],
    ['policy', { sessionUpdate: 'config_option_update', configOptions: [{ id: 'policy', name: 'Policy', type: 'select',
      currentValue: 'bypass', options: [{ value: 'bypass', name: 'Bypass' }] }] }],
  ] satisfies readonly (readonly [string, AcpJsonObject])[]) test(`managed ${name} drift during ${phase} retires the controlled session`, async (t) => {
    const peer = fixture(t, 'host', phase === 'opening' ? { openingUpdate: update } : { turnUpdate: update });
    const instance = await peer.materialize();
    await assert.rejects(async () => {
      const session = await peer.create(instance);
      await Array.fromAsync(session.startTurn(turnInput).outputs);
    }, { code: 'approval_policy_mismatch' });
    await instance.dispose();
    assert.equal(peer.observations().releases, 1);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/new').length, 1);
  });
}

test('unchanged native catalog during opening and the original turn remains usable', async (t) => {
  const update: AcpJsonObject = { sessionUpdate: 'config_option_update', configOptions };
  const peer = fixture(t, 'host', { openingUpdate: update, turnUpdate: update });
  const instance = await peer.materialize();
  const session = await peer.create(instance);
  const outputs = await Array.fromAsync(session.startTurn(turnInput).outputs);
  assert.deepEqual(outputs.filter((output) => output.kind === 'event' && output.event.type === 'turn.completed')
    .map((output) => output.kind === 'event' && output.event.type === 'turn.completed' ? output.event.payload.outcome : null), ['completed']);
  assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize', 'session/new', 'session/prompt']);
});

test('closed dialect rejects incompatible entry points before their corresponding native dispatch', async (t) => {
  const peer = fixture(t, 'host');
  assert.throws(() => createNodeAcpProviderDriver({ ...peer.options, configuration: 'selectable' }), TypeError);
  assert.throws(() => createNodeAcpProviderDriver({ ...peer.options, protocolDialect: {
    mapping: 'grok-build-1.0.77-controlled-shell-v1', instanceId, nativeSessionId,
    // @ts-expect-error This exact Grok dialect cannot select another neutral policy.
    policy: 'provider_accept_edits',
  } }), { name: 'TypeError',
    message: 'The Node ACP protocol dialect must select one exact controlled Grok identity and policy.' });
  assert.throws(() => createNodeAcpProviderDriver({ ...peer.options, host: {} }), TypeError);
  for (const integration of [
    { structuredOutputMapping: { mapping: 'grok-build-1.0.62-structured-output-v1' } },
    { sessionInteractions: { mapping: 'grok-build-1.0.60-session-requests-v1' },
      launch: { ...peer.options.launch, args: ['agent', '--no-leader', 'stdio'] } },
  ] as const) {
    assert.equal(createNodeAcpProviderDriver({ providerKey, launch: peer.options.launch,
      executionBoundary: peer.options.executionBoundary, ...integration }).providerKey, providerKey);
    assert.throws(() => createNodeAcpProviderDriver({ ...peer.options, ...integration }), { name: 'TypeError',
      message: 'The controlled Grok dialect requires its fixed cwd, managed configuration and once-only permissions without optional integrations.' });
  }
  assert.throws(() => createNodeAcpProviderDriver({ ...peer.options, protocolDialect: undefined }), TypeError);
  assert.throws(() => createNodeAcpProviderDriver(Object.defineProperty({ ...peer.options }, 'protocolDialect', {
    enumerable: true, get() { throw new Error('The dialect accessor must not run.'); },
  })), TypeError);
  assert.throws(() => createNodeAcpProviderDriver({ ...peer.options,
    protocolDialect: Object.defineProperty({ ...peer.options.protocolDialect }, 'mapping', {
      enumerable: true, get() { throw new Error('The mapping accessor must not run.'); },
    }) as NodeAcpProtocolDialectSelection }), TypeError);
  await assert.rejects(async () => peer.driver.materialize({ ...definition, instanceId: parseAgentInstanceId('wrong:instance') }),
    { code: 'approval_policy_unavailable' });
  assert.deepEqual(peer.observations(), { reservations: 0, releases: 0, bindingCount: 0 });
  const instance = await peer.materialize();
  await assert.rejects(async () => peer.driver.materialize(definition), { code: 'approval_policy_unavailable' });
  const session = await peer.create(instance);
  assert.equal(instance.adapter.resumption.kind, 'unsupported');
  assert.equal(instance.capabilities.input.images.kind, 'unsupported');
  assert.throws(() => session.startTurn({ ...turnInput, parts: [{ type: 'text', text: '  /always-approve on' }] }),
    { code: 'approval_policy_configuration_forbidden' });
  const outputs = await Array.fromAsync(session.startTurn(turnInput).outputs);
  assert.deepEqual(outputs.filter((output) => output.kind === 'event' && output.event.type === 'turn.completed')
    .map((output) => output.kind === 'event' && output.event.type === 'turn.completed' ? output.event.payload.outcome : null), ['completed']);
  assert.deepEqual(peer.frames.filter((frame) => frame.method === 'session/prompt').map((frame) => frame.params?.prompt),
    [[{ type: 'text', text: 'Run the bounded fixture command.' }]]);
});

function processFixture(t: TestContext, name: string, policy: NodeAcpProtocolDialectSelection['policy'], scenario: {
  readonly delayedOpening?: boolean;
  readonly permission?: AcpJsonObject;
  readonly failFirstRelease?: boolean;
} = {}) {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'agenai-controlled-grok-')));
  const log = path.join(scratch, 'frames.jsonl');
  const effect = path.join(scratch, 'effect.txt');
  writeFileSync(log, '');
  const id = name === 'auto' ? 'ba8f6d09-dd88-4ffb-b9ad-9758421dd3d1' : nativeSessionId;
  const nativeOpening = { ...opening, sessionId: id, _meta: { currentWorkingDirectory: '/workspace/work',
    'x.ai/sessionDetail': { sessionId: id, cwd: '/workspace/work', currentModelId: 'grok-4.6', kind: 'build' } } };
  const entries = (): { readonly kind: string; readonly pid?: number; readonly cwd?: string; readonly frame?: Frame }[] =>
    readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const frames = (direction: 'inbound' | 'outbound' = 'inbound') => entries().flatMap((entry) =>
    entry.kind === direction && entry.frame ? [entry.frame] : []);
  const pid = () => { const value = entries().find((entry) => entry.kind === 'started')?.pid; assert.ok(value); return value; };
  const nativeBoundary = controlledPeerExecutionBoundary();
  const nativeOwners = new Set<ReturnType<typeof nativeBoundary.reserve>>();
  const failure = new Error('The original controlled process shutdown failed.');
  let reservations = 0;
  let releases = 0;
  const bindings: string[] = [];
  const instanceId = parseAgentInstanceId(`controlled:${name}`);
  const driver = createNodeAcpProviderDriver({ providerKey,
    protocolDialect: { mapping: 'grok-build-1.0.77-controlled-shell-v1', instanceId, nativeSessionId: id, policy },
    launch: { executable: process.execPath, args: [fileURLToPath(new URL('./node-fixtures/controlled-grok-peer.mjs', import.meta.url))],
      cwd: '/workspace/work', shutdownTimeoutMs: 100, env: { ACP_CONTROLLED_LOG: log, ACP_CONTROLLED_EFFECT: effect,
        ACP_CONTROLLED_OPENING: JSON.stringify(nativeOpening), ACP_CONTROLLED_DELAY_OPENING: String(scenario.delayedOpening === true),
        ...(scenario.permission ? { ACP_CONTROLLED_PERMISSION: JSON.stringify({ ...scenario.permission, sessionId: id }) } : {}) } },
    limits: { initializationTimeoutMs: 3_000, hostOperationTimeoutMs: 1_000 },
    executionBoundary: { reserve(input) {
      reservations += 1;
      const owner = nativeBoundary.reserve({ ...input, cwd: scratch });
      nativeOwners.add(owner);
      return { start: (context) => owner.start(context), async release() {
        releases += 1;
        if (scenario.failFirstRelease && releases === 1) {
          if (scenario.delayedOpening) {
            process.kill(pid(), 'SIGUSR1');
            await waitFor(() => frames('outbound').find((frame) => frame.result && typeof frame.result === 'object'
              && !Array.isArray(frame.result) && frame.result.sessionId === id), 'late native opening response');
          }
          throw failure;
        }
        await owner.release();
      } };
    } },
  });
  let instance: Awaited<ReturnType<typeof driver.materialize>> | undefined;
  t.after(async () => {
    try {
      if (instance) {
        try { await instance.dispose(); }
        catch { await instance.dispose(); }
      }
    }
    finally {
      await Promise.all([...nativeOwners].map((owner) => owner.release()));
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  const context: AgentProviderCreateSessionInput = { sessionId: parseAgentSessionId(`controlled:${name}:session`),
    workingDirectory: '/workspace/work', configuration, onBindingCreated(binding) { bindings.push(binding.conversationId); } };
  return { scratch, frames, pid, id, context, failure, bindings,
    effect: () => readFileSync(effect, 'utf8'), observations: () => ({ reservations, releases }),
    async materialize() { instance = await driver.materialize({ ...definition, instanceId }); return instance; },
  };
}

test('pre-aborted controlled creation preserves its fresh opening for one real subsequent turn', posix, async (t) => {
  const peer = processFixture(t, 'preaborted', 'host');
  const instance = await peer.materialize();
  const canceled = new AbortController();
  canceled.abort(new DOMException('Canceled before opening.', 'AbortError'));
  await assert.rejects(async () => instance.adapter.createSession({ ...peer.context, signal: canceled.signal }), { name: 'AbortError' });
  const session = await instance.adapter.createSession(peer.context);
  const outputs = await Array.fromAsync(session.startTurn(turnInput).outputs);
  assert.deepEqual(outputs.flatMap((output) => output.kind === 'event' && output.event.type === 'turn.completed'
    ? [output.event.payload.outcome] : []), ['completed']);
  assert.deepEqual(peer.bindings, [peer.id]);
  await instance.dispose();
  assert.deepEqual(peer.frames().filter((frame) => frame.method).map((frame) => frame.method),
    ['initialize', 'session/new', 'session/prompt']);
  assert.deepEqual(peer.observations(), { reservations: 1, releases: 1 });
  assertProcessGone(peer.pid());
});

test('canceled controlled opening retains its late successful peer and exact failed-cleanup retry', posix, async (t) => {
  const peer = processFixture(t, 'late', 'provider_auto_review', { delayedOpening: true, failFirstRelease: true });
  const instance = await peer.materialize();
  const canceled = new AbortController();
  const input = { ...peer.context, signal: canceled.signal };
  const openingOperation = Promise.resolve(instance.adapter.createSession(input));
  const failure = openingOperation.catch((error: unknown) => error);
  const dispatched = await waitFor(() => peer.frames().find((frame) => frame.method === 'session/new'), 'entered session/new');
  canceled.abort(new DOMException('Canceled after native dispatch.', 'AbortError'));
  const retained = await failure;
  assert.ok(isAgentProviderSessionCleanupErrorFor(retained, input));
  assert.equal(isAgentProviderSessionCleanupErrorFor(retained, { ...input }), false);
  assert.deepEqual(peer.frames('outbound').filter((frame) => frame.id === dispatched.id).map((frame) => frame.result),
    [opening]);
  assert.deepEqual(peer.bindings, []);
  assert.deepEqual(peer.observations(), { reservations: 1, releases: 1 });
  process.kill(peer.pid(), 0);
  await assert.rejects(async () => instance.adapter.createSession(peer.context), { code: 'approval_policy_unavailable' });
  await retained.retryCleanup();
  await retained.retryCleanup();
  assertProcessGone(peer.pid());
  await instance.dispose();
  assert.deepEqual(peer.observations(), { reservations: 1, releases: 2 });
  assert.deepEqual(peer.frames().filter((frame) => frame.method).map((frame) => frame.method), ['initialize', 'session/new', '$/cancel_request']);
});

test('independent controlled policies and scratch effects survive a peer close failure without transferring cleanup', posix, async (t) => {
  const host = processFixture(t, 'host', 'host', { permission: ordinaryPermission, failFirstRelease: true });
  const auto = processFixture(t, 'auto', 'provider_auto_review', { permission: { ...ordinaryPermission,
    _meta: { autoReview: { outcome: 'blocked', explanation: 'The native reviewer blocked this action.' } } } });
  const hostInstance = await host.materialize();
  const hostSession = await hostInstance.adapter.createSession(host.context);
  const autoInstance = await auto.materialize();
  const autoSession = await autoInstance.adapter.createSession(auto.context);
  assert.notEqual(host.scratch, auto.scratch);
  assert.notEqual(host.pid(), auto.pid());
  for (const [peer, session, decision, nativeOption] of [
    [host, hostSession, 'approved', 'native:once'], [auto, autoSession, 'denied', 'native:no'],
  ] as const) {
    const execution = session.startTurn(turnInput);
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const opened = (await takeUntilRequest(iterator)).find((output) => output.kind === 'event' && output.event.type === 'request.opened');
    assert.ok(opened?.kind === 'event' && opened.event.type === 'request.opened' && opened.event.payload.request.requestKind === 'approval');
    const request = opened.event.payload.request;
    const option = request.options.find((option) => option.decision === decision);
    assert.ok(option);
    assert.deepEqual(option.consequence, { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } });
    assert.deepEqual(await execution.resolveRequest({ resolution: { requestKind: 'approval', requestId: request.requestId,
      disposition: 'selected', optionId: option.optionId } }), { status: 'delivered' });
    const outputs = await collectRemaining(iterator);
    assert.deepEqual(outputs.flatMap((output) => output.kind === 'event' && output.event.type === 'turn.completed'
      ? [output.event.payload.outcome] : []), ['completed']);
    assert.equal(peer.effect(), `${peer.id}:${nativeOption}`);
    if (peer === host) {
      await assert.rejects(async () => hostSession.close({ reason: 'shutdown' }), (error: unknown) => error === host.failure);
      process.kill(host.pid(), 0);
      process.kill(auto.pid(), 0);
    }
  }
  await hostSession.close({ reason: 'shutdown' });
  assertProcessGone(host.pid());
  process.kill(auto.pid(), 0);
  await hostInstance.dispose();
  await autoInstance.dispose();
  assertProcessGone(auto.pid());
  assert.deepEqual([host.bindings, auto.bindings], [[host.id], [auto.id]]);
  assert.deepEqual([host.observations(), auto.observations()], [{ reservations: 1, releases: 2 }, { reservations: 1, releases: 1 }]);
  for (const peer of [host, auto]) {
    assert.deepEqual(peer.frames().filter((frame) => frame.method).map((frame) => frame.method), ['initialize', 'session/new', 'session/prompt']);
    assert.equal(peer.frames().filter((frame) => frame.id === 'native:permission').length, 1);
  }
});
