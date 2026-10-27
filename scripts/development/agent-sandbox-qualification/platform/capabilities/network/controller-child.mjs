import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxStateError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { Engine, until } from '../../../engine.mjs';
import { acquireJsonInput } from '../input.mjs';
import { appendObservation, failure, json, jsonWriter } from '../live/evidence.mjs';
import { settleOwnerCleanup } from '../live/owner-cleanup.mjs';
import { backend, positive, ready } from './installed.mjs';
import { census } from './resources.mjs';

const [, path] = process.argv.slice(2); assert.equal(process.argv.length, 4);
const { value: config } = await acquireJsonInput(path, 256 * 1024);
assert.equal(config.format, 'agenai.sandbox-platform-network-controller.v1');
assert.deepEqual(Object.keys(config.child).sort(), ['mode', 'namespace', 'challenge', 'originalPath', 'resultPath'].sort());
assert(['lease', 'crash', 'cleanup'].includes(config.child.mode));
assert.equal(process.argv[2], config.child.mode === 'lease' ? 'lease' : 'start');
assert(fileURLToPath(import.meta.url).startsWith(`${config.consumer}/qualification/`));
for (const name of ['@agen-ai/sandbox', '@agen-ai/sandbox-docker', '@agen-ai/sandbox-docker/node']) {
  assert(fileURLToPath(import.meta.resolve(name)).startsWith(`${config.consumer}/node_modules/`));
}
assert(config.child.namespace.startsWith(config.namespacePrefix)); assert.match(config.child.challenge, /^[a-f0-9-]{36}$/u);
await mkdir(config.output, { recursive: true, mode: 0o700 });
const result = { format: 'agenai.sandbox-platform-network-child.v1', status: 'running', mode: config.child.mode,
  pid: process.pid, challenge: config.child.challenge, startedAt: new Date().toISOString(), owners: [], observations: [],
  cleanupErrors: [], continueCount: 0, cleanupKind: null };
const write = jsonWriter(config.child.resultPath); const save = () => { assert(Buffer.byteLength(json(result)) <= 2 * 1024 ** 2); return write(result); };
const resumed = Promise.withResolvers();
const continued = () => { result.continueCount++; result.continuedAt = new Date().toISOString(); resumed.resolve(); };
process.on('SIGCONT', continued); result.resumeListenerInstalledAt = new Date().toISOString();
const engine = new Engine(config.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs, outputBytes: 4 * 1024 ** 2 });
const run = { directory: config.output, evidence: result, owners: [], sessions: [], save,
  observe: (value) => appendObservation(result, value, save) };
const settle = (owner, operation) => settleOwnerCleanup(owner, operation, { cleanupMs: config.capabilities.limits.cleanupMs,
  observe: (value) => run.observe(value) });
let owner;
try {
  await save();
  if (config.child.mode === 'cleanup') {
    const bytes = await readFile(config.child.originalPath); assert(bytes.length <= 256 * 1024);
    const original = parseSandboxRecoveryRecord(JSON.parse(bytes.toString()));
    assert.equal(original.namespace, config.child.namespace); assert.equal(original.backendRevision, `engine-1.52-v6-${config.profile}`);
    const selected = await backend(config, { namespace: config.child.namespace, directory: join(config.output, 'owner') });
    const reconciled = await selected.backend.reconcile(original); result.reconciliation = reconciled.kind;
    if (reconciled.kind === 'absent') result.finalRecord = reconciled.record;
    else {
      assert.equal(reconciled.kind, 'matched'); owner = reconciled.owner;
      for (const method of ['start', 'reserveProcess', 'importTree', 'exportTree', 'files']) assert.equal(typeof owner[method], 'undefined');
      await settle(owner, 'destroy'); await settle(owner, 'destroy'); result.finalRecord = owner.recoveryRecord;
    }
    result.cleanupKind = 'fresh-process-cleanup-only';
    result.finalCensus = await census(engine, original, 'fresh-original-checkpoint-final', true);
  } else {
    const context = { config, engine, signal: undefined };
    const opened = await ready(run, context, { namespace: config.child.namespace }); owner = opened.owner;
    result.positive = await positive(opened, context);
    const held = await opened.session.request({ kind: 'hold', ...config.capabilities.network.positive, key: 'controller' });
    assert.equal(held.ok, true); assert.equal(held.result.authorized, true); assert.equal(held.result.closed, false); result.held = held.result;
    const original = owner.recoveryRecord; assert.equal(original.phase, 'running');
    assert.equal(original.backendRevision, `engine-1.52-v6-${config.profile}`);
    await jsonWriter(config.child.originalPath)(original);
    result.originalRecord = original; await save();
    process.stdout.write(JSON.stringify({ phase: 'ready', pid: process.pid, challenge: config.child.challenge,
      originalPath: config.child.originalPath, resumeListenerInstalledAt: result.resumeListenerInstalledAt }) + '\n');
    if (config.child.mode === 'crash') await new Promise(() => {});
    await resumed.promise; assert.equal(result.continueCount, 1);
    await until(() => owner.state.kind !== 'ready', config.capabilities.limits.startupMs,
      'Resumed original controller did not observe native authority loss.');
    assert.throws(() => opened.sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: [], env: {}, cwd: opened.sandbox.workspace }), SandboxStateError);
    result.fencedState = owner.state; await settle(owner, 'stop'); await settle(owner, 'destroy');
    result.finalRecord = owner.recoveryRecord; result.cleanupKind = 'original-controller';
    result.finalCensus = await census(engine, original, 'same-controller-final', true);
  }
  assert.equal(result.finalRecord.phase, 'destroyed'); result.status = 'passed'; await save();
} catch (error) {
  result.status = 'failed'; result.failure = failure(error);
  if (owner) {
    try { await settle(owner, 'destroy'); } catch (cleanup) { result.cleanupErrors.push(failure(cleanup)); }
    result.finalRecord = owner.recoveryRecord;
  }
  await save(); process.exitCode = 1;
} finally {
  for (const session of run.sessions) try { result.observations.push({ kind: 'sole-network-child-reader-joined', result: await session.join() }); }
  catch (error) { result.cleanupErrors.push(failure(error)); result.status = 'failed'; process.exitCode = 1; }
  process.removeListener('SIGCONT', continued); result.finishedAt = new Date().toISOString(); await save();
}
process.stdout.write(JSON.stringify({ phase: 'complete', pid: process.pid, status: result.status }) + '\n');
