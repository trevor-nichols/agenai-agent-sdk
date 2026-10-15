import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId } from '@agen-ai/agent-protocol';
import { isAgentProviderSessionCleanupErrorFor } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver, type AcpConnectionFactoryContext, type AcpConnectionStreams } from '../src/index.js';
import { createNodeAcpProviderDriver, isNodeAcpExecutionCleanupError,
  type NodeAcpExecutionBoundary, type NodeAcpExecutionInput, type NodeAcpExecutionReservation } from '../src/node/index.js';
import { createStreamPeer } from './node-fixtures/peer.js';

const providerKey = parseAgentProviderKey('execution-boundary-fixture');
const definition = { providerKey, instanceId: parseAgentInstanceId('execution-boundary:instance'), driverConfiguration: {} };
const launch = { executable: process.execPath, args: ['agent', '--no-leader', 'stdio'], cwd: tmpdir(), env: { CONTROLLED: 'literal' }, shutdownTimeoutMs: 20 };
const context = () => ({ sessionId: parseAgentSessionId('execution-boundary:session'), workingDirectory: tmpdir(),
  configuration: { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('execution-boundary:configuration') }, onBindingCreated() {} });
const closePeer = (peer: ReturnType<typeof createStreamPeer>) => { peer.stdin.destroy(); peer.stdout.destroy(); };

test('the Node boundary receives an immutable recipe and exact receivers before once-only startup', async () => {
  const peer = createStreamPeer();
  const events: string[] = [];
  let received: NodeAcpExecutionInput | undefined;
  const reservation: NodeAcpExecutionReservation = {
    start(input) { assert.equal(this, reservation); assert.equal(input.instanceId, definition.instanceId);
      assert.ok(input.signal instanceof AbortSignal); events.push('start'); return peer.lease; },
    release() { assert.equal(this, reservation); events.push('release'); closePeer(peer); },
  };
  const boundary: NodeAcpExecutionBoundary = { reserve(input) {
    assert.equal(this, boundary); received = input; events.push('reserve'); return reservation;
  } };
  const driver = createNodeAcpProviderDriver({ providerKey, launch, executionBoundary: boundary });
  assert.deepEqual(events, [], 'Constructor admission must be inert.');
  const instance = await driver.materialize(definition);
  assert.deepEqual(received, { ...launch });
  assert.equal(Object.isFrozen(received), true); assert.equal(Object.isFrozen(received?.args), true); assert.equal(Object.isFrozen(received?.env), true);
  const session = await instance.adapter.createSession(context());
  await Promise.all([session.close({}), session.close({})]);
  await instance.dispose();
  assert.deepEqual(events, ['reserve', 'start', 'release']);
  assert.equal(peer.frames.filter((frame) => frame.method === 'initialize').length, 1);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/new').length, 1);
});

test('selected admission rejects missing boundaries before any reservation and the root rejects Node ownership options', () => {
  assert.throws(() => createNodeAcpProviderDriver({ providerKey, launch, sessionInteractions: { mapping: 'grok-folder-trust-v1' } }), TypeError);
  let acquired = 0;
  assert.throws(() => createAcpProviderDriver({ providerKey, createConnection() { acquired += 1; throw new Error('unreachable'); },
    ...{ executionBoundary: { reserve() { acquired += 1; throw new Error('unreachable'); } } },
  }), TypeError);
  assert.equal(acquired, 0);
});

test('startup timeout retains late startup and the same in-flight release through an unbound retry', { timeout: 2_000 }, async () => {
  const startup = Promise.withResolvers<AcpConnectionStreams>();
  const released = Promise.withResolvers<void>();
  const peer = createStreamPeer();
  let signal: AbortSignal | undefined;
  let starts = 0; let releases = 0;
  const driver = createNodeAcpProviderDriver({ providerKey, launch, limits: { initializationTimeoutMs: 20 },
    executionBoundary: { reserve() { return { start(input) { starts += 1; signal = input.signal; return startup.promise; },
      release() { releases += 1; return released.promise; } }; } },
  });
  let retained: unknown;
  try { await driver.materialize(definition); } catch (error) { retained = error; }
  assert.ok(isNodeAcpExecutionCleanupError(retained));
  assert.ok(retained.cause instanceof Error && 'reasonCode' in retained.cause && retained.cause.reasonCode === 'acp_provider_initialization_timeout');
  assert.ok(retained.cleanupError instanceof Error && 'reasonCode' in retained.cleanupError && retained.cleanupError.reasonCode === 'acp_node_execution_cleanup_timeout');
  assert.equal(signal?.aborted, true); assert.deepEqual([starts, releases], [1, 1]);
  const retryCleanup = retained.retryCleanup;
  let joined = false;
  const retry = retryCleanup().then(() => { joined = true; });
  startup.resolve(peer.lease);
  await delay(5);
  assert.equal(joined, false);
  closePeer(peer); released.resolve();
  await retry;
  await retryCleanup();
  assert.deepEqual([starts, releases], [1, 1]);
  assert.equal(joined, true);
  assert.equal(peer.frames.length, 0, 'Late streams must not enter ACP initialization.');
});

