import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import { AgentProviderConfigurationError, AgentProviderRegistryError, createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver, type AcpConnectionLease, type AcpPermissionMenuSignature, type AcpPermissionOptionSignature, type CreateAcpProviderDriverOptions } from '../src/index.js';
import { createStreamPeer } from './node-fixtures/peer.js';
import { collectRemaining, createSessionPeer, takeUntilRequest } from './fixtures/session-peer.js';

const providerKey = parseAgentProviderKey('acp-fixture');
const definition = { providerKey, instanceId: parseAgentInstanceId('acp:instance'), driverConfiguration: {} };
const createContext = (id: string) => ({
  sessionId: parseAgentSessionId(id), workingDirectory: '/fixture',
  configuration: { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('config:fixture') }, onBindingCreated() {},
});
const hasCode = (code: string) => (error: unknown): boolean =>
  error instanceof Error && 'reasonCode' in error && error.reasonCode === code;

test('configuration rejects unknown host authority before acquiring a connection', async () => {
  let acquisitions = 0;
  const driver = createAcpProviderDriver({ providerKey, createConnection() {
    acquisitions += 1;
    return createStreamPeer().lease;
  } });
  await assert.rejects(async () => driver.materialize({ ...definition, driverConfiguration: { executable: '/bin/other' } }), AgentProviderConfigurationError);
  assert.equal(acquisitions, 0);
});

test('a retired prompt timeout rejects during construction rather than silently losing a caller budget', () => {
  let acquisitions = 0;
  assert.throws(() => createAcpProviderDriver({ providerKey,
    // @ts-expect-error Execution deadlines belong to the individual turn.
    limits: { promptTimeoutMs: 1000 },
    createConnection() { acquisitions += 1; return createStreamPeer().lease; },
  }), TypeError);
  assert.equal(acquisitions, 0);
});

test('default extension policy is captured for eager sessions, fresh sessions and resume while borrowed close only detaches', async (t) => {
  const peers: ReturnType<typeof createSessionPeer>[] = [];
  t.after(() => { for (const peer of peers) { peer.stdout.destroy(); peer.stdin.destroy(); } });
  const options = { providerKey, unknownExtensionPolicy: undefined as 'standard' | 'reject' | undefined, createConnection() {
    const peer = createSessionPeer({ agentCapabilities: { sessionCapabilities: { resume: {} } } });
    peers.push(peer);
    peer.send({ jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: { servers: [] } });
    return peer.lease;
  } };
  const driver = createAcpProviderDriver(options);
  options.unknownExtensionPolicy = 'reject';
  const instance = await driver.materialize(definition);
  t.after(() => instance.dispose());
  assert.equal(peers.length, 1);
  const first = await instance.adapter.createSession(createContext('session:1'));
  assert.equal(peers.length, 1);
  const second = await instance.adapter.createSession(createContext('session:2'));
  assert.equal(peers.length, 2);
  assert.equal(peers[0]?.frames.filter((frame) => frame.method === 'initialize').length, 1);
  assert.equal(peers[1]?.frames.filter((frame) => frame.method === 'initialize').length, 1);
  assert.equal(instance.adapter.resumption.kind, 'supported');
  if (instance.adapter.resumption.kind !== 'supported') throw new Error('Expected resume support.');
  const resumed = await instance.adapter.resumption.resumeSession({ ...createContext('session:resumed'), binding: first.binding });
  assert.equal(peers.length, 3);
  assert.deepEqual(resumed.binding, first.binding);
  assert.deepEqual(peers[2]?.frames.map((frame) => frame.method), ['initialize', 'session/resume']);
  await first.close({ reason: 'shutdown' });
  await second.close({ reason: 'shutdown' });
  await resumed.close({ reason: 'shutdown' });
  await instance.dispose();
  for (const peer of peers) {
    assert.equal(peer.stdout.destroyed, false);
    assert.equal(peer.stdin.destroyed, false);
    assert.equal(peer.stdout.listenerCount('data'), 0);
    assert.equal(peer.stdout.listenerCount('end'), 0);
    assert.equal(peer.stdout.listenerCount('close'), 0);
    peer.stdin.destroy(); peer.stdout.destroy();
  }
});

