// Shared exact physical layout of task database formats 1 and 2.
export const APPLICATION_ID = 0x41474454;

export const tables = {
  delegation_state: 'CREATE TABLE delegation_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL, owner_nonce TEXT, limits_json TEXT NOT NULL, capacity_json TEXT NOT NULL) STRICT',
  delegation_tasks: 'CREATE TABLE delegation_tasks (task_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, scope_id TEXT NOT NULL, head_run_id TEXT NOT NULL REFERENCES delegation_runs(run_id) DEFERRABLE INITIALLY DEFERRED) STRICT',
  delegation_runs: 'CREATE TABLE delegation_runs (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES delegation_tasks(task_id) DEFERRABLE INITIALLY DEFERRED, ordinal INTEGER NOT NULL, created_at TEXT NOT NULL, phase TEXT NOT NULL, owner_epoch INTEGER NOT NULL, unsettled INTEGER NOT NULL, final_blob BLOB NOT NULL CHECK(length(final_blob)=32768), cancel_blob BLOB NOT NULL CHECK(length(cancel_blob)=2048), interrupt_blob BLOB NOT NULL CHECK(length(interrupt_blob)=2048), session_close_blob BLOB NOT NULL CHECK(length(session_close_blob)=2048), binding_cleanup_blob BLOB NOT NULL CHECK(length(binding_cleanup_blob)=2048), UNIQUE(task_id,ordinal)) STRICT',
  delegation_inputs: 'CREATE TABLE delegation_inputs (run_id TEXT PRIMARY KEY REFERENCES delegation_runs(run_id), input_json TEXT NOT NULL) STRICT',
  delegation_operations: 'CREATE TABLE delegation_operations (parent_id TEXT NOT NULL, scope_id TEXT NOT NULL, operation_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES delegation_runs(run_id), data_blob BLOB NOT NULL CHECK(length(data_blob)=2048), PRIMARY KEY(parent_id,scope_id,operation_id)) STRICT',
  delegation_critical: 'CREATE TABLE delegation_critical (run_id TEXT NOT NULL REFERENCES delegation_runs(run_id), kind TEXT NOT NULL, parent_id TEXT NOT NULL, scope_id TEXT NOT NULL, operation_id TEXT, PRIMARY KEY(run_id,kind), UNIQUE(parent_id,scope_id,operation_id)) STRICT',
  delegation_observations: 'CREATE TABLE delegation_observations (run_id TEXT NOT NULL REFERENCES delegation_runs(run_id), observation_index INTEGER NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(run_id,observation_index)) STRICT',
  delegation_notifications: 'CREATE TABLE delegation_notifications (notification_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES delegation_runs(run_id), state TEXT NOT NULL, owner_epoch INTEGER, retry_at TEXT, expires_at TEXT, candidate INTEGER NOT NULL) STRICT',
  delegation_ceilings: 'CREATE TABLE delegation_ceilings (ceiling_id TEXT PRIMARY KEY, origin_json TEXT NOT NULL, data_json TEXT NOT NULL) STRICT',
  delegation_ceiling_targets: 'CREATE TABLE delegation_ceiling_targets (ceiling_id TEXT NOT NULL REFERENCES delegation_ceilings(ceiling_id), target_key TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(ceiling_id,target_key)) STRICT',
} as const;
export const indexes = [
  'CREATE INDEX delegation_run_queue ON delegation_runs(phase,created_at,run_id)',
  'CREATE INDEX delegation_run_recovery ON delegation_runs(unsettled,created_at,run_id,owner_epoch)',
  'CREATE INDEX delegation_operation_run ON delegation_operations(run_id,operation_id)',
  'CREATE INDEX delegation_notification_candidates ON delegation_notifications(candidate,notification_id,owner_epoch)',
] as const;