for (const failure of ['startup', 'streams', 'initialize', 'permission_profile'] as const) {
  test(`${failure} failure retains its original cause and retries only a settled failed release`, async () => {
    const original = new Error('Controlled startup failed.');
    const cleanupError = new Error('Controlled release failed.');
    const peer = createStreamPeer(failure === 'initialize' ? { protocolVersion: 999 } : undefined);
    let starts = 0; let releases = 0;
    const driver = createNodeAcpProviderDriver({ providerKey, launch,
      ...(failure === 'permission_profile' ? { permissionMapping: {
        mapping: 'declared-complete-consequences-v1' as const, agentInfo: { name: 'different-peer', version: '1.0.0' },
        menus: [{ toolKind: 'edit' as const, options: [{ optionId: 'remember', kind: 'allow_always' as const }] }] as const,
      } } : {}),
      executionBoundary: { reserve() { return {
      start() { starts += 1; if (failure === 'startup') throw original;
        if (failure === 'streams') return { stdout: {}, stdin: peer.stdin } as unknown as AcpConnectionStreams;
        return peer.lease; },
      release() { releases += 1; if (releases === 1) throw cleanupError; closePeer(peer); },
    }; } } });
    let retained: unknown;
    try { await driver.materialize(definition); } catch (error) { retained = error; }
    assert.ok(isNodeAcpExecutionCleanupError(retained));
    if (failure === 'startup') assert.equal(retained.cause, original);
    else assert.ok(retained.cause instanceof Error);
    if (failure === 'permission_profile') assert.ok(retained.cause instanceof Error && 'reasonCode' in retained.cause && retained.cause.reasonCode === 'acp_permission_profile_mismatch');
    assert.equal(retained.cleanupError instanceof AggregateError ? retained.cleanupError.errors.includes(cleanupError) : retained.cleanupError === cleanupError, true);
    assert.deepEqual([starts, releases], [1, 1]);
    await retained.retryCleanup();
    await retained.retryCleanup();
    assert.deepEqual([starts, releases], [1, 2]);
    assert.equal(peer.stdout.destroyed, true);
  });
}

test('malformed and reused reservations reject before another start without releasing an existing owner', async () => {
  for (const reservation of [Promise.resolve({ start() {}, release() {} }), {}, { start() {}, release: null }]) {
    const driver = createNodeAcpProviderDriver({ providerKey, launch, executionBoundary: {
      reserve: () => reservation as unknown as NodeAcpExecutionReservation,
    } });
    await assert.rejects(async () => driver.materialize(definition), TypeError);
  }
  const peer = createStreamPeer();
  let starts = 0; let releases = 0;
  const reservation = { start() { starts += 1; return peer.lease; }, release() { releases += 1; closePeer(peer); } };
  const driver = createNodeAcpProviderDriver({ providerKey, launch, executionBoundary: { reserve: () => reservation } });
  const instance = await driver.materialize(definition);
  await assert.rejects(async () => driver.materialize({ ...definition, instanceId: parseAgentInstanceId('execution-boundary:other') }), TypeError);
  assert.deepEqual([starts, releases], [1, 0]);
  await instance.dispose();
  assert.deepEqual([starts, releases], [1, 1]);
});

test('disposal before a later startup enters releases its inert reservation without executing it', async () => {
  const peer = createStreamPeer();
  const events: string[] = [];
  let reservations = 0;
  const driver = createNodeAcpProviderDriver({ providerKey, launch, executionBoundary: { reserve() {
    const number = ++reservations;
    events.push(`reserve:${number}`);
    return { start() { events.push(`start:${number}`); return peer.lease; },
      release() { events.push(`release:${number}`); closePeer(peer); } };
  } } });
  const instance = await driver.materialize(definition);
  const first = await instance.adapter.createSession(context());
  await first.close({});
  const opening = instance.adapter.createSession({ ...context(), sessionId: parseAgentSessionId('execution-boundary:canceled') });
  const disposing = instance.dispose();
  await assert.rejects(async () => opening);
  await disposing;
  assert.deepEqual(events, ['reserve:1', 'start:1', 'release:1', 'reserve:2', 'release:2']);
});

