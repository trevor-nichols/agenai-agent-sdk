// ------------------------------------------------------------------------------------------------
//                failures.ts - Provider retries, durable classified failures and uncertain execution
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  parseAgentError, parseAgentIsoDateTime, parseAgentSessionId, parseAgentTurnId,
} from '@agen-ai/agent-protocol';
import { createAgentEventOutput } from '@agen-ai/agent-runtime';
import {
  createDelegationCoordinator, DelegationOperationError, parseDelegationPolicySnapshot,
  type DelegationRunOutcome,
} from '@agen-ai/agent-orchestration';
import { qualifiedTuple } from './durable/state.js';
import { createExampleHost } from './host.js';
import { createExampleProvider } from './provider.js';
import { openSqliteDelegationStore } from './sqlite/index.js';

const retryError = parseAgentError({ category: 'overloaded', code: 'provider_busy',
  message: 'The provider is temporarily overloaded.', recovery: { kind: 'retry' } });
const quotaError = parseAgentError({ category: 'quota_exhausted', code: 'allowance_exhausted',
  message: 'The child allowance is exhausted.', recovery: { kind: 'wait_for_quota' } });
const disconnectError = parseAgentError({ category: 'transport', code: 'connection_reset',
  message: 'The connection was lost after execution started.', recovery: { kind: 'retry' } });
const input = (text: string) => ({ parts: [{ type: 'text' as const, text }] });

async function openExample(root: string) {
  const provider = await createExampleProvider({ async *outputs(context, turn) {
    const base = { protocolVersion: 10 as const, sessionId: context.sessionId, turnId: turn.turnId,
      occurredAt: parseAgentIsoDateTime(new Date().toISOString()) };
    yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
    const scenario = turn.parts.find((part) => part.type === 'text')?.text;
    if (scenario === 'retry') {
      yield createAgentEventOutput({ ...base, type: 'runtime.retrying',
        payload: { owner: 'provider', error: retryError, attempt: 1, maxAttempts: 1, delayMs: 0 } });
      yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: { outcome: 'completed' } });
    } else if (scenario === 'quota') {
      yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: { outcome: 'failed', error: quotaError } });
    } else {
      // A recovery hint is information. It cannot prove that effects were not applied.
      throw disconnectError;
    }
  } });
  const example = await createExampleHost({ root, provider });
  example.setPolicy(parseDelegationPolicySnapshot({ revision: 2, user: { enabled: true } }));
  return example;
}

type Example = Awaited<ReturnType<typeof openExample>>;
type Coordinator = Awaited<ReturnType<typeof createDelegationCoordinator>>;

async function withStore<Value>(root: string, action: (example: Example, coordinator: Coordinator) => Promise<Value>): Promise<Value> {
  const example = await openExample(root);
  let opened: ReturnType<typeof openSqliteDelegationStore> | undefined;
  let coordinator: Coordinator | undefined;
  try {
    opened = openSqliteDelegationStore({ root: join(root, 'database') });
    coordinator = await createDelegationCoordinator({ host: example.host, store: opened.store, limits: opened.store.limits });
    return await action(example, coordinator);
  } finally {
    if (coordinator) assert.equal((await coordinator.dispose({ mode: 'drain', timeoutMs: 5_000 })).status, 'closed');
    else opened?.closeUnused();
    await example.registry.dispose();
  }
}

async function retryThenSuccess(example: Example, root: string) {
  const session = await example.registry.requireInstance(example.provider.instanceId).adapter.createSession({
    sessionId: parseAgentSessionId('failure-example:retry'), workingDirectory: root,
    configuration: example.target.application.configuration, signal: AbortSignal.timeout(5_000),
    onBindingCreated() {},
  });
  try {
    const events = [];
    for await (const output of session.startTurn({ turnId: parseAgentTurnId('failure-example:retry:turn'),
      interactionMode: 'default', ...input('retry'), signal: AbortSignal.timeout(5_000) }).outputs) {
      if (output.kind === 'event') events.push(output.event);
    }
    assert.deepEqual(events.map((event) => event.type), ['turn.started', 'runtime.retrying', 'turn.completed']);
    const retry = events.find((event) => event.type === 'runtime.retrying');
    const terminal = events.find((event) => event.type === 'turn.completed');
    assert.ok(retry?.type === 'runtime.retrying' && terminal?.type === 'turn.completed');
    assert.equal(retry.payload.owner, 'provider');
    assert.equal(terminal.payload.outcome, 'completed');
    assert.equal(example.provider.invocations.length, 1, 'Provider retry observations do not start another host turn.');
    return { observations: 1, terminalCount: 1, outcome: terminal.payload.outcome, providerInvocations: 1 };
  } finally {
    await session.close({ reason: 'shutdown' });
  }
}