test('explicit reject is captured before acquisition and releases a rejected owned connection once', async (t) => {
  const peer = createStreamPeer();
  t.after(() => { peer.stdout.destroy(); peer.stdin.destroy(); });
  let releases = 0;
  const options = { providerKey, unknownExtensionPolicy: 'reject' as 'reject' | 'standard', createConnection() {
    peer.send({ jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: { servers: [] } });
    return { ...peer.lease, ownership: 'owned' as const, release() {
      releases += 1; peer.stdout.destroy(); peer.stdin.destroy();
    } };
  } };
  const driver = createAcpProviderDriver(options);
  options.unknownExtensionPolicy = 'standard';
  await assert.rejects(async () => driver.materialize(definition), hasCode('acp_unknown_critical_extension'));
  assert.equal(releases, 1);
  assert.equal(peer.frames.some((frame) => frame.method === 'session/new' || frame.method === 'session/prompt'), false);
  assert.equal(peer.stdout.listenerCount('data'), 0);
});

test('invalid extension policies fail during construction before invoking the connection factory', () => {
  let acquisitions = 0;
  for (const unknownExtensionPolicy of [null, '', 'other', false, 0, {}]) {
    assert.throws(() => createAcpProviderDriver({
      providerKey, unknownExtensionPolicy,
      createConnection() { acquisitions += 1; return createStreamPeer().lease; },
    } as unknown as CreateAcpProviderDriverOptions), TypeError);
  }
  assert.equal(acquisitions, 0);
});

test('malformed permission selections fail synchronously before connection acquisition', () => {
  const option = { optionId: 'native:allow', kind: 'allow_always' };
  const menu = { toolKind: 'edit', options: [option] };
  const selection = { mapping: 'declared-complete-consequences-v1', agentInfo: { name: 'session-fixture', version: '1.0.0' }, menus: [menu] };
  const sparseMenus: unknown[] = [menu]; sparseMenus.length = 2;
  const sparseOptions: unknown[] = [option]; sparseOptions.length = 2;
  const invalid: readonly [string, unknown][] = [
    ['null', null], ['unknown mapping', { mapping: 'other' }], ['callback', () => selection],
    ['policy payload', { mapping: 'once-only-v1', policy: {} }],
    ['missing identity', { ...selection, agentInfo: undefined }],
    ['blank name', { ...selection, agentInfo: { name: ' ', version: '1' } }],
    ['padded version', { ...selection, agentInfo: { name: 'peer', version: ' 1' } }],
    ['over-limit name', { ...selection, agentInfo: { name: 'x'.repeat(257), version: '1' } }],
    ['over-limit version', { ...selection, agentInfo: { name: 'peer', version: 'x'.repeat(161) } }],
    ['identity format character', { ...selection, agentInfo: { name: 'peer\u200b', version: '1' } }],
    ['no menus', { ...selection, menus: [] }], ['sparse menus', { ...selection, menus: sparseMenus }],
    ['too many menus', { ...selection, menus: Array.from({ length: 17 }, (_, index) => ({ ...menu, options: [{ ...option, optionId: `native:${index}` }] })) }],
    ['duplicate menus', { ...selection, menus: [menu, structuredClone(menu)] }],
    ['unknown tool kind', { ...selection, menus: [{ ...menu, toolKind: 'custom' }] }],
    ['no options', { ...selection, menus: [{ ...menu, options: [] }] }],
    ['sparse options', { ...selection, menus: [{ ...menu, options: sparseOptions }] }],
    ['too many options', { ...selection, menus: [{ ...menu, options: Array.from({ length: 17 }, (_, index) => ({ ...option, optionId: `native:${index}` })) }] }],
    ['duplicate option IDs', { ...selection, menus: [{ ...menu, options: [option, { ...option, kind: 'reject_always' }] }] }],
    ['missing option ID', { ...selection, menus: [{ ...menu, options: [{ kind: 'allow_always' }] }] }],
    ['empty option ID', { ...selection, menus: [{ ...menu, options: [{ ...option, optionId: '' }] }] }],
    ['padded option ID', { ...selection, menus: [{ ...menu, options: [{ ...option, optionId: ' native' }] }] }],
    ['control option ID', { ...selection, menus: [{ ...menu, options: [{ ...option, optionId: 'native\u0085id' }] }] }],
    ['over-limit option ID', { ...selection, menus: [{ ...menu, options: [{ ...option, optionId: 'x'.repeat(257) }] }] }],
    ['unknown option kind', { ...selection, menus: [{ ...menu, options: [{ ...option, kind: 'approve' }] }] }],
    ['invented consequence', { ...selection, menus: [{ ...menu, options: [{ ...option, consequence: { kind: 'provider_managed_remembrance' } }] }] }],
  ];
  let acquisitions = 0;
  for (const [name, permissionMapping] of invalid) {
    assert.throws(() => createAcpProviderDriver({ providerKey, permissionMapping,
      createConnection() { acquisitions += 1; throw new Error('Invalid selection acquired a connection.'); },
    } as unknown as CreateAcpProviderDriverOptions), TypeError, name);
  }
  assert.equal(acquisitions, 0);
});

