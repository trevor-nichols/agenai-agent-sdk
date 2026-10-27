import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { acquireJsonInput } from '../input.mjs';
import { fileFromBytes, parseSandboxRecoveryRecord, SandboxCleanupError, SandboxStateError } from '@agen-ai/sandbox';
import { until } from '../../../engine.mjs';
import { assertGuestFacts, backend, request } from './installed.mjs';
import { failure, jsonWriter } from './evidence.mjs';
import { sha } from './operations.mjs';
import { settleOwnerCleanup } from './owner-cleanup.mjs';

const [mode, configurationPath] = process.argv.slice(2);
assert(process.argv.length === 4 && ['start', 'lease', 'recover', 'absent'].includes(mode));
const { value: config } = await acquireJsonInput(configurationPath, 256 * 1024);
assert.deepEqual(Object.keys(config).sort(), ['challenge', 'config', 'directory', 'expectRetry', 'namespace',
  'originalPath', 'readyPath', 'recoveryPath', 'resultPath'].sort());
const saveResult = jsonWriter(config.resultPath); const saveRecovery = jsonWriter(config.recoveryPath);
const result = { mode, pid: process.pid, challenge: config.challenge, status: 'entered', cleanupErrors: [], checkpoints: [], cleanupObservations: [] };
await saveResult(result);
let owner; let session;
const resume = Promise.withResolvers();
const resumed = () => resume.resolve({ signal: 'SIGCONT', receivedAt: new Date().toISOString(), pid: process.pid });
if (mode === 'lease') {
  process.once('SIGCONT', resumed);
  result.resumeListenerInstalledAt = new Date().toISOString(); await saveResult(result);
}
const settleCleanup = (operation) => settleOwnerCleanup(owner, operation, {
  cleanupMs: config.config.capabilities.limits.cleanupMs,
  async observe(observation) {
    result.cleanupObservations.push(observation); await saveRecovery(owner.recoveryRecord); await saveResult(result);
  },
});

async function initialize(selected) {
  owner = selected.reserve(request(config.config), { kind: 'persisted', persist: saveRecovery });
  await saveRecovery(owner.recoveryRecord);
  const sandbox = await owner.start();
  const source = await readFile(new URL('../../../capabilities/live/guest.mjs', import.meta.url));
  await sandbox.importTree([fileFromBytes('qualification/live-guest.mjs', source)]);
  const streams = await sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: [`${sandbox.workspace}/qualification/live-guest.mjs`],
    cwd: sandbox.workspace, env: { LANG: 'C.UTF-8' } }).start();
  const { GuestSession } = await import('../../../capabilities/production/session.mjs');
  session = new GuestSession(streams, config.config.capabilities.limits.requestMs); await session.ready;
  const facts = await session.request({ kind: 'facts' }); assert.equal(facts.ok, true);
  assertGuestFacts(config.config, facts);
  const bytes = Uint8Array.of(0, 255, 33);
  const write = await sandbox.files.writeFile('crash.bin', [bytes], { mode: 'create' });
  assert.deepEqual(write, { kind: 'completed', effect: 'published', bytes: 3n, permissions: 0o644 });
  const actual = [];
  const read = await sandbox.files.readFile('crash.bin', async ({ chunks }) => { for await (const chunk of chunks) actual.push(...chunk); });
  assert.deepEqual(read, { kind: 'completed', bytes: 3n }); assert.deepEqual(actual, [0, 255, 33]);
  assert.deepEqual(owner.recoveryRecord.resources.map(({ role }) => role).sort(), ['compute', 'export', 'filesystem', 'storage']);
  assert(owner.recoveryRecord.resources.every(({ identity }) => identity.kind === 'identified'));
  await jsonWriter(config.originalPath)(owner.recoveryRecord);
  const ready = { pid: process.pid, challenge: config.challenge, ownerState: owner.state, record: owner.recoveryRecord, facts, write, read,
    readyAt: new Date().toISOString(), resumeListenerInstalledAt: result.resumeListenerInstalledAt ?? null };
  await jsonWriter(config.readyPath)(ready);
  result.checkpoints.push({ phase: 'initialized-with-native-read-write', ready }); await saveResult(result);
  process.stdout.write(`${JSON.stringify({ phase: 'ready', pid: process.pid, challenge: config.challenge })}\n`);
  return { sandbox, ready };
}

