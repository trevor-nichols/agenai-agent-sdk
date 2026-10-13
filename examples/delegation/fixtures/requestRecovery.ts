// ------------------------------------------------------------------------------------------------
//                requestRecovery.ts - Accepted answers across failed durable receipt acknowledgement
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentRequestResolution } from '@agen-ai/agent-protocol';
import { createDelegationCoordinator, type DelegationHostRequest, type DelegationOperationRecord } from '@agen-ai/agent-orchestration';
import { openSqliteDelegationStore } from '../sqlite/index.js';
import { createReferenceHost, input, parent } from './host.js';
import { barrier, invocationCount, persistJson, readJson, recordInvocation } from './journal.js';
import { hasCode, withCommit } from './store.js';

export type RequestReceiptLoss = 'before_commit' | 'after_commit';

interface RetainedRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly operation: DelegationOperationRecord;
  readonly resolution: AgentRequestResolution;
}

export async function failRequestReceipt(root: string, loss: RequestReceiptLoss) {
  const opened = openSqliteDelegationStore({ root: join(root, 'database') });
  let offerRequest!: (request: DelegationHostRequest) => void;
  const requested = new Promise<DelegationHostRequest>((resolve) => { offerRequest = resolve; });
  const operationId = randomUUID();
  let receiptWrites = 0;
  const reference = await createReferenceHost({ root, onInvoke: () => recordInvocation(root, 'child'),
    onRequest: offerRequest,
    execution(session, _context, turn) {
      const execution = session.startTurn(turn);
      return { ...execution,
        outputs: (async function* () {
          for await (const output of execution.outputs) {
            if (output.kind === 'event' && output.event.type === 'turn.completed') await new Promise<void>(() => {});
            yield output;
          }
        })(),
        async resolveRequest(response) {
          recordInvocation(root, 'answer');
          const result = await execution.resolveRequest(response);
          assert.equal(result.status, 'delivered');
          return result;
        },
      };
    },
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
  const resolution: AgentRequestResolution = { requestKind: 'approval', requestId: request.request.requestId,
    disposition: 'selected', optionId: request.request.options[0]!.optionId };
  await assert.rejects(coordinator.resolveRequest({ handle: request.handle, operationId, resolution }), hasCode('store_failed'));
  assert.equal(receiptWrites, 1);
  assert.equal(invocationCount(root, 'child'), 1);
  assert.equal(invocationCount(root, 'answer'), 1);
  const retained = await opened.store.read({ kind: 'operation', parent, operationId });
  assert.equal(retained.kind, 'operation');
  assert.ok(retained.operation);
  assert.equal(retained.operation.disposition, loss === 'before_commit' ? 'intent' : 'delivered');
  assert.deepEqual(retained.operation.request, { requestId: resolution.requestId, requestKind: 'approval' });
  persistJson(root, 'request-receipt.json', { taskId: admitted.taskId, runId: admitted.runId, operation: retained.operation, resolution } satisfies RetainedRequest);
  await barrier('crash', { loss, receiptWrites, disposition: retained.operation.disposition });
  throw new Error('Request receipt recovery qualification requires SIGKILL.');
}

export async function recoverRequestReceipt(root: string, loss: RequestReceiptLoss) {
  const retained = readJson<RetainedRequest>(root, 'request-receipt.json');
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
    await assert.rejects(coordinator.resolveRequest({ handle: {} as never, operationId: retained.operation.operationId,
      resolution: retained.resolution }), hasCode('request_unavailable'));
    const operation = await opened.store.read({ kind: 'operation', parent, operationId: retained.operation.operationId });
    assert.equal(operation.kind, 'operation');
    assert.deepEqual(operation.operation, retained.operation, 'Recovery must preserve the complete exact historical receipt or unresolved intent.');
    assert.equal(operation.operation?.disposition, loss === 'before_commit' ? 'intent' : 'delivered');
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
