// ------------------------------------------------------------------------------------------------
//                commands.ts - Durable demo recovery, passive inspection and offline cleanup
// ------------------------------------------------------------------------------------------------

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createDelegationCoordinator, parseDelegationPolicySnapshot, type DelegationCoordinator,
  type DelegationParentDeliveryPort, type DelegationStore } from '@agen-ai/agent-orchestration';
import { createExampleHost, type ExampleHost } from '../host.js';
import { createSqliteParentInbox, sqliteParentInboxSchema, type SqliteParentInbox } from '../inbox/index.js';
import { openSqliteDelegationStore } from '../sqlite/index.js';
import { withDemoAdmission } from './admission.js';
import { createDurableParent, parentSessionPrefix } from './parent.js';
import { createDemo, qualifiedTuple, readAuthority, readEffects, readParentInput, readState, recordEffect,
  updateState, writeJson, type DemoState, type Scenario } from './state.js';

export async function emit(value: unknown) {
  await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve()));
}
async function withCleanup<Value>(action: () => Promise<Value>, release: () => Promise<void>): Promise<Value> {
  let result: Value | undefined;
  let primary: { error: unknown } | undefined;
  try { result = await action(); } catch (error) { primary = { error }; }
  try { await release(); }
  catch (error) {
    if (primary) throw new AggregateError([primary.error, error], 'The durable command and its ordered cleanup both failed; retain the directory.');
    throw error;
  }
  if (primary) throw primary.error;
  return result as Value;
}
async function acquire(opened: ReturnType<typeof openSqliteDelegationStore>) {
  try { return await opened.store.acquireOwner(); }
  catch (error) {
    try { opened.closeUnused(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'The reference owner acquisition and unused-handle close both failed.'); }
    throw error;
  }
}
async function fault(root: string, boundary: string): Promise<never> {
  const { scenario, taskId, runId, notificationId, inboxId } = readState(root);
  await emit({ schemaVersion: 1, event: 'fault', command: 'setup', scenario, root, boundary, expectedSignal: 'SIGKILL',
    taskId, runId, notificationId, inboxId, effects: readEffects(root) });
  process.kill(process.pid, 'SIGKILL');
  return new Promise<never>(() => {});
}
function open(state: DemoState) {
  qualifiedTuple(state.root);
  const opened = openSqliteDelegationStore({ root: join(state.root, 'database'), inboxSchema: sqliteParentInboxSchema });
  if (state.storeId && state.storeId !== opened.store.storeId) {
    opened.closeUnused();
    throw new Error('The durable example database identity changed.');
  }
  return opened;
}
async function snapshot(state: DemoState, store: DelegationStore, inbox: SqliteParentInbox) {
  if (!state.taskId || !state.runId) throw new Error('The durable example has no committed task identity.');
  const task = await store.read({ kind: 'task', taskId: state.taskId, limit: 1 });
  if (task.kind !== 'task' || !task.view) throw new Error('The durable example task is unavailable.');
  const run = task.view.runs.items[0];
  if (!run || run.runId !== state.runId) throw new Error('The durable example run identity changed.');
  const notification = state.notificationId ? await store.read({ kind: 'notification', notificationId: state.notificationId }) : undefined;
  const retained = state.notificationId ? inbox.inspect({ parent: state.parent, storeId: store.storeId, notificationId: state.notificationId }) : undefined;
  const parentDelivery = readParentInput(state.root);
  return { schemaVersion: 1, event: 'complete', scenario: state.scenario, root: state.root, storeId: store.storeId,
    task: { taskId: state.taskId, runId: state.runId, state: task.view.task.state, outcome: run.outcome },
    ...(notification?.kind === 'notification' && notification.notification ? {
      notification: { notificationId: state.notificationId, state: notification.notification.state },
    } : {}),
    ...(retained ? { inbox: { inboxId: retained.inboxId, state: retained.state } } : {}), effects: readEffects(state.root),
    ...(parentDelivery ? { parentDelivery } : {}) };
}
async function waitForNotification(store: DelegationStore, root: string) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const state = readState(root);
    if (state.notificationId) {
      const result = await store.read({ kind: 'notification', notificationId: state.notificationId });
      if (result.kind === 'notification' && result.notification?.state === 'accepted') return;
    }
    if (Date.now() >= deadline) throw new Error('The durable example notification did not reconcile within its bounded wait.');
    await setTimeout(5);
  }
}
async function execute(command: 'setup' | 'restart', initial: DemoState) {
  const root = initial.root;
  if (command === 'restart' && (!initial.storeId || !initial.taskId)) throw new Error('An incomplete durable setup cannot be restarted.');
  const opened = open(initial);
  updateState(root, { storeId: opened.store.storeId });
  let example: ExampleHost;
  try { example = await createExampleHost({ root, readAuthority: () => readAuthority(root), onChildInvoke: async (context, turn) => {
    if (context.sessionId.startsWith(parentSessionPrefix)) {
      const authority = readAuthority(root);
      if (!authority.executionAllowed || !authority.resultAccess || authority.lifecycle !== 'idle') throw new Error('The parent continuation is revoked.');
      recordEffect(root, 'parent');
      writeJson(root, 'parent-input.json', { text: turn.parts.filter((part) => part.type === 'text').map((part) => part.text).join('') });
    } else {
      recordEffect(root, 'child');
      if (command === 'setup' && initial.scenario === 'uncertain') await fault(root, 'child_effect_before_terminal');
    }
  } }); }
  catch (error) { return withCleanup(async () => { throw error; }, async () => { opened.closeUnused(); }); }
  example.setPolicy(parseDelegationPolicySnapshot({ revision: 2, developer: { enabled: true, exclusions: [] }, user: { enabled: true } }));
  const inbox = createSqliteParentInbox({ database: opened.database, host: createDurableParent(root, example.registry, example.target) });
  const store: DelegationStore = { ...opened.store, async commit(input) {
    const receipt = await opened.store.commit(input);
    if (input.kind === 'admit') updateState(root, { taskId: input.taskId, runId: input.admission.runId });
    if (input.kind === 'settle') updateState(root, { notificationId: receipt.notificationId! });
    return receipt;
  } };
  const delivery: DelegationParentDeliveryPort = { ...inbox.port, async accept(input) {
    const accepted = await inbox.port.accept(input);
    if (accepted.status === 'accepted') {
      updateState(root, { inboxId: accepted.inboxId });
      if (command === 'setup' && (initial.scenario === 'lost-ack' || initial.scenario === 'revoked')) {
        if (initial.scenario === 'revoked') writeJson(root, 'authority.json', { ...readAuthority(root), executionAllowed: false });
        await fault(root, 'inbox_accept_before_ack');
      }
    }
    return accepted;
  } };
  let coordinator: DelegationCoordinator;
  try { coordinator = await createDelegationCoordinator({ host: example.host, store, limits: store.limits, parentDelivery: delivery }); }
  catch (error) {
    await withCleanup(async () => { throw error; }, async () => {
      opened.closeUnused();
      await example.registry.dispose();
    });
    throw error;
  }
  const result = await withCleanup(async () => {
    const client = await coordinator.bindParent({ scope: initial.parent });
    if (command === 'setup') await client.spawn({ operationId: initial.operationId, target: example.target.reference,
      expectedPolicyRevision: 2, input: { parts: [{ type: 'text', text: 'Produce a bounded durable delegation example result.' }] },
      completionPolicy: initial.scenario === 'uncertain' ? 'collect' : 'automatic' });
    const identity = readState(root);
    if (!identity.taskId) throw new Error('The durable example admission did not retain its task identity.');
    const waiting = await client.wait({ taskId: identity.taskId, timeoutMs: 5_000 });
    if (waiting.status !== 'settled') throw new Error('The durable example task did not settle within its bounded wait.');
    if (initial.scenario !== 'uncertain') {
      await waitForNotification(store, root);
      await inbox.dispatchPending({ parent: initial.parent, trigger: 'automatic', limit: 1 });
    }
    return snapshot(readState(root), store, inbox);
  }, async () => {
    if ((await inbox.dispose()).status !== 'closed') throw new Error('The durable parent inbox retains live cleanup.');
    if ((await coordinator.dispose({ mode: 'drain', timeoutMs: 5_000 })).status !== 'closed') throw new Error('The durable coordinator retains live cleanup.');
    await example.registry.dispose();
  });
  await emit({ ...result, command, shutdown: 'closed' });
}
export async function setup(base: string | undefined, scenario: Scenario) {
  const state = createDemo(base, scenario);
  await withDemoAdmission(state, async (current) => {
    await emit({ schemaVersion: 1, event: 'ready', command: 'setup', scenario, root: current.root, tuple: qualifiedTuple(current.root) });
    await execute('setup', current);
  });
}
export async function restart(root: string) {
  await withDemoAdmission(readState(root), (state) => execute('restart', state));
}
export async function inspect(root: string) {
  await withDemoAdmission(readState(root), async (state) => {
    if (!state.storeId || !state.taskId) throw new Error('The durable setup has no committed task to inspect.');
    const opened = open(state);
    const owner = await acquire(opened);
    const inbox = createSqliteParentInbox({ database: opened.database, host: createDurableParent(root) });
    const result = await withCleanup(() => snapshot(state, opened.store, inbox), async () => {
      if ((await inbox.dispose()).status !== 'closed') throw new Error('The durable inbox retains cleanup.');
      await opened.store.releaseOwner(owner);
    });
    await emit({ ...result, command: 'inspect', shutdown: 'closed' });
  });
}
export async function cleanup(root: string) {
  await withDemoAdmission(readState(root), async (state) => {
    if (!state.storeId) throw new Error('An incomplete durable example root is retained for inspection.');
    const opened = open(state);
    const owner = await acquire(opened);
    await withCleanup(async () => { readState(root); }, () => opened.store.releaseOwner(owner));
    readState(root);
    rmSync(root, { recursive: true });
    await emit({ schemaVersion: 1, event: 'complete', command: 'cleanup', root, removed: true });
  });
}
