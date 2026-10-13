// ------------------------------------------------------------------------------------------------
//                consumer.ts - Packed registry/provider lifecycle proof - Dependencies: public SDK
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionId, parseAgentTurnId, type AgentEvent } from '@agen-ai/agent-protocol';
import { validateAgentProviderAdapter, type AgentProviderOutput, type AgentProviderSession } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { AcpInstallationError, openAcpInstallationStore, type AcpInstallationStore } from '@agen-ai/acp-registry/node';
import { installFixture, launchEnvironment, literalArgs, prepareArtifacts, type InstalledFixture } from './installation.js';

interface PeerReport {
  readonly pid: number; readonly mode: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>;
  readonly cwd: string; readonly methods: readonly string[]; readonly permissionResponses: readonly { id: string; result: unknown }[];
  readonly emitted: number; readonly promptReady: boolean; readonly exited: boolean;
}

async function readReport(path: string): Promise<PeerReport> {
  return JSON.parse(await readFile(path, 'utf8')) as PeerReport;
}

async function waitReport(path: string, ready: (report: PeerReport) => boolean): Promise<PeerReport> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const report = await readReport(path);
    if (ready(report)) return report;
    await delay(10);
  }
  throw new Error('Fixture did not reach the bounded native-operation checkpoint.');
}

function events(outputs: readonly AgentProviderOutput[]): AgentEvent[] {
  return outputs.flatMap((output) => output.kind === 'event' ? [output.event] : []);
}

async function collect(iterator: AsyncIterator<AgentProviderOutput>, untilRequest = false): Promise<AgentProviderOutput[]> {
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const output = next.value;
    outputs.push(output);
    assert.ok(outputs.length <= 64, 'Packed streams must remain bounded.');
    if (untilRequest && output.kind === 'event' && output.event.type === 'request.opened') break;
  }
  return outputs;
}

function turn(fixture: InstalledFixture, suffix = '') {
  return { turnId: parseAgentTurnId(`${fixture.kind}-${fixture.mode}${suffix}`), interactionMode: 'default' as const,
    parts: [{ type: 'text' as const, text: 'Exercise retained offline ACP' }], signal: AbortSignal.timeout(10_000) };
}

