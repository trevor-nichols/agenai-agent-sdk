import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  parseDelegationCompletionEnvelope, parseDelegationNotificationRecord, parseDelegationRunRecord,
  parseDelegationTaskRecord, parseDelegationTaskObservation, type DelegationRunRecord, type DelegationCompletionEnvelope, type DelegationNotificationRecord, type DelegationTaskRecord, type DelegationRunSummary, type DelegationTaskObservation,
} from '@agen-ai/agent-orchestration';
import { delegationCanonicalJson, delegationInputDigest } from '@agen-ai/agent-orchestration/store-adapter';
import { assertPhysicalCapacity } from '../capacity.js';
import { fail } from '../errors.js';
import { CRITICAL_COLUMNS, encodeSlot } from '../records.js';
import { tables } from '../layout.js';
import { copyBoundedDelegationData } from './legacy/data.js';
import { parseDelegationLimits } from './legacy/limits.js';
import { CapacitySchema, FinalSlotSchema, OperationSchema, StateSchema, parseLegacyCeiling, parseLegacyRun } from './legacy/records.js';
import { AtSchema, CompletionEnvelopeSchema, ObservationSchema, StoreIdSchema, TargetReferenceSchema } from './legacy/schemas.js';
import * as formatTwo from './formatTwo.js';

const CurrentOperationSchema = OperationSchema.extend({
  request: formatTwo.HistoricalRequestSchema.pick({ requestId: true, requestKind: true }).optional(),
  requestState: z.enum(['pending', 'unavailable']).optional(),
}).superRefine((operation, context) => {
  if (operation.request !== undefined && operation.kind !== 'request_resolution') {
    context.addIssue({ code: 'custom', path: ['request'], message: 'Only request operations retain answer identity.' });
  }
  const rejectedAnswer = operation.kind === 'request_resolution' && operation.disposition === 'rejected';
  if ((operation.requestState !== undefined && !rejectedAnswer)
    || (operation.request !== undefined && rejectedAnswer && operation.requestState === undefined)) {
    context.addIssue({ code: 'custom', path: ['requestState'], message: 'Current rejected request operations require exact callback availability.' });
  }
});

const parseOperation = (value: unknown, version: 1 | 2 | 3) =>
  version === 3 ? CurrentOperationSchema.parse(value) : OperationSchema.parse(value);

type LegacySlot = ReturnType<typeof FinalSlotSchema.parse>;
type LegacyRun = ReturnType<typeof parseLegacyRun>;
type LegacyEnvelope = ReturnType<typeof CompletionEnvelopeSchema.parse>;
type InspectedRun = LegacyRun | ReturnType<typeof formatTwo.parseFormatTwoRun> | DelegationRunRecord;
type InspectedEnvelope = LegacyEnvelope | ReturnType<typeof formatTwo.CompletionEnvelopeSchema.parse> | DelegationCompletionEnvelope;
interface CurrentSlot {
  readonly run: DelegationRunSummary;
  readonly task?: DelegationTaskRecord;
  readonly notification?: DelegationNotificationRecord;
  readonly omission?: DelegationTaskObservation;
}
type InspectedSlot = LegacySlot | ReturnType<typeof formatTwo.FinalSlotSchema.parse> | CurrentSlot;
export interface MigrationRows {
  readonly storeId: string;
  readonly runs: readonly Readonly<{ runId: string; blob: Buffer }>[];
  readonly inbox: readonly Readonly<{ inboxId: string; envelope: string; digest: string }>[];
  readonly writeBytes: number;
}
function invalid(record: string, message: string): never { return fail('store_failed', `SQLite format migration: ${record}: ${message}`); }
function same(left: unknown, right: unknown): boolean { return delegationCanonicalJson(left) === delegationCanonicalJson(right); }
function json(value: SQLOutputValue | undefined, record: string): unknown {
  if (typeof value !== 'string') return invalid(record, 'expected encoded JSON.');
  return copyBoundedDelegationData(JSON.parse(value));
}
function slot(value: SQLOutputValue | undefined, bytes: number, record: string): unknown {
  if (!(value instanceof Uint8Array) || value.byteLength !== bytes) return invalid(record, 'invalid fixed slot size.');
  const buffer = Buffer.from(value);
  if (buffer[0] === 0) {
    if (buffer.some((byte) => byte !== 0)) return invalid(record, 'invalid empty fixed slot.');
    return undefined;
  }
  return copyBoundedDelegationData(JSON.parse(buffer.toString('utf8')));
}
function transformOutcome(outcome: LegacyRun['outcome']) {
  return outcome?.kind === 'failed' ? { kind: 'failed' as const,
    error: { ...outcome.error, category: 'unknown' as const, recovery: { kind: 'unknown' as const } } } : outcome;
}
function transformEnvelope(envelope: LegacyEnvelope) { return { ...envelope, outcome: transformOutcome(envelope.outcome)! }; }
function currentSlot(value: unknown, input: unknown): Readonly<{ slot: CurrentSlot; run: DelegationRunRecord }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['run', 'task', 'notification', 'omission'].includes(key))) {
    return invalid('final slot', 'invalid target final slot fields.');
  }
  const data = value as Record<string, unknown>;
  if (!data.run || typeof data.run !== 'object' || Array.isArray(data.run) || Object.hasOwn(data.run, 'input')) {
    return invalid('final slot', 'a run summary requires one external input.');
  }
  const run = parseDelegationRunRecord({ ...data.run, input });
  const { input: _input, ...summary } = run;
  return { slot: { run: summary,
    ...(data.task === undefined ? {} : { task: parseDelegationTaskRecord(data.task) }),
    ...(data.notification === undefined ? {} : { notification: parseDelegationNotificationRecord(data.notification) }),
    ...(data.omission === undefined ? {} : { omission: parseDelegationTaskObservation(data.omission) }) }, run };
}

