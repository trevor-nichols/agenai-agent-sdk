import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { Engine } from '../../../engine.mjs';
import { acquireJsonInput } from '../input.mjs';
import { appendObservation, failure, json, jsonWriter } from '../live/evidence.mjs';
import { settleOwnerCleanup } from '../live/owner-cleanup.mjs';
import { backend } from '../network/installed.mjs';
import { census } from '../network/resources.mjs';
import { workflow } from './installed.mjs';

const [, path] = process.argv.slice(2); assert.equal(process.argv.length, 4);
const { value: config } = await acquireJsonInput(path, 256 * 1024);
assert.equal(config.format, 'agenai.sandbox-platform-combined-controller.v1');
assert(['crash', 'cleanup'].includes(config.child.mode)); assert.equal(process.argv[2], 'start');
assert(fileURLToPath(import.meta.url).startsWith(`${config.consumer}/qualification/`));
assert(config.child.namespace.startsWith(config.namespacePrefix)); assert.match(config.child.challenge, /^[a-f0-9-]{36}$/u);
await mkdir(config.output, { recursive: true, mode: 0o700 });
const result = { format: 'agenai.sandbox-platform-combined-child.v1', status: 'running', pid: process.pid,
  challenge: config.child.challenge, mode: config.child.mode, cut: config.child.cut,
  startedAt: new Date().toISOString(), owners: [], observations: [], cleanupErrors: [] };
const writer = jsonWriter(config.child.resultPath);
const save = () => { assert(Buffer.byteLength(json(result)) <= 4 * 1024 ** 2); return writer(result); };
const engine = new Engine(config.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs, outputBytes: 4 * 1024 ** 2 });
const run = { directory: config.output, hostDirectory: config.output, evidence: result, owners: [], save,
  observe: (value) => appendObservation(result, value, save) };
const context = { config, engine, fixtures: { targets: () => ({ host: config.child.target }) } };
let recovering;
const settle = (owner) => settleOwnerCleanup(owner, 'destroy', { cleanupMs: config.capabilities.limits.cleanupMs,
  observe: (observation) => run.observe(observation) });
async function cut(entry, witness) {
  assert.equal(result.cutWitness, undefined, 'The original child may acknowledge one cut only.');
  result.cutWitness = witness; result.originalRecord = entry.owner.recoveryRecord;
  await jsonWriter(config.child.originalPath)(result.originalRecord); await save();
  process.stdout.write(JSON.stringify({ phase: 'ready', pid: process.pid, challenge: config.child.challenge, cut: config.child.cut }) + '\n');
  await new Promise(() => {});
}
try {
  await save();
  if (config.child.mode === 'cleanup') {
    const bytes = await readFile(config.child.originalPath); assert(bytes.length <= 256 * 1024);
    const record = parseSandboxRecoveryRecord(JSON.parse(bytes.toString('utf8')));
    assert.equal(record.namespace, config.child.namespace); result.originalRecord = record;
    const selected = await backend(config, { namespace: config.child.namespace, directory: config.child.scratchDirectory, filesystem: true });
    const reconciled = await selected.backend.reconcile(record); result.reconciliation = reconciled.kind;
    if (reconciled.kind === 'absent') result.finalRecord = reconciled.record;
    else {
      assert(['matched', 'uncertain'].includes(reconciled.kind), JSON.stringify(reconciled)); recovering = reconciled.owner;
      for (const name of ['start', 'reserveProcess', 'importTree', 'exportTree', 'files']) assert.equal(typeof recovering[name], 'undefined');
      await settle(recovering); await settle(recovering); result.finalRecord = recovering.recoveryRecord;
      assert.equal(result.finalRecord.phase, 'destroyed');
    }
    result.finalCensus = await census(engine, record, 'fresh-original-combined-checkpoint-absence', true);
    result.cleanupKind = 'fresh-process-cleanup-only'; result.status = 'passed';
  } else {
    const phases = { 'network-ready': 'started', 'entered-live-write': 'cancel_write_entered',
      'process-active': 'program_verified', 'stop-entered': 'stop_entered' };
    await workflow(run, context, { namespace: config.child.namespace, directory: config.child.ownerDirectory,
      scratchDirectory: config.child.scratchDirectory,
      mode: ['entered-live-write', 'stop-entered'].includes(config.child.cut) ? 'cancel' : 'normal',
      async onObservation(observation, entry) {
        if (phases[config.child.cut] === observation.phase) await cut(entry, { kind: 'public-workflow-audit', observation });
      } });
    throw new Error('The selected combined crash cut was never entered.');
  }
} catch (error) {
  result.status = 'failed'; result.failure = failure(error);
  for (const entry of run.owners) if (entry.owner) {
    try { await settle(entry.owner); } catch (cleanup) { result.cleanupErrors.push(failure(cleanup)); }
    result.finalRecord = entry.owner.recoveryRecord;
  }
  if (recovering) try { await settle(recovering); result.finalRecord = recovering.recoveryRecord; }
  catch (cleanup) { result.cleanupErrors.push(failure(cleanup)); }
  process.exitCode = 1;
} finally { result.finishedAt = new Date().toISOString(); await save(); }
process.stdout.write(JSON.stringify({ phase: 'complete', pid: process.pid, status: result.status }) + '\n');
