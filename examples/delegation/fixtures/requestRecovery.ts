// ------------------------------------------------------------------------------------------------
//                requestRecovery.ts - Accepted answers across failed durable receipt acknowledgement
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentRequestResolution } from '@agen-ai/agent-protocol';
import { createDelegationCoordinator, type DelegationHostRequest, type DelegationOperationRecord } from '@agen-ai/agent-orchestration';
import { openSqliteDelegationStore } from '../sqlite/index.js';
import { createReferenceHost, input, parent } from './host.js';
import { barrier, invocationCount, persistJson, readJson, recordInvocation } from './journal.js';
import { hasCode, withCommit } from './store.js';
import { formatThreeFixture } from './migration/materialize.js';
import { rememberedApproval, rememberedExecution, rememberedOptionId, rememberedProviderOptions } from './rememberedRequest.js';
import { assertRetainedRequestHistory, inspectRequestHistory, rawRequestHistory, type RawRequestHistory } from './requestHistory.js';

export type RequestReceiptLoss = 'before_commit' | 'after_commit';

interface RetainedRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly operation: DelegationOperationRecord;
  readonly resolution: AgentRequestResolution;
  readonly raw: RawRequestHistory;
}

function expectedResolutionDigest(taskId: string, runId: string, resolution: AgentRequestResolution) {
  if (resolution.requestKind !== 'approval' || resolution.disposition !== 'selected') throw new Error('Expected a selected approval.');
  // This exact canonical input contract contains the selected ID, never the offered consequence.
  return createHash('sha256').update(JSON.stringify({ kind: 'request_resolution', requestId: resolution.requestId,
    resolution: { disposition: 'selected', optionId: resolution.optionId, requestId: resolution.requestId, requestKind: 'approval' },
    runId, taskId })).digest('hex');
}

export async function failRequestReceipt(root: string, loss: RequestReceiptLoss) {
  const opened = openSqliteDelegationStore({ root: join(root, 'database') });
  let offerRequest!: (request: DelegationHostRequest) => void;
  const requested = new Promise<DelegationHostRequest>((resolve) => { offerRequest = resolve; });
  const operationId = randomUUID();
  let receiptWrites = 0;
  const reference = await createReferenceHost({ root, fakeOptions: rememberedProviderOptions(), onInvoke: () => recordInvocation(root, 'child'),
    onRequest: offerRequest, execution: (_session, context, turn) => rememberedExecution(context, turn, () => recordInvocation(root, 'answer')),
  });
  const store = withCommit(opened.store, async (command) => {
    if (command.kind === 'operation_receipt' && command.operationId === operationId) {
      assert.equal(command.disposition, 'delivered');
      receiptWrites += 1;
      if (loss === 'after_commit') await opened.store.commit(command);
      throw new Error('The request receipt acknowledgement was lost.');
    }
    return opened.store.commit(command);
  });
  const coordinator = await createDelegationCoordinator({ host: reference.host, store, limits: store.limits });
  const client = await coordinator.bindParent({ scope: parent });
  const admitted = await client.spawn({ operationId: randomUUID(), target: reference.target.reference, expectedPolicyRevision: 1, input });
  const request = await requested;
  if (request.request.requestKind !== 'approval') throw new Error('Expected a real child approval request.');
  assert.deepEqual(request.request, rememberedApproval(request.request.requestId), 'The live host must receive the complete offered descriptor, including both unknown remembered boundaries.');
  const selected = request.request.options.find((option) => option.optionId === rememberedOptionId);
  assert.ok(selected);
  assert.equal(selected.consequence.kind, 'provider_managed_remembrance');
  assert.deepEqual(request.run.pendingRequest, { requestId: request.request.requestId, requestKind: 'approval',
    openedAt: request.run.pendingRequest?.openedAt, state: 'waiting' }, 'The persisted projection carries only informational request metadata.');
  const resolution: AgentRequestResolution = { requestKind: 'approval', requestId: request.request.requestId,
    disposition: 'selected', optionId: selected.optionId };
  await assert.rejects(coordinator.resolveRequest({ handle: request.handle, operationId, resolution }), hasCode('store_failed'));
  assert.equal(receiptWrites, 1);
  assert.equal(invocationCount(root, 'child'), 1);
  assert.equal(invocationCount(root, 'answer'), 1);
  const retained = await opened.store.read({ kind: 'operation', parent, operationId });
  assert.equal(retained.kind, 'operation');
  assert.ok(retained.operation);
  assert.equal(retained.operation.disposition, loss === 'before_commit' ? 'intent' : 'delivered');
  assert.deepEqual(retained.operation.request, { requestId: resolution.requestId, requestKind: 'approval' });
  assert.equal(retained.operation.inputDigest, expectedResolutionDigest(admitted.taskId, admitted.runId, resolution));
  const raw = opened.database.read((database) => rawRequestHistory(database, operationId, admitted.runId));
  assert.equal(raw.format, 3);
  persistJson(root, 'request-receipt.json', { taskId: admitted.taskId, runId: admitted.runId, operation: retained.operation, resolution, raw } satisfies RetainedRequest);
  await barrier('crash', { loss, receiptWrites, disposition: retained.operation.disposition, display: request.request, selectedOptionId: selected.optionId });
  throw new Error('Request receipt recovery qualification requires SIGKILL.');
}

