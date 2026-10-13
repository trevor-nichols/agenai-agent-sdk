// ------------------------------------------------------------------------------------------------
//                mutations.ts - Closed planner mutations into fixed run slots and indexed rows
// ------------------------------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import type { DelegationTaskRecord } from '@agen-ai/agent-orchestration';
import { delegationCanonicalJson, delegationInputDigest, delegationSubordinateId, type DelegationStoreRowMutation } from '@agen-ai/agent-orchestration/store-adapter';
import { CRITICAL_COLUMNS, encodeSlot, finalSlot, type CriticalKind, type FinalSlot } from './records.js';
import { fail } from './errors.js';

export function applyMutations(database: DatabaseSync, mutations: readonly DelegationStoreRowMutation[]): void {
  const slots = new Map<string, FinalSlot>();
  let task: DelegationTaskRecord | undefined;
  const slot = (runId: string): FinalSlot => {
    const value = slots.get(runId) ?? finalSlot(database, runId);
    if (!value) return fail('store_failed', 'The assigned final bookkeeping slot is unavailable.');
    return value;
  };
  const runMutation = mutations.find((mutation) => mutation.kind === 'run');
  if (runMutation?.kind === 'run') {
    const { input, ...run } = runMutation.value;
    const prior = finalSlot(database, run.runId);
    if (!prior) {
      const taskMutation = mutations.find((mutation) => mutation.kind === 'task');
      if (taskMutation?.kind !== 'task') fail('store_failed', 'Run admission requires its canonical task.');
      const parent = taskMutation.value.parent;
      database.prepare('INSERT INTO delegation_tasks(task_id,parent_id,scope_id,head_run_id) VALUES(?,?,?,?) ON CONFLICT(task_id) DO NOTHING')
        .run(run.taskId, parent.parentId, parent.scopeId, run.runId);
      database.prepare('INSERT INTO delegation_runs VALUES(?,?,?,?,?,?,1,zeroblob(32768),zeroblob(2048),zeroblob(2048),zeroblob(2048),zeroblob(2048))')
        .run(run.runId, run.taskId, run.ordinal, run.createdAt, run.phase, run.ownerEpoch);
      database.prepare('INSERT INTO delegation_inputs VALUES(?,?)').run(run.runId, delegationCanonicalJson(input));
      for (const kind of Object.keys(CRITICAL_COLUMNS)) database.prepare('INSERT INTO delegation_critical VALUES(?,?,?,?,NULL)')
        .run(run.runId, kind, parent.parentId, parent.scopeId);
      database.prepare("INSERT INTO delegation_notifications(notification_id,run_id,state,candidate) VALUES(?,?,'unsettled',0)")
        .run(delegationSubordinateId(run.runId, 'notification'), run.runId);
    }
    slots.set(run.runId, { ...prior, run });
    database.prepare('UPDATE delegation_runs SET phase=?,owner_epoch=?,unsettled=? WHERE run_id=?')
      .run(run.phase, run.ownerEpoch, run.phase === 'settled' ? 0 : 1, run.runId);
  }
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'task': task = mutation.value; break;
      case 'run': break;
      case 'capacity': database.prepare('UPDATE delegation_state SET capacity_json=? WHERE singleton=1').run(delegationCanonicalJson(mutation.value)); break;
      case 'ceiling': {
        const value = mutation.value;
        database.prepare('INSERT INTO delegation_ceilings VALUES(?,?,?)').run(value.ceilingId, delegationCanonicalJson(value.origin), delegationCanonicalJson(value));
        for (const target of value.targets) database.prepare('INSERT INTO delegation_ceiling_targets VALUES(?,?,?)')
          .run(value.ceilingId, delegationInputDigest(target), delegationCanonicalJson(target));
        break;
      }
      case 'operation': {
        const value = mutation.value;
        if (Object.hasOwn(CRITICAL_COLUMNS, value.kind)) {
          const column = CRITICAL_COLUMNS[value.kind as CriticalKind];
          database.prepare(`UPDATE delegation_runs SET ${column}=? WHERE run_id=?`).run(encodeSlot(value, 2_048), value.runId);
          database.prepare('UPDATE delegation_critical SET operation_id=? WHERE run_id=? AND kind=?').run(value.operationId, value.runId, value.kind);
        } else database.prepare('INSERT INTO delegation_operations VALUES(?,?,?,?,?) ON CONFLICT(parent_id,scope_id,operation_id) DO UPDATE SET data_blob=excluded.data_blob')
          .run(value.parent.parentId, value.parent.scopeId, value.operationId, value.runId, encodeSlot(value, 2_048));
        break;
      }
      case 'observation': {
        const value = mutation.value;
        if (value.kind === 'omitted') slots.set(value.runId, { ...slot(value.runId), omission: value });
        else database.prepare('INSERT INTO delegation_observations VALUES(?,?,?)').run(value.runId, value.index, delegationCanonicalJson(value));
        break;
      }
      case 'notification': {
        const value = mutation.value;
        const runId = value.envelope.runId;
        slots.set(runId, { ...slot(runId), notification: value });
        database.prepare('UPDATE delegation_notifications SET state=?,owner_epoch=?,retry_at=?,expires_at=?,candidate=? WHERE notification_id=?')
          .run(value.state, value.claim?.ownerEpoch ?? null, value.retryAt ?? null, value.envelope.expiresAt,
            value.state === 'pending' || value.state === 'claimed' ? 1 : 0, value.envelope.notificationId);
        break;
      }
    }
  }
  if (task) {
    const retained = database.prepare('SELECT head_run_id FROM delegation_tasks WHERE task_id=?').get(task.taskId);
    const head = runMutation?.kind === 'run' ? runMutation.value.runId : String(retained?.head_run_id);
    slots.set(head, { ...slot(head), task });
    database.prepare('UPDATE delegation_tasks SET head_run_id=? WHERE task_id=?').run(head, task.taskId);
  }
  for (const [runId, value] of slots) database.prepare('UPDATE delegation_runs SET final_blob=? WHERE run_id=?').run(encodeSlot(value, 32_768), runId);
}