test('constructor captures maximum bounded permission declarations without truncating menu or native option identities', { timeout: 3_000 }, async (t) => {
  const agentInfo = { name: 'n'.repeat(256), version: 'v'.repeat(160) };
  const makeOption = (menu: number, index: number): AcpPermissionOptionSignature => ({ optionId: `${menu}:${index}:`.padEnd(256, 'x'), kind: 'allow_always' });
  const makeOptions = (menu: number): [AcpPermissionOptionSignature, ...AcpPermissionOptionSignature[]] => [
    makeOption(menu, 0), ...Array.from({ length: 15 }, (_, index) => makeOption(menu, index + 1)),
  ];
  const lastOptions = makeOptions(15);
  const menus: [AcpPermissionMenuSignature, ...AcpPermissionMenuSignature[]] = [
    { toolKind: 'edit', options: makeOptions(0) },
    ...Array.from({ length: 14 }, (_, index) => ({ toolKind: 'edit' as const, options: makeOptions(index + 1) })),
    { toolKind: 'edit', options: lastOptions },
  ];
  const nativeOptions = lastOptions.map((option) => ({ ...option, name: 'Remember' }));
  const originalNativeId = lastOptions[15]!.optionId;
  const peer = createSessionPeer({ initializeResult: { protocolVersion: 1, agentInfo: { ...agentInfo } }, onPrompt(peer) {
    peer.send({ jsonrpc: '2.0', id: 'max-menu', method: 'session/request_permission', params: {
      sessionId: peer.sessionId, toolCall: { toolCallId: 'max-tool', title: 'Edit', kind: 'edit', status: 'in_progress' }, options: nativeOptions,
    } });
  }, onResolution(peer) { peer.complete(); } });
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease,
    permissionMapping: { mapping: 'declared-complete-consequences-v1', agentInfo, menus },
  });
  agentInfo.name = 'mutated';
  lastOptions[15] = { optionId: 'mutated', kind: 'reject_once' };
  menus.pop();
  const instance = await driver.materialize(definition);
  t.after(async () => { await instance.dispose(); peer.dispose(); });
  const session = await instance.adapter.createSession(createContext('session:maximum'));
  const execution = session.startTurn({ turnId: parseAgentTurnId('turn:maximum'), interactionMode: 'default', parts: [{ type: 'text', text: 'Edit file.' }] });
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const outputs = await takeUntilRequest(iterator);
  const opened = outputs.find((output) => output.kind === 'event' && output.event.type === 'request.opened');
  assert.ok(opened?.kind === 'event' && opened.event.type === 'request.opened' && opened.event.payload.request.requestKind === 'approval');
  const request = opened.event.payload.request;
  assert.equal(request.options.length, 16);
  assert.equal(request.options[15]?.optionId, 'acp:option:16');
  assert.deepEqual(await execution.resolveRequest({ resolution: {
    requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: request.options[15]!.optionId,
  } }), { status: 'delivered' });
  assert.deepEqual((await collectRemaining(iterator)).filter((output) => output.kind === 'event' && output.event.type === 'turn.completed')
    .map((output) => output.kind === 'event' && output.event.type === 'turn.completed' ? output.event.payload.outcome : undefined), ['completed']);
  assert.deepEqual(peer.frames.filter((frame) => frame.id === 'max-menu' && !frame.method).map((frame) => frame.result), [
    { outcome: { outcome: 'selected', optionId: originalNativeId } },
  ]);
});