test('a failed later acquisition belongs to the exact opening and prevents further acquisition until retry', async () => {
  const first = createStreamPeer();
  let reservations = 0; let releases = 0;
  let firstContext: AcpConnectionFactoryContext | undefined;
  const original = new Error('Later startup failed.');
  const cleanupError = new Error('Later release failed.');
  const driver = createNodeAcpProviderDriver({ providerKey, launch, executionBoundary: { reserve() {
    reservations += 1;
    if (reservations === 1) return { start(input) { firstContext = input; return first.lease; }, release() { closePeer(first); } };
    return { start() { throw original; }, release() { releases += 1; if (releases === 1) throw cleanupError; } };
  } } });
  const instance = await driver.materialize(definition);
  const firstSession = await instance.adapter.createSession(context());
  await firstSession.close({});
  const opening = { ...context(), sessionId: parseAgentSessionId('execution-boundary:later') };
  let retained: unknown;
  try { await instance.adapter.createSession(opening); } catch (error) { retained = error; }
  assert.ok(isAgentProviderSessionCleanupErrorFor(retained, opening));
  assert.equal(isAgentProviderSessionCleanupErrorFor(retained, { ...opening }), false);
  assert.equal(releases, 1, 'Opening propagation must not retry failed cleanup.');
  await assert.rejects(async () => instance.adapter.createSession({ ...opening, sessionId: parseAgentSessionId('execution-boundary:blocked') }),
    (error: unknown) => error instanceof Error && 'reasonCode' in error && error.reasonCode === 'acp_session_cleanup_pending');
  assert.equal(reservations, 2);
  await retained.retryCleanup();
  assert.equal(releases, 2);
  await instance.dispose();
  assert.equal(firstContext?.signal?.aborted, false, 'Opening authority must not be reused as execution retirement authority.');
});

test('a negotiation mismatch with failed cleanup keeps the exact opening owner until disposal retries it', async () => {
  const first = createStreamPeer();
  const second = createStreamPeer({ protocolVersion: 1, agentInfo: { name: 'changed-peer', version: '2' } });
  let reservations = 0; let releases = 0;
  const failure = new Error('Mismatch cleanup failed.');
  const driver = createNodeAcpProviderDriver({ providerKey, launch, executionBoundary: { reserve() {
    if (++reservations === 1) return { start: () => first.lease, release: () => closePeer(first) };
    return { start: () => second.lease, release() { releases += 1; if (releases === 1) throw failure; closePeer(second); } };
  } } });
  const instance = await driver.materialize(definition);
  const initial = await instance.adapter.createSession(context());
  await initial.close({});
  const opening = { ...context(), sessionId: parseAgentSessionId('execution-boundary:mismatch') };
  let retained: unknown;
  try { await instance.adapter.createSession(opening); } catch (error) { retained = error; }
  assert.ok(isAgentProviderSessionCleanupErrorFor(retained, opening));
  assert.equal(releases, 1, 'Mismatch propagation must preserve the first failed cleanup without retry.');
  assert.equal((await instance.checkReadiness()).status, 'unavailable');
  await instance.dispose();
  await retained.retryCleanup();
  assert.equal(releases, 2);
  assert.equal(second.stdout.destroyed, true);
});

test('retrying a failed release unblocks the original connection callback drain without replaying close work', { timeout: 3_000 }, async () => {
  const peer = createStreamPeer();
  const entered = Promise.withResolvers<void>();
  const nativeStopped = Promise.withResolvers<void>();
  const failure = new Error('The first controlled shutdown failed.');
  let releases = 0; let callbackJoined = 0;
  const driver = createNodeAcpProviderDriver({ providerKey, launch, sessionInteractions: { mapping: 'grok-folder-trust-v1' },
    executionBoundary: { reserve() { return {
      start() { return peer.lease; },
      release() {
        releases += 1;
        if (releases === 1) throw failure;
        closePeer(peer); nativeStopped.resolve();
      },
    }; } },
  });
  const instance = await driver.materialize(definition);
  const session = await instance.adapter.createSession({ ...context(), interactions: { onRequest: async (interaction) => {
    entered.resolve();
    await nativeStopped.promise;
    await interaction.terminal;
    callbackJoined += 1;
  } } });
  peer.send({ jsonrpc: '2.0', id: 'execution-decision', method: '_x.ai/folder_trust/request',
    params: { sessionId: 'native-session', cwd: tmpdir(), workspace: tmpdir(), configKinds: ['mcp'] } });
  await entered.promise;
  await assert.rejects(async () => session.close({ reason: 'shutdown' }));
  assert.deepEqual([releases, callbackJoined], [1, 0]);
  await session.close({ reason: 'shutdown' });
  await instance.dispose();
  assert.deepEqual([releases, callbackJoined], [2, 1]);
  assert.equal(peer.frames.filter((frame) => frame.method === 'initialize').length, 1);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 0);
});