async function finishLease(sandbox, ready) {
  result.resume = await resume.promise;
  assert(result.resume.receivedAt >= ready.readyAt);
  await saveResult(result);
  await until(() => owner.state.kind !== 'ready', config.config.capabilities.limits.requestMs,
    'The resumed original controller did not fence its expired filesystem helper.');
  let mutationFailure; let sourceEntered = 0;
  assert.throws(() => sandbox.files.writeFile('after-lease.bin', { async *[Symbol.asyncIterator]() {
    sourceEntered++; yield Uint8Array.of(99);
  } }, { mode: 'create' }), (error) => { mutationFailure = failure(error); return error instanceof SandboxStateError; });
  assert.equal(sourceEntered, 0);
  result.fence = { observedAt: new Date().toISOString(), ownerState: owner.state, mutationFailure, sourceEntered };
  await saveResult(result);
  await settleCleanup('stop'); assert.equal(owner.state.kind, 'stopped');
  result.checkpoints.push({ phase: 'original-controller-stop-joined', observedAt: new Date().toISOString(), ownerState: owner.state });
  result.session = await session.join(); session = undefined; await saveResult(result);
  const paths = []; const bytes = [];
  const summary = await sandbox.exportTree({ kind: 'files', paths: ['crash.bin'] }, async (entry) => {
    paths.push(entry.path); assert.equal(entry.kind, 'file'); assert.equal(entry.byteLength, 3); assert.equal(entry.executable, false);
    for await (const chunk of entry.bytes) { bytes.push(Buffer.from(chunk)); assert(bytes.length <= 4); }
  });
  const actual = Buffer.concat(bytes); assert.deepEqual(paths, ['crash.bin']); assert.deepEqual(actual, Buffer.from([0, 255, 33]));
  const workspacePaths = []; let workspaceBytes = 0;
  const workspaceSummary = await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
    workspacePaths.push(entry.path); assert(workspacePaths.length <= 32);
    if (entry.kind === 'file') for await (const chunk of entry.bytes) { workspaceBytes += chunk.byteLength; assert(workspaceBytes <= 256 * 1024); }
  });
  assert(!workspacePaths.includes('after-lease.bin')); assert(!workspacePaths.includes('stage'));
  result.export = { observedAt: new Date().toISOString(), paths, summary, bytesBase64: actual.toString('base64'), sha256: sha(actual),
    workspacePaths, workspaceSummary, workspaceBytes };
  await saveResult(result);
  await settleCleanup('destroy'); assert.equal(owner.state.kind, 'destroyed');
  result.finalRecord = owner.recoveryRecord; result.cleanupKind = 'original-controller';
  result.status = 'passed'; await saveRecovery(owner.recoveryRecord); await saveResult(result);
  process.stdout.write(`${JSON.stringify({ phase: 'complete', mode, pid: process.pid })}\n`);
}

try {
  const selected = await backend(config.config, { namespace: config.namespace, directory: config.directory });
  if (mode === 'start' || mode === 'lease') {
    const { sandbox, ready } = await initialize(selected);
    if (mode === 'lease') await finishLease(sandbox, ready);
    else await new Promise(() => {});
  } else {
    const bytes = await readFile(config.originalPath); assert(bytes.length <= 128 * 1024);
    const record = parseSandboxRecoveryRecord(JSON.parse(bytes.toString('utf8')));
    result.originalRecord = record;
    const recovered = await selected.reconcile(record); result.reconciliation = recovered.kind;
    if (mode === 'absent' || recovered.kind === 'absent' && !config.expectRetry) {
      assert.equal(recovered.kind, 'absent'); result.finalRecord = recovered.record;
    } else {
      assert.equal(recovered.kind, 'matched'); owner = recovered.owner;
      for (const method of ['start', 'reserveProcess', 'importTree', 'exportTree', 'files']) assert.equal(typeof owner[method], 'undefined');
      await saveRecovery(owner.recoveryRecord); result.checkpoints.push({ phase: 'cleanup-only-reconciled', record: owner.recoveryRecord });
      let firstFailure;
      try { await owner.destroy(); } catch (error) { firstFailure = error; }
      if (config.expectRetry) {
        assert(firstFailure instanceof SandboxCleanupError); assert.equal(firstFailure.owner, owner);
        result.retainedFailure = failure(firstFailure); await saveRecovery(owner.recoveryRecord); await saveResult(result);
        await firstFailure.owner.destroy();
        result.checkpoints.push({ phase: 'retry-original-cleanup-owner', record: owner.recoveryRecord });
      } else if (firstFailure) throw firstFailure;
      await owner.destroy(); result.checkpoints.push({ phase: 'duplicate-destroy', record: owner.recoveryRecord });
      await saveRecovery(owner.recoveryRecord); result.finalRecord = owner.recoveryRecord;
    }
    result.status = 'passed'; await saveResult(result);
    process.stdout.write(`${JSON.stringify({ phase: 'complete', mode, pid: process.pid })}\n`);
  }
} catch (error) {
  result.status = 'failed'; result.failure = failure(error);
  if (owner) {
    try { await settleCleanup('destroy'); } catch (cleanup) { result.cleanupErrors.push(failure(cleanup)); }
    result.finalRecord = owner.recoveryRecord;
    try { await saveRecovery(owner.recoveryRecord); } catch (cleanup) { result.cleanupErrors.push(failure(cleanup)); }
  }
  if (session) { try { result.session = await session.join(); } catch (cleanup) { result.cleanupErrors.push(failure(cleanup)); } }
  await saveResult(result); process.stderr.write(`${JSON.stringify(result.failure)}\n`); process.exitCode = 1;
} finally { process.removeListener('SIGCONT', resumed); }