for (const [name, initialize, permissionMapping] of [
  ['missing declared identity', { protocolVersion: 1 }, { mapping: 'declared-complete-consequences-v1', agentInfo: { name: 'declared-peer', version: '1' }, menus: [{ toolKind: 'edit', options: [{ optionId: 'allow', kind: 'allow_always' }] }] }],
  ['different declared name', { protocolVersion: 1, agentInfo: { name: 'other-peer', version: '1' } }, { mapping: 'declared-complete-consequences-v1', agentInfo: { name: 'declared-peer', version: '1' }, menus: [{ toolKind: 'edit', options: [{ optionId: 'allow', kind: 'allow_always' }] }] }],
  ['different declared version', { protocolVersion: 1, agentInfo: { name: 'declared-peer', version: '2' } }, { mapping: 'declared-complete-consequences-v1', agentInfo: { name: 'declared-peer', version: '1' }, menus: [{ toolKind: 'edit', options: [{ optionId: 'allow', kind: 'allow_always' }] }] }],
  ['Grok version only in agentInfo', { protocolVersion: 1, agentInfo: { name: 'grok', version: '1.0.50' } }, { mapping: 'grok-build-1.0.50-edit-remembrance-v1' }],
  ['different Grok metadata version', { protocolVersion: 1, _meta: { agentVersion: '1.0.51' } }, { mapping: 'grok-build-1.0.50-edit-remembrance-v1' }],
  ['over-limit Grok metadata version', { protocolVersion: 1, _meta: { agentVersion: 'x'.repeat(161) } }, { mapping: 'grok-build-1.0.50-edit-remembrance-v1' }],
] as const) {
  test(`selected permission profile rejects ${name} and releases the owned connection before any native session`, async () => {
    const peer = createStreamPeer(initialize);
    let releases = 0;
    const driver = createAcpProviderDriver({ providerKey, permissionMapping, createConnection: () => ({
      ...peer.lease, ownership: 'owned', release() { releases += 1; peer.stdout.destroy(); peer.stdin.destroy(); },
    }) });
    await assert.rejects(async () => driver.materialize(definition), hasCode('acp_permission_profile_mismatch'));
    assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize']);
    assert.equal(releases, 1);
    assert.equal(peer.stdout.destroyed, true);
  });
}

test('a changed initialized envelope is rejected before creating another native session', async (t) => {
  const peers = [createStreamPeer(), createStreamPeer({ protocolVersion: 1, agentInfo: { name: 'stream-fixture', version: '2.0.0' } })];
  let index = 0;
  const instance = await createAcpProviderDriver({ providerKey, createConnection: () => peers[index++]!.lease }).materialize(definition);
  t.after(() => instance.dispose());
  await instance.adapter.createSession(createContext('session:1'));
  await assert.rejects(async () => instance.adapter.createSession(createContext('session:2')), hasCode('acp_provider_negotiation_changed'));
  assert.deepEqual(peers[1]?.frames.map((frame) => frame.method), ['initialize']);
});

test('initialization bounds a hung factory and releases an owned lease delivered after timeout', { timeout: 1_000 }, async () => {
  let deliver: ((lease: AcpConnectionLease) => void) | undefined;
  let factorySignal: AbortSignal | undefined;
  let released = 0;
  const instance = createAcpProviderDriver({ providerKey, limits: { initializationTimeoutMs: 20 }, createConnection(context) {
    factorySignal = context.signal;
    return new Promise<AcpConnectionLease>((resolve) => { deliver = resolve; });
  } }).materialize(definition);
  await assert.rejects(async () => instance, hasCode('acp_provider_initialization_timeout'));
  assert.equal(factorySignal?.aborted, true);
  let releasedResolve: (() => void) | undefined;
  const releasedPromise = new Promise<void>((resolve) => { releasedResolve = resolve; });
  const stdout = new PassThrough(); const stdin = new PassThrough();
  deliver?.({ ownership: 'owned', stdout, stdin, release() {
    released += 1; stdout.destroy(); stdin.destroy(); releasedResolve?.();
  } });
  await releasedPromise;
  assert.equal(released, 1);
  assert.equal(stdout.destroyed, true);
});

test('invalid owned leases release their resource and propagate cleanup failures', async () => {
  let released = 0;
  const cause = new Error('owned release failed');
  const lease = { ownership: 'owned', stdout: {}, stdin: new PassThrough(), release() { released += 1; throw cause; } } as unknown as AcpConnectionLease;
  await assert.rejects(async () => createAcpProviderDriver({ providerKey, createConnection: () => lease }).materialize(definition), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors[0] instanceof TypeError);
    assert.equal(error.errors[1], cause);
    return true;
  });
  assert.equal(released, 1);
});

test('a reused stream lease is rejected without subscribing a second client', async (t) => {
  const peer = createStreamPeer();
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease });
  const first = await driver.materialize(definition);
  t.after(() => first.dispose());
  await assert.rejects(async () => driver.materialize({ ...definition, instanceId: parseAgentInstanceId('acp:other') }), hasCode('acp_provider_stream_reused'));
  assert.equal(peer.frames.filter((frame) => frame.method === 'initialize').length, 1);
});