async function demonstrate(root: string) {
  const written = await withStore(root, async (example, coordinator) => {
    const retry = await retryThenSuccess(example, root);
    const client = await coordinator.bindParent({ scope: example.parent });
    const page = await client.targets();
    const target = page.targets[0];
    assert.ok(target);
    const reference = target.reference;
    async function settle(scenario: string) {
      const admitted = await client.spawn({ operationId: randomUUID(), target: reference,
        expectedPolicyRevision: page.policyRevision, input: input(scenario), completionPolicy: 'collect' });
      const settled = await client.wait({ taskId: admitted.taskId, timeoutMs: 5_000 });
      assert.equal(settled.status, 'settled');
      const outcome = settled.task.runs.items[0]?.outcome;
      assert.ok(outcome);
      return { taskId: admitted.taskId, runId: admitted.runId, outcome };
    }
    const failed = await settle('quota');
    assert.deepEqual(failed.outcome, { kind: 'failed', error: quotaError });
    const uncertain = await settle('disconnect');
    assert.deepEqual(uncertain.outcome, { kind: 'recovery_required', reason: 'dispatch_uncertain' });
    assert.equal(example.provider.invocations.length, 3);
    return { retry, failed, uncertain };
  });

  // The previous coordinator and registry are closed before the same SQLite store is reopened.
  const collected = await withStore(root, async (example, coordinator) => {
    const client = await coordinator.bindParent({ scope: example.parent });
    const outcomes: DelegationRunOutcome[] = [];
    for (const original of [written.failed, written.uncertain]) {
      const retained = await client.wait({ taskId: original.taskId, timeoutMs: 5_000 });
      assert.equal(retained.status, 'settled');
      assert.equal(retained.task.runs.items.length, 1);
      assert.equal(retained.task.runs.items[0]?.runId, original.runId);
      assert.deepEqual(retained.task.runs.items[0]?.outcome, original.outcome);
      outcomes.push(retained.task.runs.items[0]!.outcome!);
    }
    assert.deepEqual((await coordinator.recover({ limit: 10 })).recovered, []);
    const page = await client.targets();
    const target = page.targets[0];
    assert.ok(target);
    for (const mode of ['follow_up', 'next_turn'] as const) {
      await assert.rejects(client.send({ operationId: randomUUID(), taskId: written.uncertain.taskId, mode,
        target: target.reference, expectedPolicyRevision: page.policyRevision, input: input('disconnect') }),
      (error: unknown) => error instanceof DelegationOperationError && error.code === 'recovery_required');
    }
    assert.equal(example.provider.invocations.length, 0, 'Reopening, recovery and a retry hint must not replay the child.');
    return { failed: outcomes[0], uncertain: outcomes[1], providerInvocations: 0 };
  });
  return { example: 'delegation-failures', evidence: 'synthetic', retry: written.retry,
    collected: { reopened: true, outcome: collected.failed },
    uncertain: { recoveryHint: disconnectError.recovery.kind, outcome: collected.uncertain,
      rejectedModes: ['follow_up', 'next_turn'], providerInvocationsAfterReopen: collected.providerInvocations },
    providerInvocations: 3, cleanup: 'closed' };
}

const requestedBase = process.env.AGENT_SDK_DURABLE_TEST_ROOT ?? join(process.cwd(), '.agent');
assert.ok(isAbsolute(requestedBase), 'The durable example base must be absolute.');
await mkdir(requestedBase, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(await realpath(requestedBase), 'agent-sdk-failures-'));
let complete = false;
try {
  qualifiedTuple(root);
  const summary = await demonstrate(root);
  await rm(root, { recursive: true });
  complete = true;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  if (!complete) process.stderr.write(`Failure example resources remain available for inspection at ${root}\n`);
}
