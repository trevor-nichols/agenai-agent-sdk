// ------------------------------------------------------------------------------------------------
//                workflow.ts - Runnable public policy, progress and native control integration
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDelegationCoordinator, createDelegationHostBinding, createInMemoryDelegationStore,
  DelegationOperationError, parseDelegationLimits, parseDelegationPolicySnapshot, resolveDelegationPolicy,
  type DelegationHostRequest,
} from '@agen-ai/agent-orchestration';
import { approveSyntheticRequest } from '../run-session.js';
import { createExampleHost } from './host.js';

const root = await mkdtemp(join(tmpdir(), 'agent-sdk-delegation-'));
let receiveRequest!: (request: DelegationHostRequest) => void;
const hostRequest = new Promise<DelegationHostRequest>((resolve) => { receiveRequest = resolve; });
const example = await createExampleHost({ root, onRequest: receiveRequest });
const limits = parseDelegationLimits({ runTimeoutMs: 15_000, queuedStartTimeoutMs: 10_000, maxWaitMs: 5_000 });
let coordinator: Awaited<ReturnType<typeof createDelegationCoordinator>> | undefined;
let closed = false;
let failure: { error: unknown } | undefined;
try {
  coordinator = await createDelegationCoordinator({ host: example.host, store: createInMemoryDelegationStore({ limits }), limits });
  const client = await coordinator.bindParent({ scope: example.parent });
  const text = (value: string) => ({ parts: [{ type: 'text' as const, text: value }] });
  const spawn = async (value: string, fast = false) => {
    const page = await client.targets();
    const target = page.targets.find((candidate) => candidate.executionMode.kind === 'certified'
      && candidate.executionMode.value === (fast ? 'fast' : 'standard'));
    assert.ok(target);
    return client.spawn({ operationId: randomUUID(), target: target.reference, expectedPolicyRevision: page.policyRevision, input: text(value) });
  };
  const settled = async (taskId: string) => {
    const receipt = await client.wait({ taskId, timeoutMs: 5_000 });
    assert.equal(receipt.status, 'settled');
    return receipt.task;
  };
  const progress = async (taskId: string) => {
    for await (const observation of client.observe({ taskId, signal: AbortSignal.timeout(5_000) })) {
      if (observation.kind === 'text') return observation;
    }
    throw new Error('The example child produced no observable progress.');
  };
  const denied = (code: string) => (error: unknown) => error instanceof DelegationOperationError && error.code === code;

  assert.deepEqual((await client.targets()).targets, []);
  assert.equal(await createDelegationHostBinding({ client }), undefined);
  await assert.rejects(client.spawn({ operationId: randomUUID(), target: example.target.reference,
    expectedPolicyRevision: 1, input: text('Disabled task') }), denied('delegation_disabled'));
  assert.equal(example.provider.invocations.length, 0);

  example.setPolicy(parseDelegationPolicySnapshot({ revision: 2, user: { enabled: true } }));
  const defaults = await client.targets();
  assert.deepEqual(defaults.targets.map((target) => target.reference.targetId), ['standard-max']);
  assert.equal(example.policy.developer.exclusions.length, 0);
  const standard = await spawn('Use the default standard target.');
  assert.equal((await settled(standard.taskId)).runs.items[0]!.outcome!.kind, 'succeeded');
  const standardInvocation = example.provider.invocations.at(-1)!;
  assert.deepEqual({ model: standardInvocation.model, speed: standardInvocation.speed, reasoning: standardInvocation.reasoning },
    { model: 'example-model', speed: 'standard', reasoning: 'max' });

  example.setPolicy(parseDelegationPolicySnapshot({ revision: 3, user: { enabled: true,
    selection: { kind: 'explicit', targets: [{ catalogId: 'example-catalog', targetId: 'fast-max' }] } } }));
  const fast = await spawn('Use an explicitly selected fast target.', true);
  assert.equal((await settled(fast.taskId)).runs.items[0]!.outcome!.kind, 'succeeded');
  assert.equal(example.provider.invocations.at(-1)!.speed, 'fast');
  const fastTarget = example.catalog.targets.find((target) => target.reference.targetId === 'fast-max')!;
  const speedOption = fastTarget.options.find((option) => option.key === 'speed')!;
  example.setPolicy(parseDelegationPolicySnapshot({ revision: 4,
    developer: { enabled: true, exclusions: [{ exclusionId: 'restricted-model-speed', providerKey: example.provider.providerKey,
      modelId: 'example-model', options: [speedOption] }] },
    user: { enabled: true, selection: { kind: 'explicit', targets: [{ catalogId: 'example-catalog', targetId: 'fast-max' }] } } }));
  const restriction = resolveDelegationPolicy({ catalog: example.catalog, policy: example.policy });
  assert.ok(restriction.decisions.find((decision) => decision.reference.targetId === 'fast-max')!
    .reasons.some((reason) => reason.code === 'developer_excluded'));
  await assert.rejects(client.spawn({ operationId: randomUUID(), target: fastTarget.reference,
    expectedPolicyRevision: 4, input: text('Excluded option') }), denied('policy_denied'));

  example.setPolicy(parseDelegationPolicySnapshot({ revision: 5, user: { enabled: true } }));
  const stale = (await client.targets()).targets[0]!;
  example.setSourceRevision(2);
  await assert.rejects(client.spawn({ operationId: randomUUID(), target: stale.reference,
    expectedPolicyRevision: 5, input: text('Stale source') }), denied('stale_target'));

  const active = await spawn('[steer] Wait for a real native steering message.');
  const observed = await progress(active.taskId);
  assert.equal((await client.inspect({ taskId: active.taskId })).runs.items[0]!.phase, 'running');
  const page = await client.targets();
  const target = page.targets[0]!.reference;
  const queued = await client.send({ operationId: randomUUID(), taskId: active.taskId, mode: 'next_turn',
    target, expectedPolicyRevision: page.policyRevision, input: text('This input belongs to the next native turn.') });
  assert.equal(queued.status, 'queued');
  assert.equal((await client.inspect({ taskId: active.taskId })).runs.items[1]!.phase, 'queued');
  const steering = await client.send({ operationId: randomUUID(), taskId: active.taskId, mode: 'steer', target,
    expectedPolicyRevision: page.policyRevision, input: text('Finish the active turn now.') });
  assert.equal(steering.status, 'delivered');
  const continued = await settled(active.taskId);
  assert.equal(continued.runs.items.length, 2);
  assert.ok(continued.runs.items.every((run) => run.outcome?.kind === 'succeeded'));

  const cancel = await spawn('[cancel] Keep working until the host interrupts.');
  await progress(cancel.taskId);
  await client.cancel({ operationId: randomUUID(), taskId: cancel.taskId });
  assert.equal((await settled(cancel.taskId)).runs.items[0]!.outcome!.kind, 'canceled');

  const approval = await spawn('[approve] Ask the host for once-only approval.');
  const request = await Promise.race([hostRequest, client.wait({ taskId: approval.taskId, timeoutMs: 5_000 })
    .then(() => { throw new Error('The native approval did not reach its live host callback.'); })]);
  assert.ok(request && request.request.requestKind === 'approval');
  assert.equal((await client.inspect({ taskId: approval.taskId })).runs.items[0]!.phase, 'waiting');
  await coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution: await approveSyntheticRequest(request.request) });
  assert.equal((await settled(approval.taskId)).runs.items[0]!.outcome!.kind, 'succeeded');
  const statistics = example.provider.statistics!();
  assert.deepEqual(statistics, { steeringMessages: 1, resumedSessions: 1, interruptions: 1, resolvedRequests: 1 });

  const shutdown = await coordinator.dispose({ mode: 'drain', timeoutMs: 5_000 });
  assert.equal(shutdown.status, 'closed');
  await example.registry.dispose();
  closed = true;
  console.log(JSON.stringify({ example: 'delegation-direct', disabledInvocations: 0,
    standardApplied: true, maxApplied: true, fastApplied: true, exclusion: 'developer_excluded', sourceChange: 'stale_target',
    progress: observed.text, steering: steering.status, nextTurnRuns: continued.runs.items.length,
    cancellation: 'canceled', approval: 'resolved', ...statistics,
    nativeInvocations: example.provider.invocations.length, cleanup: 'closed' }));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  try {
    if (!closed) {
      const receipt = await coordinator?.dispose({ mode: 'cancel', timeoutMs: 5_000 });
      if (receipt?.status === 'recovery_required') throw new Error('The example coordinator did not quiesce.');
      await example.registry.dispose();
    }
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    throw new AggregateError(failure ? [failure.error, error] : [error], `Example cleanup failed; owned resources are retained at ${root}.`);
  }
}