/** Validates every retained record and task/inbox pair; source decoding never uses current parsers. */
export function inspectMigrationRecords(database: DatabaseSync, version: 1 | 2 | 3, hasInbox: boolean, transform = false): MigrationRows {
  if (database.prepare('PRAGMA integrity_check').all().some((row) => row.integrity_check !== 'ok')
    || database.prepare('PRAGMA foreign_key_check').all().length !== 0) invalid('database', 'integrity or foreign-key check failed.');
  const states = database.prepare('SELECT * FROM delegation_state').all();
  if (states.length !== 1) invalid('header', 'expected exactly one state row.');
  const state = StateSchema.parse(states[0]);
  const limits = parseDelegationLimits(json(state.limits_json, 'limits'));
  if (!same(limits, JSON.parse(state.limits_json))) invalid('limits', 'the retained limit record is incomplete.');
  const capacity = CapacitySchema.parse(json(state.capacity_json, 'capacity'));
  if (version < 3 && (capacity.activeRuns !== 0 || capacity.queuedRuns !== 0)) invalid('capacity', 'live run reservations require the matched old owner before migration.');
  const tasks = new Map(database.prepare('SELECT * FROM delegation_tasks').all().map((row) => [String(row.task_id), row]));
  const runs = new Map<string, InspectedRun>();
  const finals = new Map<string, InspectedSlot>();
  const notifications = new Map<string, InspectedEnvelope>();
  const transformedRuns: { runId: string; blob: Buffer }[] = [];
  const transformedInbox: { inboxId: string; envelope: string; digest: string }[] = [];
  let inputBytes = 0;
  for (const row of database.prepare('SELECT * FROM delegation_runs ORDER BY run_id').iterate()) {
    const id = String(row.run_id);
    try {
      const encodedInput = database.prepare('SELECT input_json FROM delegation_inputs WHERE run_id=?').get(id);
      const input = json(encodedInput?.input_json, `run ${id} input`);
      const raw = slot(row.final_blob, 32_768, `run ${id}`);
      const decoded = version === 1 ? FinalSlotSchema.parse(raw)
        : version === 2 ? formatTwo.FinalSlotSchema.parse(raw) : currentSlot(raw, input).slot;
      const run = version === 1 ? parseLegacyRun(decoded.run, input)
        : version === 2 ? formatTwo.parseFormatTwoRun(decoded.run, input) : currentSlot(raw, input).run;
      const task = tasks.get(run.taskId);
      if (!task || row.task_id !== run.taskId || row.run_id !== run.runId || row.ordinal !== run.ordinal
        || row.created_at !== run.createdAt || row.phase !== run.phase || row.owner_epoch !== run.ownerEpoch
        || row.unsettled !== (run.phase === 'settled' ? 0 : 1) || run.ownerEpoch > state.owner_epoch) invalid(`run ${id}`, 'indexed identity or state differs from its final slot.');
      if (version < 3 && run.phase !== 'settled') invalid(`run ${id}`, 'non-settled runs require the matched old owner to settle or retire them before migration.');
      if (version === 2 && run.pendingRequest && ['waiting', 'resolution_intended'].includes(run.pendingRequest.state)) {
        invalid(`run ${id}`, 'live request authority requires the matched old owner to settle or retire it before migration.');
      }
      if (decoded.task && (decoded.task.taskId !== run.taskId || decoded.task.storeId !== state.store_id
        || decoded.task.parent.parentId !== task.parent_id || decoded.task.parent.scopeId !== task.scope_id)) invalid(`run ${id}`, 'task scope differs from its indexed identity.');
      if (task.head_run_id === id && (!decoded.task || decoded.task.latestRunId !== id)) invalid(`task ${run.taskId}`, 'canonical task head is unavailable.');
      if (decoded.omission && (decoded.omission.runId !== id || decoded.omission.taskId !== run.taskId || decoded.omission.storeId !== state.store_id)) invalid(`run ${id}`, 'omission identity differs.');
      const notificationRow = database.prepare('SELECT * FROM delegation_notifications WHERE run_id=?').get(id);
      const notification = decoded.notification;
      if (!notificationRow) invalid(`run ${id}`, 'notification reservation is missing.');
      if (notification) {
        const envelope = notification.envelope;
        if (notificationRow.notification_id !== envelope.notificationId || envelope.storeId !== state.store_id
          || envelope.runId !== id || envelope.taskId !== run.taskId || !same(envelope.outcome, run.outcome)
          || envelope.settledAt !== run.settledAt || envelope.parent.parentId !== task.parent_id || envelope.parent.scopeId !== task.scope_id
          || notificationRow.state !== notification.state || notificationRow.owner_epoch !== (notification.claim?.ownerEpoch ?? null)
          || notificationRow.retry_at !== (notification.retryAt ?? null) || notificationRow.expires_at !== envelope.expiresAt
          || notificationRow.candidate !== (['pending', 'claimed'].includes(notification.state) ? 1 : 0)) invalid(`notification ${envelope.notificationId}`, 'paired run, envelope or indexed notification differs.');
        if (version < 3 && notification.state === 'claimed') invalid(`notification ${envelope.notificationId}`, 'claimed notifications require the matched old owner to resolve them before migration.');
        notifications.set(envelope.notificationId, envelope);
      } else if (run.phase === 'settled' || notificationRow.state !== 'unsettled') invalid(`run ${id}`, 'canonical notification is missing.');
      if (transform) {
        const legacy = FinalSlotSchema.parse(raw);
        const legacyRun = parseLegacyRun(legacy.run, input);
        const changed = { ...legacy, run: { ...(legacy.run as object), outcome: transformOutcome(legacyRun.outcome) },
          ...(legacy.notification ? { notification: { ...legacy.notification, envelope: transformEnvelope(legacy.notification.envelope) } } : {}) };
        // Bounds include the richer failure; a committed legacy message must never be shortened.
        const target = formatTwo.FinalSlotSchema.parse(changed);
        formatTwo.parseFormatTwoRun(target.run, input);
        transformedRuns.push({ runId: id, blob: encodeSlot(changed, 32_768) });
      }
      for (const [kind, column] of Object.entries(CRITICAL_COLUMNS)) {
        const record = slot(row[column], 2_048, `run ${id} ${kind}`);
        const index = database.prepare('SELECT * FROM delegation_critical WHERE run_id=? AND kind=?').get(id, kind);
        if (!index || index.parent_id !== task.parent_id || index.scope_id !== task.scope_id) invalid(`run ${id}`, 'critical reservation is missing or mis-scoped.');
        if (record) {
          const operation = parseOperation(record, version);
          if (operation.runId !== id || operation.taskId !== run.taskId || operation.kind !== kind || index.operation_id !== operation.operationId) invalid(`run ${id}`, 'critical operation differs from its reservation.');
        } else if (index.operation_id !== null) invalid(`run ${id}`, 'empty critical slot has an operation identity.');
      }
      inputBytes += Buffer.byteLength(String(encodedInput!.input_json));
      runs.set(id, run); finals.set(id, decoded);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SQLite format migration:')) throw error;
      invalid(`run ${id}`, `${transform ? 'target format 2 preflight' : `format ${version} validation`} failed: ${error instanceof Error ? error.message.slice(0, 500) : 'invalid data'}`);
    }
  }
  for (const [taskId, task] of tasks) {
    const head = finals.get(String(task.head_run_id))?.task;
    const children = [...runs.values()].filter((run) => run.taskId === taskId);
    if (!head || children.length !== head.runCount || children.length > limits.maxRunsPerTask
      || children.some((run, index) => !children.some((candidate) => candidate.ordinal === index + 1))) invalid(`task ${taskId}`, 'run count, ordinal sequence or head is invalid.');
  }
  let ordinaryOperations = 0;
  for (const row of database.prepare('SELECT * FROM delegation_operations').iterate()) {
    const operation = parseOperation(slot(row.data_blob, 2_048, `operation ${row.operation_id}`), version);
    const run = runs.get(operation.runId);
    if (!run || row.operation_id !== operation.operationId || row.run_id !== operation.runId || operation.taskId !== run.taskId
      || row.parent_id !== operation.parent.parentId || row.scope_id !== operation.parent.scopeId
      || operation.receipt.taskId !== operation.taskId || (operation.receipt.runId !== undefined && operation.receipt.runId !== operation.runId)) invalid(`operation ${row.operation_id}`, 'operation identity or historical receipt differs.');
    if (version === 2 && operation.kind === 'request_resolution' && ['intent', 'delegated'].includes(operation.disposition)) {
      invalid(`operation ${operation.operationId}`, 'outstanding request intents require the matched old owner to settle or retire them before migration.');
    }
    ordinaryOperations += 1;
  }
  let observationBytes = 0;
  for (const row of database.prepare('SELECT * FROM delegation_observations').iterate()) {
    const observation = ObservationSchema.parse(json(row.data_json, 'observation'));
    if (!runs.has(observation.runId) || row.run_id !== observation.runId || row.observation_index !== observation.index || observation.storeId !== state.store_id) invalid('observation', 'indexed identity differs.');
    observationBytes += Buffer.byteLength(String(row.data_json));
  }
  const ceilings = new Map<string, ReturnType<typeof parseLegacyCeiling>>();
  for (const row of database.prepare('SELECT * FROM delegation_ceilings').iterate()) {
    const ceiling = parseLegacyCeiling(json(row.data_json, 'ceiling'));
    if (row.ceiling_id !== ceiling.ceilingId || !same(json(row.origin_json, 'ceiling origin'), ceiling.origin)) invalid('ceiling', 'indexed ceiling differs.');
    ceilings.set(ceiling.ceilingId, ceiling);
    inputBytes += Buffer.byteLength(String(row.data_json));
    const targets = database.prepare('SELECT * FROM delegation_ceiling_targets WHERE ceiling_id=?').all(ceiling.ceilingId);
    if (targets.length !== ceiling.targets.length) invalid('ceiling', 'target inventory differs.');
    for (const target of targets) {
      const reference = TargetReferenceSchema.parse(json(target.data_json, 'ceiling target'));
      if (target.target_key !== delegationInputDigest(reference) || !ceiling.targets.some((value) => same(value, reference))) invalid('ceiling', 'target digest differs.');
    }
  }
  for (const final of finals.values()) if (final.task && !ceilings.has(final.task.policyCeilingRef)) invalid('task', 'policy ceiling is missing.');
  if (hasInbox) for (const row of database.prepare('SELECT * FROM delegation_parent_inbox ORDER BY inbox_id').iterate()) {
    const envelope = version === 1 ? CompletionEnvelopeSchema.parse(json(row.envelope, 'inbox envelope'))
      : version === 2 ? formatTwo.CompletionEnvelopeSchema.parse(json(row.envelope, 'inbox envelope'))
        : parseDelegationCompletionEnvelope(json(row.envelope, 'inbox envelope'));
    if (row.store_id !== state.store_id || row.notification_id !== envelope.notificationId || row.parent_key !== JSON.stringify([envelope.parent.parentId, envelope.parent.scopeId])
      || row.parent_revision !== envelope.parent.revision || row.policy !== envelope.policy || envelope.policy === 'collect'
      || !same(notifications.get(envelope.notificationId), envelope) || row.envelope_digest !== delegationInputDigest(envelope)
      || typeof row.inbox_id !== 'string' || row.inbox_id.length === 0 || !AtSchema.safeParse(row.accepted_at).success
      || !['pending', 'dispatch_intended', 'acknowledged', 'recovery_required', 'dismissed'].includes(String(row.state))
      || Buffer.byteLength(String(row.envelope)) > 12_288) invalid(`inbox ${row.inbox_id}`, 'paired task/envelope, digest or retained identity differs.');
    if (version < 3 && row.state === 'dispatch_intended') invalid(`inbox ${row.inbox_id}`, 'dispatch-intended inbox entries require the matched old owner to resolve them before migration.');
    for (const field of ['dispatched_at', 'settled_at']) if (row[field] !== null) AtSchema.parse(row[field]);
    if (row.dispatch_id !== null) StoreIdSchema.parse(row.dispatch_id);
    if (row.reason !== null && (typeof row.reason !== 'string' || Buffer.byteLength(row.reason) > 256)) invalid('inbox', 'invalid reason.');
    if (transform) {
      const changed = formatTwo.CompletionEnvelopeSchema.parse(transformEnvelope(CompletionEnvelopeSchema.parse(json(row.envelope, 'inbox envelope'))));
      transformedInbox.push({ inboxId: String(row.inbox_id), envelope: delegationCanonicalJson(changed), digest: delegationInputDigest(changed) });
    }
  }
  if (capacity.tasks !== tasks.size || capacity.runs !== runs.size || capacity.ordinaryOperations !== ordinaryOperations
    || capacity.retainedInputBytes !== inputBytes || capacity.observationBytes !== observationBytes || capacity.criticalSlots !== runs.size * 4
    || capacity.reservedBytes !== runs.size * 40_960 || tasks.size > limits.maxTasks || runs.size > limits.maxRuns
    || ordinaryOperations > limits.maxOrdinaryOperations) invalid('capacity', 'retained row accounting differs.');
  for (const [table, expected] of [['delegation_inputs', runs.size], ['delegation_notifications', runs.size], ['delegation_critical', runs.size * 4]] as const) {
    if (database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count !== expected) invalid(table, 'row inventory differs.');
  }
  return { storeId: state.store_id, runs: transformedRuns, inbox: transformedInbox,
    writeBytes: transformedRuns.length * 32_768 + transformedInbox.reduce((sum, row) => sum + Buffer.byteLength(row.envelope) + 4_096, 0) };
}

/** Digest of exact SQL definitions and typed row values, including padded blob bytes; independent of page layout. */
export function migrationContentDigest(database: DatabaseSync, hasInbox: boolean): string {
  const hash = createHash('sha256');
  const inventory = [...Object.keys(tables), ...(hasInbox ? ['delegation_parent_inbox'] : [])].sort();
  for (const table of inventory) {
    hash.update(delegationCanonicalJson(database.prepare('SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=? ORDER BY type,name').all(table)));
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    const order = columns.map((column) => String(column.name)).join(',');
    for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      hash.update(delegationCanonicalJson(Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        value instanceof Uint8Array ? { sqliteBlobBase64: Buffer.from(value).toString('base64') } : value]))));
    }
  }
  return hash.digest('hex');
}
export function preflightMigrationCapacity(database: DatabaseSync, root: string, rows: MigrationRows): void {
  const capacity = CapacitySchema.parse(json(database.prepare('SELECT capacity_json FROM delegation_state').get()?.capacity_json, 'capacity'));
  assertPhysicalCapacity(database, root, capacity, rows.writeBytes, 0);
}
