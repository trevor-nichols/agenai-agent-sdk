// ------------------------------------------------------------------------------------------------
//                acp.test.ts - Public ACP composition and sandbox cleanup ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId,
  parseAgentTurnId, type AgentEvent } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderOutput } from '@agen-ai/agent-runtime';
import type { AcpAuthenticationMethods } from '@agen-ai/provider-acp';
import { createNodeAcpProviderDriver, isNodeAcpExecutionCleanupError } from '@agen-ai/provider-acp/node';
import { createSandboxAcpIntegration } from '../src/acp/index.js';
import { fileFromBytes, SandboxCleanupError, SandboxStateError, type Sandbox } from '../src/index.js';
import { acpPeer, acpSandbox, collect, remaining, untilRequest } from './fixtures/acp.js';
import { exportFiles, gate, nextTurn } from './fixtures/backend.js';

const providerKey = parseAgentProviderKey('sandbox-acp-fixture');
const definition = { providerKey, instanceId: parseAgentInstanceId('sandbox-acp:instance'), driverConfiguration: {} };
const launch = (sandbox: Sandbox) => ({ executable: '/opt/controlled-agent', args: ['--acp', 'literal argument'],
  env: { HOME: '/home/agent', FIXTURE_VALUE: 'literal $value' }, cwd: sandbox.workspace, shutdownTimeoutMs: 15_000 });
const sessionInput = (sandbox: Sandbox, id = 'sandbox-acp:session') => ({ sessionId: parseAgentSessionId(id),
  workingDirectory: sandbox.workspace, configuration: { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('sandbox-acp:configuration') },
  onBindingCreated() {} });
const turnInput = (id = 'sandbox-acp:turn') => ({ turnId: parseAgentTurnId(id), interactionMode: 'default' as const,
  parts: [{ type: 'text' as const, text: 'Use only the guest workspace.' }] });
const events = (outputs: readonly AgentProviderOutput[]): AgentEvent[] => outputs.flatMap((output) => output.kind === 'event' ? [output.event] : []);

function driver(sandbox: Sandbox, authentication?: AcpAuthenticationMethods) {
  return createNodeAcpProviderDriver({ providerKey, launch: launch(sandbox), ...createSandboxAcpIntegration(sandbox),
    ...(authentication === undefined ? {} : { authentication }) });
}

test('the execution reservation forwards startup cancellation and joins the late process before release', { timeout: 3_000 }, async (t) => {
  const lateProcess = gate();
  const peer = acpPeer();
  const { physical, sandbox, starts } = await acpSandbox(peer, { processReply: lateProcess.promise });
  t.after(async () => { lateProcess.resolve(); await sandbox.destroy(); });
  const boundary = createSandboxAcpIntegration(sandbox).executionBoundary;
  const reservation = boundary.reserve(launch(sandbox));
  const controller = new AbortController();
  const startup = reservation.start({ instanceId: definition.instanceId, signal: controller.signal });
  const rejected = assert.rejects(async () => startup, { code: 'cancelled' });
  await physical.processEntered.promise;
  controller.abort();
  await rejected;
  assert.equal(starts[0]?.signal?.aborted, true);
  let joined = false;
  const release = Promise.resolve(reservation.release()).then(() => { joined = true; });
  await nextTurn();
  assert.equal(joined, false);
  lateProcess.resolve();
  await release;
  assert.deepEqual([physical.stopAttempts, physical.destroyAttempts, joined], [1, 0, true]);
  assert.deepEqual([...physical.resources], ['storage']);
});