export async function recoverRequestReceipt(root: string, loss: RequestReceiptLoss) {
  const retained = readJson<RetainedRequest>(root, 'request-receipt.json');
  const beforeOpen = inspectRequestHistory(root, retained.operation.operationId, retained.runId);
  assertRetainedRequestHistory(beforeOpen, retained.raw);
  const opened = openSqliteDelegationStore({ root: join(root, 'database') });
  let requests = 0;
  const reference = await createReferenceHost({ root, onInvoke: () => recordInvocation(root, 'child'),
    onRequest() { requests += 1; }, execution(session, _context, turn) {
      const execution = session.startTurn(turn);
      return { ...execution, resolveRequest(response) { recordInvocation(root, 'answer'); return execution.resolveRequest(response); } };
    },
  });
  const coordinator = await createDelegationCoordinator({ host: reference.host, store: opened.store, limits: opened.store.limits });
  try {
    const client = await coordinator.bindParent({ scope: parent });
    const settled = await client.wait({ taskId: retained.taskId, timeoutMs: 1_000 });
    assert.equal(settled.status, 'settled');
    assert.equal(settled.task.runs.items[0]?.outcome?.kind, 'recovery_required');
    assert.equal(settled.task.runs.items[0]?.pendingRequest?.state, 'unavailable');
    for (const operationId of [retained.operation.operationId, randomUUID()]) {
      await assert.rejects(coordinator.resolveRequest({
        // @ts-expect-error Persisted matching IDs are deliberately forged input, not an opaque live handle.
        handle: { taskId: retained.taskId, runId: retained.runId, requestId: retained.resolution.requestId },
        operationId, resolution: retained.resolution }), hasCode('request_unavailable'));
    }
    const operation = await opened.store.read({ kind: 'operation', parent, operationId: retained.operation.operationId });
    assert.equal(operation.kind, 'operation');
    assert.deepEqual(operation.operation, retained.operation, 'Recovery must preserve the complete exact historical receipt or unresolved intent.');
    assert.equal(operation.operation?.disposition, loss === 'before_commit' ? 'intent' : 'delivered');
    assert.equal(operation.operation?.inputDigest, expectedResolutionDigest(retained.taskId, retained.runId, retained.resolution));
    for (const id of formatThreeFixture.ids) {
      const historical = await opened.store.read({ kind: 'operation', parent, operationId: id.operationId });
      assert.equal(historical.kind, 'operation');
      assert.equal(historical.operation?.disposition, 'delivered', 'An original format-three delivered receipt retains acceptance semantics.');
      const task = await client.inspect({ taskId: id.taskId });
      assert.deepEqual(task.runs.items[0]?.outcome, { kind: 'succeeded', result: { text: 'Deterministic fake output.', truncated: false, references: [] } });
      assert.equal(task.runs.items[0]?.pendingRequest?.state, 'unavailable');
    }
    const recovered = opened.database.read((database) => rawRequestHistory(database, retained.operation.operationId, retained.runId));
    assertRetainedRequestHistory(recovered, beforeOpen);
    assert.equal(Number(recovered.state.owner_epoch), Number(beforeOpen.state.owner_epoch) + 1, 'The fresh owner advances its epoch independently of immutable history.');
    assert.notEqual(recovered.state.owner_nonce, beforeOpen.state.owner_nonce);
    assert.deepEqual(beforeOpen.pendingRun, { phase: 'running', unsettled: 1 });
    assert.deepEqual(recovered.pendingRun, { phase: 'settled', unsettled: 0 }, 'Only the interrupted live run is finalized during recovery.');
    assert.equal(requests, 0);
    assert.equal(invocationCount(root, 'child'), 1);
    assert.equal(invocationCount(root, 'answer'), 1);
    return { loss, processId: process.pid, childInvocations: invocationCount(root, 'child'), answerInvocations: invocationCount(root, 'answer'),
      disposition: operation.operation!.disposition, outcome: settled.task.runs.items[0]!.outcome };
  } finally {
    assert.equal((await coordinator.dispose({ mode: 'drain', timeoutMs: 1_000 })).status, 'closed');
    await reference.registry.dispose();
  }
}
