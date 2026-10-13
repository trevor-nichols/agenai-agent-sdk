// ------------------------------------------------------------------------------------------------
//                commit.ts - Command-specific planner snapshots and atomic domain writes
// ------------------------------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import type { DelegationLimits, DelegationStoreCommand, DelegationTaskObservation } from '@agen-ai/agent-orchestration';
import { delegationDataBytes, delegationSubordinateId, parseDelegationStoreCommand, planDelegationStoreCommit,
  type DelegationStoreCommitCurrent, type DelegationStoreRowMutation } from '@agen-ai/agent-orchestration/store-adapter';
import { readCapacity } from './capacity.js';
import type { ReferenceDatabase } from './database.js';
import { fail, sqliteFailure } from './errors.js';
import { applyMutations } from './mutations.js';
import { CRITICAL_COLUMNS, finalSlot, readCeiling, readCritical, readNotification, readOperation, readRun, readTask } from './records.js';

function currentSnapshot(database: DatabaseSync, command: DelegationStoreCommand, reference: ReferenceDatabase,
  storeId: string, limits: DelegationLimits): DelegationStoreCommitCurrent {
  const task = readTask(database, command.taskId);
  const runId = command.kind === 'admit' ? command.admission.runId : command.runId;
  const parent = command.kind === 'admit' ? command.admission.parent : task?.parent;
  const ids = database.prepare('SELECT run_id FROM delegation_runs WHERE task_id=? ORDER BY ordinal LIMIT ?').all(command.taskId, limits.maxRunsPerTask + 1);
  if (ids.length > limits.maxRunsPerTask) fail('store_failed', 'The retained task exceeds its run count bound.');
  const runs = ids.map((row) => readRun(database, String(row.run_id))!);
  const selected = runId ? finalSlot(database, runId) : undefined;
  const observed = command.kind === 'observe' ? database.prepare('SELECT data_json FROM delegation_observations WHERE run_id=? AND observation_index=?')
    .get(command.observation.runId, command.observation.index) : undefined;
  const notificationId = command.kind === 'delivery_claim' || command.kind === 'delivery_receipt' ? command.notificationId
    : runId ? delegationSubordinateId(runId, 'notification') : undefined;
  const owner = reference.currentOwner();
  const operation = parent ? readOperation(database, parent.parentId, parent.scopeId, command.operationId) : undefined;
  const notification = notificationId ? readNotification(database, notificationId) : undefined;
  const ceiling = command.kind === 'admit' ? readCeiling(database, command.admission.policyCeiling.ceilingId) : undefined;
  const observation = observed ? JSON.parse(String(observed.data_json)) as DelegationTaskObservation
    : command.kind === 'observe' && selected?.omission?.index === command.observation.index ? selected.omission : undefined;
  return {
    storeId, limits, capacity: readCapacity(database), runs, criticalOperations: runId ? readCritical(database, runId) : [],
    ...(owner ? { owner } : {}),
    ...(task ? { task } : {}),
    ...(operation ? { operation } : {}), ...(notification ? { notification } : {}), ...(ceiling ? { ceiling } : {}),
    ...(command.kind === 'admit' ? { runIdExists: database.prepare('SELECT 1 FROM delegation_runs WHERE run_id=?').get(command.admission.runId) !== undefined } : {}),
    ...(observation ? { observation } : {}), ...(selected?.omission ? { omissionObservation: selected.omission } : {}),
  };
}

function ordinaryWrite(command: DelegationStoreCommand, mutations: readonly DelegationStoreRowMutation[]): boolean {
  if (command.kind === 'admit') return true;
  if (command.kind === 'dispatch_intent') return !Object.hasOwn(CRITICAL_COLUMNS, command.operationKind);
  if (command.kind === 'request_state') return command.state === 'resolution_intended';
  return command.kind === 'observe' && mutations.some((mutation) => mutation.kind === 'observation' && mutation.value.kind !== 'omitted');
}

export function createReferenceCommit(reference: ReferenceDatabase, storeId: string, limits: DelegationLimits) {
  return (raw: DelegationStoreCommand) => {
    const command = parseDelegationStoreCommand(raw);
    try {
      // Planning and applying stay in one synchronous writer transaction. No provider callback runs here.
      return reference.domainTransaction((database) => {
        const current = currentSnapshot(database, command, reference, storeId, limits);
        const plan = planDelegationStoreCommit({ command, current });
        if (plan.mutations.length === 0) return plan.receipt;
        const capacity = plan.mutations.find((mutation) => mutation.kind === 'capacity');
        if (capacity?.kind !== 'capacity') fail('store_failed', 'A mutation plan has no capacity accounting.');
        const ordinary = ordinaryWrite(command, plan.mutations);
        // Bound allocations before touching rows; then verify actual pages before FULL commit.
        const ordinaryBytes = ordinary ? plan.mutations.reduce((bytes, mutation) => bytes + delegationDataBytes(mutation) + 4_096, 40_960) : 0;
        const assignedBytes = ordinary ? 0 : 32_768 + plan.mutations.filter((mutation) => mutation.kind === 'operation').length * 2_048;
        reference.assertCapacity(database, capacity.value, ordinaryBytes, assignedBytes);
        applyMutations(database, plan.mutations);
        reference.assertCapacity(database, capacity.value, 0, assignedBytes);
        return plan.receipt;
      });
    } catch (error) { return sqliteFailure(error); }
  };
}