test('eager provider initialization owns one process and zero-session disposal retains exportable storage', { timeout: 3_000 }, async (t) => {
  const peer = acpPeer();
  const { physical, sandbox, recipes, starts } = await acpSandbox(peer);
  t.after(() => sandbox.destroy());
  await sandbox.importTree([fileFromBytes('result.txt', Buffer.from('retained artifact\n'))]);
  const integration = createSandboxAcpIntegration(sandbox);
  const provider = createNodeAcpProviderDriver({ providerKey, launch: launch(sandbox), ...integration });
  assert.deepEqual([recipes.length, starts.length, physical.stopAttempts], [0, 0, 0]);
  const registry = await createAgentProviderRegistry({ drivers: [provider], definitions: [definition] });
  t.after(() => registry.dispose());
  assert.deepEqual(recipes, [{ executable: '/opt/controlled-agent', args: ['--acp', 'literal argument'],
    env: { HOME: '/home/agent', FIXTURE_VALUE: 'literal $value' }, cwd: '/workspace' }]);
  assert.equal(starts.length, 1);
  assert.ok(starts[0]?.signal instanceof AbortSignal);
  assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize']);
  assert.equal(Object.isFrozen(integration), true);
  assert.equal(Object.isFrozen(integration.executionBoundary), true);
  assert.equal(Object.isFrozen(integration.host), true);
  await registry.dispose();
  assert.deepEqual([...physical.resources], ['storage']);
  assert.deepEqual(await exportFiles(sandbox, ['result.txt']), [{ path: 'result.txt', bytes: Uint8Array.from(Buffer.from('retained artifact\n')), executable: false }]);
  assert.deepEqual([physical.stopAttempts, physical.destroyAttempts, peer.stdout.destroyed, peer.stderr.destroyed], [1, 0, true, true]);
  await sandbox.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('one session keeps two turns and exact permission answers after another session is rejected before acquisition', { timeout: 3_000 }, async (t) => {
  let prompts = 0;
  const peer = acpPeer({ onPrompt(peer) {
    prompts += 1;
    peer.message(`guest turn ${prompts}: α\n`);
    peer.permission(`permission:${prompts}`);
  }, onResponse(peer, frame) { if (frame.id === `permission:${prompts}`) peer.complete(); } });
  const { physical, sandbox, recipes, starts } = await acpSandbox(peer);
  t.after(() => sandbox.destroy());
  const registry = await createAgentProviderRegistry({ drivers: [driver(sandbox)], definitions: [definition] });
  t.after(() => registry.dispose());
  const instance = registry.requireInstance(definition.instanceId);
  const session = await instance.adapter.createSession(sessionInput(sandbox));
  await assert.rejects(async () => instance.adapter.createSession(sessionInput(sandbox, 'sandbox-acp:second')), SandboxStateError);
  assert.deepEqual([recipes.length, starts.length, physical.stopAttempts], [1, 1, 0]);
  for (const index of [1, 2]) {
    const execution = session.startTurn(turnInput(`sandbox-acp:turn:${index}`));
    const reader = execution.outputs[Symbol.asyncIterator]();
    const { outputs, request } = await untilRequest(reader);
    const option = request.options.find((option) => option.decision === 'approved');
    assert.ok(option);
    const resolution = { requestKind: 'approval' as const, requestId: request.requestId, disposition: 'selected' as const, optionId: option.optionId };
    assert.deepEqual(await execution.resolveRequest({ resolution }), { status: 'delivered' });
    const delivered = events([...outputs, ...await remaining(reader)]);
    assert.equal(delivered.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join(''), `guest turn ${index}: α\n`);
    assert.deepEqual(delivered.filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['completed']);
    await assert.rejects(() => execution.resolveRequest({ resolution }), { code: 'request_resolution_mismatch' });
  }
  assert.deepEqual(peer.frames.filter((frame) => frame.method === undefined).map((frame) => ({ id: frame.id, result: frame.result })), [
    { id: 'permission:1', result: { outcome: { outcome: 'selected', optionId: 'guest:allow' } } },
    { id: 'permission:2', result: { outcome: { outcome: 'selected', optionId: 'guest:allow' } } },
  ]);
  assert.deepEqual(peer.frames.filter((frame) => frame.method === 'session/new').map((frame) => frame.params), [{ cwd: '/workspace', mcpServers: [] }]);
  await session.close({});
  await registry.dispose();
  assert.deepEqual([recipes.length, starts.length, physical.stopAttempts, physical.destroyAttempts], [1, 1, 1, 0]);
});

test('empty host facilities deny filesystem and terminal requests without modifying host files', { timeout: 3_000 }, async (t) => {
  const hostDirectory = await mkdtemp(join(tmpdir(), 'agenai-sandbox-acp-host-'));
  t.after(() => rm(hostDirectory, { recursive: true, force: true }));
  const sentinel = join(hostDirectory, 'sentinel.txt');
  const marker = join(hostDirectory, 'terminal.txt');
  await writeFile(sentinel, 'host sentinel');
  const peer = acpPeer({ onPrompt(peer) { peer.message('Guest session remains usable.'); peer.complete(); } });
  const { sandbox } = await acpSandbox(peer);
  t.after(() => sandbox.destroy());
  const registry = await createAgentProviderRegistry({ drivers: [driver(sandbox)], definitions: [definition] });
  t.after(() => registry.dispose());
  const session = await registry.requireInstance(definition.instanceId).adapter.createSession(sessionInput(sandbox));
  const requests = [
    ['fs/read_text_file', { path: sentinel }],
    ['fs/write_text_file', { path: sentinel, content: 'escaped write' }],
    ['terminal/create', { command: process.execPath, args: ['--eval', 'require("node:fs").writeFileSync(process.argv[1], "escaped")', marker] }],
  ] as const;
  for (const [method, params] of requests) {
    const response = await peer.request(method, { sessionId: 'native-session', ...params }, method);
    assert.deepEqual(response.error, { code: -32602, message: 'This host facility is not available.' });
  }
  const delivered = events(await collect(session.startTurn(turnInput()).outputs));
  assert.deepEqual(delivered.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta), ['Guest session remains usable.']);
  assert.equal(await readFile(sentinel, 'utf8'), 'host sentinel');
  await assert.rejects(() => stat(marker), { code: 'ENOENT' });
});

test('authentication reconnect after session release fails without acquiring or releasing another process', { timeout: 3_000 }, async (t) => {
  const peer = acpPeer({ initialize: { protocolVersion: 1, authMethods: [{ id: 'controlled-login', name: 'Controlled login' }] } });
  const { physical, sandbox, recipes, starts } = await acpSandbox(peer);
  t.after(() => sandbox.destroy());
  const registry = await createAgentProviderRegistry({ drivers: [driver(sandbox, { device_code: { methodId: 'controlled-login' } })], definitions: [definition] });
  t.after(() => registry.dispose());
  const instance = registry.requireInstance(definition.instanceId);
  const session = await instance.adapter.createSession(sessionInput(sandbox));
  await session.close({});
  const authentication = instance.adapter.authentication;
  if (authentication.kind !== 'supported') throw new Error('Expected the explicitly selected controlled authentication method.');
  const outputs = await collect(authentication.start({ attemptId: 'controlled-reconnect', flow: 'device_code' }));
  assert.deepEqual(outputs.flatMap((output) => output.kind === 'authentication' ? [output.progress.status] : []), ['awaiting_user', 'failed']);
  assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize', 'session/new']);
  assert.deepEqual([recipes.length, starts.length, physical.stopAttempts], [1, 1, 1]);
});

for (const ending of ['interrupt', 'reader abandonment'] as const) {
  test(`${ending} retains ordinary execution semantics and stops the same sandbox at SDK close`, { timeout: 3_000 }, async (t) => {
    const peer = acpPeer({ onPrompt(peer) { peer.permission('pending-permission'); } });
    const { physical, sandbox, recipes } = await acpSandbox(peer);
    t.after(() => sandbox.destroy());
    const registry = await createAgentProviderRegistry({ drivers: [driver(sandbox)], definitions: [definition] });
    t.after(() => registry.dispose());
    const session = await registry.requireInstance(definition.instanceId).adapter.createSession(sessionInput(sandbox));
    const execution = session.startTurn(turnInput());
    const reader = execution.outputs[Symbol.asyncIterator]();
    await untilRequest(reader);
    if (ending === 'interrupt') {
      if (session.interruption.kind !== 'supported') throw new Error('Expected ordinary ACP interruption.');
      assert.deepEqual(await session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' }), { status: 'canceled' });
      assert.deepEqual(events(await remaining(reader)).filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['canceled']);
      assert.deepEqual((await peer.wait((frame) => frame.id === 'pending-permission' && frame.method === undefined)).result, { outcome: { outcome: 'cancelled' } });
      assert.equal(physical.stopAttempts, 0);
    } else {
      assert.ok(reader.return);
      await reader.return();
      await physical.stopping.promise;
      assert.throws(() => session.startTurn(turnInput('after-abandonment')), { code: 'session_closed' });
    }
    await session.close({});
    await registry.dispose();
    assert.deepEqual([recipes.length, physical.stopAttempts, physical.destroyAttempts], [1, 1, 0]);
    assert.deepEqual([...physical.resources], ['storage']);
  });
}

test('failed release preserves initialization and cleanup errors while retrying the original sandbox owner', { timeout: 3_000 }, async (t) => {
  const peer = acpPeer({ initialize: { protocolVersion: 999 } });
  const { physical, sandbox, recipes, starts } = await acpSandbox(peer, { failFirstStop: true });
  t.after(() => sandbox.destroy());
  let retained: unknown;
  try { await driver(sandbox).materialize(definition); } catch (error) { retained = error; }
  assert.ok(isNodeAcpExecutionCleanupError(retained));
  const primaryError = retained.cause;
  const cleanupError = retained.cleanupError;
  assert.ok(primaryError instanceof Error);
  assert.equal('reasonCode' in primaryError && primaryError.reasonCode, 'acp_protocol_version_unsupported');
  assert.ok(cleanupError instanceof SandboxCleanupError);
  assert.equal(cleanupError.operation, 'stop');
  assert.ok(cleanupError.cause instanceof Error);
  assert.equal(cleanupError.cause.message, 'physical stop failed');
  assert.deepEqual([recipes.length, starts.length, physical.stopAttempts, physical.destroyAttempts], [1, 1, 1, 0]);
  assert.equal(physical.resources.has('compute'), true);
  await retained.retryCleanup();
  await retained.retryCleanup();
  assert.equal(retained.cause, primaryError);
  assert.equal(retained.cleanupError, cleanupError);
  assert.deepEqual([recipes.length, starts.length, physical.stopAttempts, physical.destroyAttempts], [1, 1, 2, 0]);
  assert.deepEqual([...physical.resources], ['storage']);
});