async function provePermission(session: AgentProviderSession, fixture: InstalledFixture): Promise<void> {
  const execution = session.startTurn(turn(fixture));
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const initial = events(await collect(iterator, true));
  const requestEvent = initial.find((event) => event.type === 'request.opened');
  assert.ok(requestEvent?.type === 'request.opened' && requestEvent.payload.request.requestKind === 'approval');
  const request = requestEvent.payload.request;
  const approved = request.options.find((option) => option.decision === 'approved');
  assert.ok(approved);
  assert.equal(approved.persistence, 'once');
  assert.deepEqual(approved.scope, { kind: 'exact_action' });
  assert.equal(initial.some((event) => event.type === 'turn.completed'), false);
  const before = await waitReport(fixture.reportPath, (report) => report.promptReady);
  assert.equal(before.methods.filter((method) => method === 'session/prompt').length, 1);
  assert.deepEqual(before.permissionResponses, []);
  const resolution = { requestKind: 'approval' as const, requestId: request.requestId, disposition: 'selected' as const, optionId: approved.optionId };
  assert.deepEqual(await execution.resolveRequest({ resolution, signal: AbortSignal.timeout(10_000) }), { status: 'delivered' });
  const final = events(await collect(iterator));
  const all = [...initial, ...final];
  assert.equal(all.filter((event) => event.type === 'turn.started').length, 1);
  assert.equal(all.filter((event) => event.type === 'turn.completed').length, 1);
  assert.ok(final.some((event) => event.type === 'turn.completed' && event.payload.outcome === 'completed'));
  assert.equal(all.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join(''), 'Retained offline result');
  assert.ok(final.some((event) => event.type === 'item.completed' && event.payload.itemKind === 'dynamic_tool_call' && event.payload.status === 'completed'));
  await assert.rejects(() => execution.resolveRequest({ resolution }));
  const after = await waitReport(fixture.reportPath, (report) => report.permissionResponses.length === 1);
  assert.deepEqual(after.methods, ['initialize', 'session/new', 'session/prompt']);
  assert.deepEqual(after.permissionResponses, [{ id: 'permission-1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } }]);
}

async function proveStalledCancellation(session: AgentProviderSession, fixture: InstalledFixture): Promise<void> {
  const input = turn(fixture);
  const iterator = session.startTurn(input).outputs[Symbol.asyncIterator]();
  const started = await iterator.next();
  assert.equal(started.value?.kind === 'event' ? started.value.event.type : undefined, 'turn.started');
  await waitReport(fixture.reportPath, (report) => report.promptReady);
  const item = await iterator.next();
  assert.equal(item.value?.kind === 'event' ? item.value.event.type : undefined, 'item.started');
  assert.equal(session.interruption.kind, 'supported');
  if (session.interruption.kind !== 'supported') throw new Error('Expected cancellation port.');
  const interrupted = await session.interruption.interruptTurn({ turnId: input.turnId, reason: 'user_requested', signal: AbortSignal.timeout(5_000) });
  assert.equal(interrupted.status, 'canceled');
  assert.equal(events(interrupted.outputs ?? []).filter((event) => event.type === 'turn.completed').length, 0);
  const terminal = events(await collect(iterator)).filter((event) => event.type === 'turn.completed');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.payload.outcome, 'canceled');
  assert.equal((await iterator.next()).done, true);
  const report = await waitReport(fixture.reportPath, (value) => value.permissionResponses.length === 2 && value.methods.includes('session/cancel'));
  assert.deepEqual(report.methods, ['initialize', 'session/new', 'session/prompt', 'session/cancel']);
  assert.deepEqual(report.permissionResponses, ['unseen-1', 'unseen-2'].map((id) => ({ id, result: { outcome: { outcome: 'cancelled' } } })));
}

function hasReason(error: unknown, reason: string): boolean {
  return error instanceof Error && (Reflect.get(error, 'reasonCode') === reason || Reflect.get(error, 'code') === reason
    || hasReason(error.cause, reason));
}

async function proveFailedPeer(session: AgentProviderSession, fixture: InstalledFixture): Promise<void> {
  let delegated = 0;
  const iterator = session.startTurn({ ...turn(fixture), onProviderExecutionStarted() { delegated += 1; } }).outputs[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  const report = await waitReport(fixture.reportPath, (value) => value.promptReady);
  if (fixture.mode === 'overflow') assert.equal(report.emitted, 32);
  await assert.rejects(async () => { while (!(await iterator.next()).done) { /* consume to the failure boundary */ } },
    fixture.mode === 'overflow' ? (error: unknown) => hasReason(error, 'acp_session_queue_full') : (error: unknown) => hasReason(error, 'acp_json_invalid'));
  assert.equal(delegated, 1);
  assert.throws(() => session.startTurn(turn(fixture, '-after-failure')), { code: 'session_unusable' });
  assert.equal((await readReport(fixture.reportPath)).methods.filter((method) => method === 'session/prompt').length, 1);
}

async function executeFixture(store: AcpInstallationStore, root: string, fixture: InstalledFixture) {
  const reference = await store.acquire({ ...fixture.identity, ownerId: `${fixture.kind}-${fixture.mode}` });
  await assert.rejects(store.remove(fixture.identity), (error: unknown) => error instanceof AcpInstallationError && error.code === 'reference_active');
  const launch = await store.resolveLaunch(reference);
  assert.equal(launch.shell, false);
  assert.deepEqual(launch.env, launchEnvironment);
  assert.ok(launch.args.includes(literalArgs[1]!));
  const driver = createNodeAcpProviderDriver({ providerKey: `packed-retained-${fixture.kind}-${fixture.mode}`, launch: {
    executable: launch.executable, args: launch.args, env: launch.env, cwd: root, shutdownTimeoutMs: 1_000,
  }, limits: { initializationTimeoutMs: 5_000, cancellationTimeoutMs: 2_000, promptTimeoutMs: 10_000,
    maxQueuedMessages: 8, maxPendingRequests: 2, maxQueuedBytes: 128 * 1024 } });
  const instance = await driver.materialize({ providerKey: driver.providerKey,
    instanceId: parseAgentInstanceId(`${fixture.kind}-${fixture.mode}-instance`), driverConfiguration: {} });
  try {
    let bindings = 0;
    const session = await validateAgentProviderAdapter(instance.capabilities, instance.adapter).createSession({
      sessionId: parseAgentSessionId(`${fixture.kind}-${fixture.mode}-session`), workingDirectory: root,
      configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('packed-retained-configuration') },
      onBindingCreated() { bindings += 1; }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(bindings, 1);
    try {
      if (fixture.mode === 'permission') await provePermission(session, fixture);
      else if (fixture.mode === 'cancel') await proveStalledCancellation(session, fixture);
      else await proveFailedPeer(session, fixture);
    } finally { await session.close({ reason: 'shutdown' }); }
  } finally { await instance.dispose(); }
  const report = await readReport(fixture.reportPath);
  assert.deepEqual(report.args, literalArgs);
  assert.deepEqual(report.env, launchEnvironment);
  assert.equal(report.cwd, root);
  assert.equal(report.exited, true);
  assert.throws(() => process.kill(report.pid, 0), { code: 'ESRCH' });
  assert.equal((await store.read(fixture.identity)).receiptDigest, fixture.receiptDigest);
  await store.release(reference);
  await assert.rejects(store.resolveLaunch(reference), (error: unknown) => error instanceof AcpInstallationError && error.code === 'reference_mismatch');
  await store.remove(fixture.identity);
  return { distribution: fixture.kind, scenario: fixture.mode, planDigest: fixture.identity.planDigest,
    receiptDigest: fixture.receiptDigest, nativePromptCount: report.methods.filter((method) => method === 'session/prompt').length,
    nativeResolutionCount: report.permissionResponses.length, nativeCancellationCount: report.methods.filter((method) => method === 'session/cancel').length,
    emittedSourceCount: report.emitted, processExited: report.exited, installationRemoved: true };
}

const consumerRoot = fileURLToPath(new URL('../../', import.meta.url));
const privateRoot = process.argv[2];
assert.ok(privateRoot);
const resolvedEntrypoints: Record<string, string> = {};
for (const entrypoint of ['@agen-ai/validation', '@agen-ai/agent-protocol', '@agen-ai/agent-runtime', '@agen-ai/acp-transport',
  '@agen-ai/provider-acp', '@agen-ai/provider-acp/node', '@agen-ai/acp-registry', '@agen-ai/acp-registry/node']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(entrypoint)));
  assert.ok(resolved.startsWith(join(consumerRoot, 'node_modules') + sep), `${entrypoint} must resolve from installed tarballs`);
  assert.ok(!resolved.startsWith(privateRoot + sep), `${entrypoint} must never resolve private source`);
  resolvedEntrypoints[entrypoint] = resolved;
}
const root = await mkdtemp(join(tmpdir(), 'agenai-packed-registry-provider-'));
const originalFetch = globalThis.fetch;
const originalSentinel = process.env.ACP_PARENT_ONLY;
let fetchAttempts = 0;
process.env.ACP_PARENT_ONLY = 'must-not-reach-retained-peer';
globalThis.fetch = async () => { fetchAttempts += 1; throw new Error('Registry and artifact network access are blocked throughout this offline proof.'); };
try {
  const { artifactRoot, tools } = await prepareArtifacts(root, join(consumerRoot, 'registry-provider-fixtures'));
  const storeRoot = join(root, 'store');
  const store = await openAcpInstallationStore({ root: storeRoot });
  const fixtures: InstalledFixture[] = [];
  for (const kind of ['binary', 'npx', 'uvx'] as const) fixtures.push(await installFixture({ store, root, artifactRoot, tools, kind, mode: 'permission' }));
  for (const mode of ['cancel', 'malformed', 'overflow'] as const) fixtures.push(await installFixture({ store, root, artifactRoot, tools, kind: 'binary', mode }));
  await rm(artifactRoot, { recursive: true });
  const retainedStore = await openAcpInstallationStore({ root: storeRoot });
  const scenarios = [];
  for (const fixture of fixtures) scenarios.push(await executeFixture(retainedStore, root, fixture));
  assert.deepEqual(await readdir(join(storeRoot, 'installations')), []);
  assert.equal(fetchAttempts, 0);
  process.stdout.write(JSON.stringify({ proofKind: 'synthetic-packed-consumer', schemaProfile: 'schema-v1.23.0', resolvedEntrypoints,
    toolchains: tools.map(({ kind, version, sha256 }) => ({ kind, version, sha256 })), scenarios, registryFetchAttempts: fetchAttempts }) + '\n');
  process.stdout.write('External packed registry→binary/npm/uv→offline provider proof passed: one prompt/permission, bounded slow consumer, cancellation, malformed peer, and process/reference cleanup.\n');
} finally {
  globalThis.fetch = originalFetch;
  if (originalSentinel === undefined) delete process.env.ACP_PARENT_ONLY;
  else process.env.ACP_PARENT_ONLY = originalSentinel;
  await rm(root, { recursive: true, force: true });
}
