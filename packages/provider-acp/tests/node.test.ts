import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import { createNodeAcpProviderDriver, type CreateNodeAcpProviderDriverOptions } from '../src/node/index.js';
import { collectRemaining, takeUntilRequest } from './fixtures/session-peer.js';

const fixture = fileURLToPath(new URL('./node-fixtures/process.mjs', import.meta.url));
const providerKey = parseAgentProviderKey('node-acp-fixture');
const definition = { providerKey, instanceId: parseAgentInstanceId('node:instance'), driverConfiguration: {} };
const posixOnly = { skip: process.platform === 'win32' };
interface LogEntry { readonly type: string; readonly pid?: number; readonly argv?: string[]; readonly inherited?: unknown; readonly cwd?: string; readonly method?: string; readonly id?: string | number; readonly result?: unknown }
function setup(t: TestContext, mode = 'normal', unknownExtensionPolicy?: CreateNodeAcpProviderDriverOptions['unknownExtensionPolicy'], permissionMapping?: CreateNodeAcpProviderDriverOptions['permissionMapping']) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'agenai-node-acp-'));
  const log = path.join(cwd, 'events.jsonl');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const driver = createNodeAcpProviderDriver({ providerKey,
    ...(unknownExtensionPolicy !== undefined ? { unknownExtensionPolicy } : {}),
    ...(permissionMapping !== undefined ? { permissionMapping } : {}),
    ...(mode.startsWith('descendant_') ? { limits: { initializationTimeoutMs: 1_000 } } : {}), launch: {
    executable: process.execPath,
    args: [fixture, '$HOME', `$(touch ${path.join(cwd, 'shell-executed')})`],
    cwd, env: { ACP_FIXTURE_LOG: log, ACP_FIXTURE_MODE: mode },
    ...(mode === 'ignore_term' ? {} : { shutdownTimeoutMs: mode.startsWith('descendant_') ? 200 : 30 }),
  } });
  const entries = (): LogEntry[] => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LogEntry);
  return { driver, cwd, entries };
}
function assertExited(pid: number | undefined): void {
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH');
}

test('node launch preserves literal argv, isolates environment, runs text, and closes the owned child', posixOnly, async (t) => {
  const previous = process.env.ACP_PARENT_ONLY;
  process.env.ACP_PARENT_ONLY = 'must-not-be-inherited';
  t.after(() => { if (previous === undefined) delete process.env.ACP_PARENT_ONLY; else process.env.ACP_PARENT_ONLY = previous; });
  const { driver, cwd, entries } = setup(t, 'unknown_extension');
  const instance = await driver.materialize(definition);
  t.after(() => instance.dispose());
  const session = await instance.adapter.createSession({
    sessionId: parseAgentSessionId('node:session'), workingDirectory: cwd,
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('config:fixture') }, onBindingCreated() {},
  });
  const outputs = await Array.fromAsync(session.startTurn({
    turnId: parseAgentTurnId('node:turn'), interactionMode: 'default', parts: [{ type: 'text', text: 'hello' }],
  }).outputs);
  assert.ok(outputs.some((output) => output.kind === 'event' && output.event.type === 'turn.completed'));
  const started = entries()[0];
  assert.deepEqual(started?.argv, ['$HOME', `$(touch ${path.join(cwd, 'shell-executed')})`]);
  assert.equal(started?.inherited, null);
  assert.equal(started?.cwd, cwd);
  assert.equal(existsSync(path.join(cwd, 'shell-executed')), false);
  assert.equal(entries().filter((entry) => entry.method === 'session/prompt').length, 1);
  await instance.dispose();
  assertExited(started?.pid);
});

test('node launch forwards explicit reject and reaps the child after an unknown extension', posixOnly, async (t) => {
  const { driver, entries } = setup(t, 'unknown_extension', 'reject');
  let instance: Awaited<ReturnType<typeof driver.materialize>> | undefined;
  try {
    await assert.rejects(async () => { instance = await driver.materialize(definition); }, (error: unknown) =>
      error instanceof Error && 'reasonCode' in error && error.reasonCode === 'acp_unknown_critical_extension');
  } finally { await instance?.dispose(); }
  assert.equal(entries().some((entry) => entry.method === 'session/new'), false);
  assertExited(entries()[0]?.pid);
});

test('node launch rejects a runtime null extension policy before spawning', posixOnly, (t) => {
  assert.throws(() => setup(t, 'unknown_extension', null as unknown as 'reject'), TypeError);
});