test('readiness becomes unavailable after the initialized peer closes', async (t) => {
  const peer = createStreamPeer();
  const instance = await createAcpProviderDriver({ providerKey, createConnection: () => peer.lease }).materialize(definition);
  t.after(() => instance.dispose());
  assert.equal((await instance.checkReadiness()).status, 'ready');
  const ended = once(peer.stdout, 'end');
  peer.stdout.end();
  await ended;
  assert.equal((await instance.checkReadiness()).status, 'unavailable');
});

test('disposing an instance aborts in-progress session connection acquisition', async () => {
  let calls = 0;
  let acquireSignal: AbortSignal | undefined;
  let acquireStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { acquireStarted = resolve; });
  const instance = await createAcpProviderDriver({ providerKey, createConnection(context) {
    calls += 1;
    if (calls === 1) return createStreamPeer().lease;
    acquireSignal = context.signal; acquireStarted?.();
    return new Promise<AcpConnectionLease>(() => {});
  } }).materialize(definition);
  await instance.adapter.createSession(createContext('session:first'));
  const pending = Promise.resolve(instance.adapter.createSession(createContext('session:second')));
  const rejected = assert.rejects(pending, hasCode('acp_provider_instance_disposed'));
  await started;
  await instance.dispose();
  await rejected;
  assert.equal(acquireSignal?.aborted, true);
});

test('registry disposal can retry a transient owned release failure without repeating successful release', async () => {
  const peer = createStreamPeer();
  let attempts = 0;
  const failure = new Error('temporary release failure');
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => ({
    ...peer.lease, ownership: 'owned', release() {
      attempts += 1;
      if (attempts === 1) throw failure;
      peer.stdout.destroy(); peer.stdin.destroy();
    },
  }) });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [definition] });
  await assert.rejects(registry.dispose(), (error: unknown) => error instanceof AgentProviderRegistryError && error.code === 'instance_cleanup_failed');
  assert.equal(attempts, 1);
  assert.equal(peer.stdout.destroyed, false);
  await registry.dispose();
  assert.equal(attempts, 2);
  assert.equal(peer.stdout.destroyed, true);
  await registry.dispose();
  assert.equal(attempts, 2);
});

test('concurrent session and instance closure coalesce the owned release attempt', async () => {
  const peer = createStreamPeer();
  let attempts = 0;
  let releaseStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
  let releaseContinue: (() => void) | undefined;
  const proceed = new Promise<void>((resolve) => { releaseContinue = resolve; });
  const instance = await createAcpProviderDriver({ providerKey, createConnection: () => ({
    ...peer.lease, ownership: 'owned', async release() {
      attempts += 1; releaseStarted?.(); await proceed;
      peer.stdout.destroy(); peer.stdin.destroy();
    },
  }) }).materialize(definition);
  const session = await instance.adapter.createSession(createContext('session:close'));
  const sessionClosed = session.close({ reason: 'shutdown' });
  const instanceClosed = instance.dispose();
  await started;
  assert.equal(attempts, 1);
  releaseContinue?.();
  await Promise.all([sessionClosed, instanceClosed]);
  await session.close({ reason: 'shutdown' });
  await instance.dispose();
  assert.equal(attempts, 1);
  assert.equal(peer.stdout.destroyed, true);
});

test('a factory abort listener reentering instance disposal observes the published cleanup operation', async () => {
  let calls = 0;
  let reentered: Promise<void> | void = undefined;
  let acquireStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { acquireStarted = resolve; });
  const driver = createAcpProviderDriver({ providerKey, createConnection(context) {
    calls += 1;
    if (calls === 1) return createStreamPeer().lease;
    context.signal?.addEventListener('abort', () => { reentered = instance.dispose(); }, { once: true });
    acquireStarted?.();
    return new Promise<AcpConnectionLease>(() => {});
  } });
  const instance = await driver.materialize(definition);
  await instance.adapter.createSession(createContext('session:first'));
  const pending = Promise.resolve(instance.adapter.createSession(createContext('session:pending')));
  const rejected = assert.rejects(pending, hasCode('acp_provider_instance_disposed'));
  await started;
  const disposing = instance.dispose();
  assert.equal(reentered, disposing);
  await disposing;
  await rejected;
});