test('node launch forwards selected remembered permissions to the original child callback and closes the child', posixOnly, async (t) => {
  const { driver, cwd, entries } = setup(t, 'remembered_permission', undefined, {
    mapping: 'declared-complete-consequences-v1', agentInfo: { name: 'node-fixture', version: '1.0.0' },
    menus: [{ toolKind: 'edit', options: [{ optionId: 'native:node-remember', kind: 'allow_always' }] }],
  });
  const instance = await driver.materialize(definition);
  t.after(() => instance.dispose());
  const session = await instance.adapter.createSession({
    sessionId: parseAgentSessionId('node:remembered-session'), workingDirectory: cwd,
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('config:fixture') }, onBindingCreated() {},
  });
  const execution = session.startTurn({ turnId: parseAgentTurnId('node:remembered-turn'), interactionMode: 'default', parts: [{ type: 'text', text: 'Edit file.' }] });
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const opened = (await takeUntilRequest(iterator)).find((output) => output.kind === 'event' && output.event.type === 'request.opened');
  assert.ok(opened?.kind === 'event' && opened.event.type === 'request.opened' && opened.event.payload.request.requestKind === 'approval');
  const request = opened.event.payload.request;
  assert.deepEqual(request.options.map((option) => [option.optionId, option.decision, option.consequence.kind]), [
    ['acp:option:1', 'approved', 'provider_managed_remembrance'],
  ]);
  assert.deepEqual(await execution.resolveRequest({ resolution: {
    requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: request.options[0]!.optionId,
  } }), { status: 'delivered' });
  const outputs = await collectRemaining(iterator);
  assert.deepEqual(outputs.filter((output) => output.kind === 'event' && output.event.type === 'turn.completed')
    .map((output) => output.kind === 'event' && output.event.type === 'turn.completed' ? output.event.payload.outcome : undefined), ['completed']);
  assert.deepEqual(entries().filter((entry) => entry.id === 'node:permission').map((entry) => entry.result), [
    { outcome: { outcome: 'selected', optionId: 'native:node-remember' } },
  ]);
  assert.equal(entries().filter((entry) => entry.method === 'session/prompt').length, 1);
  await session.close({ reason: 'shutdown' });
  await instance.dispose();
  assertExited(entries()[0]?.pid);
});

test('owned process cleanup escalates when the peer ignores graceful termination', posixOnly, async (t) => {
  const { driver, entries } = setup(t, 'ignore_term');
  const instance = await driver.materialize(definition);
  t.after(() => instance.dispose());
  const pid = entries()[0]?.pid;
  assert.ok(pid);
  await instance.dispose();
  assert.ok(entries().some((entry) => entry.type === 'ignored_term'));
  assertExited(pid);
  assert.throws(() => process.kill(-pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH');
  await instance.dispose();
});

for (const mode of ['descendant_inherited_stdio', 'descendant_ignored_stdio', 'descendant_early_exit', 'descendant_peer']) {
  test(`owned process cleanup terminates descendants for ${mode}`, { ...posixOnly, timeout: 10_000 }, async (t) => {
    const { driver, entries } = setup(t, mode);
    let instance: Awaited<ReturnType<typeof driver.materialize>> | undefined;
    try {
      if (mode === 'descendant_early_exit') await assert.rejects(async () => driver.materialize(definition));
      else {
        instance = await driver.materialize(definition);
        await Promise.all([instance.dispose(), instance.dispose()]);
      }
      const processes = entries().filter((entry) => entry.type === 'started' || entry.type === 'descendant_started');
      assert.equal(processes.length, 2);
      for (const entry of processes) assertExited(entry.pid);
    } finally {
      for (const entry of entries().filter((entry) => entry.type === 'started' || entry.type === 'descendant_started')) {
        try { process.kill(entry.pid!, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await instance?.dispose();
    }
  });
}

for (const mode of ['early_exit', 'malformed']) {
  test(`node ${mode} during initialization rejects and leaves no child`, posixOnly, async (t) => {
    const { driver, entries } = setup(t, mode);
    await assert.rejects(async () => driver.materialize(definition));
    assertExited(entries()[0]?.pid);
  });
}

test('missing executable fails materialization and relative launch paths fail before spawn', posixOnly, async () => {
  const driver = createNodeAcpProviderDriver({ providerKey, launch: { executable: '/agenai-fixture-does-not-exist', cwd: tmpdir() } });
  await assert.rejects(async () => driver.materialize(definition), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
  assert.throws(() => createNodeAcpProviderDriver({ providerKey, launch: { executable: 'node', cwd: tmpdir() } }), TypeError);
});

test('the built-in launcher rejects Windows before creating an unowned process tree', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  assert.throws(() => createNodeAcpProviderDriver({ providerKey, launch: {
    executable: process.execPath, cwd: tmpdir(),
  } }), { reasonCode: 'acp_provider_process_platform_unsupported' });
});
