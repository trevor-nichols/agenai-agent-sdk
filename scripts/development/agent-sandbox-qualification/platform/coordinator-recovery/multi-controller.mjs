import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../engine.mjs';
import { admitOutput, importInstalled, installedIdentity, within } from '../../scalability/identity.mjs';
import { absolute, encode, Evidence, failure, observe, sha } from '../coordinator/evidence.mjs';
import { compareEngineInventory, compareMemberInventory, engineInventory, exactAbsence, freezeSources, memberConfiguration, originalFile } from './common.mjs';
import { loadOriginalMembers } from './multi-input.mjs';
import { installCleanupTrace } from './trace.mjs';
import { verifyFreshProcess } from './process.mjs';
import { installEngineCapture } from '../coordinator/engine-capture.mjs';

async function operation(context, name, actual) {
  context.report.calls.push({ name, at: new Date().toISOString() }); context.operations.push(actual);
  return observe(actual, 65_000, name);
}

async function reconcile(context, entry) {
  const { evidence, report, opened, original } = context;
  if (entry.settled) return;
  if (!entry.owner) {
    const member = opened.recovery.members.find(({ operationId }) => operationId === entry.record.operationId); assert(member);
    compareMemberInventory(member, entry.record);
    entry.report.canonical = await evidence.file(`selected-${entry.member.label}-canonical-${++entry.attempt}.json`, Buffer.from(encode(member)), 65_536);
    const result = await operation(context, `${entry.member.label}.reconcile.exactCanonical`, opened.recovery.reconcile({
      configuration: memberConfiguration(original, context.node, entry), record: member,
    }, { signal: AbortSignal.timeout(60_000) }));
    entry.report.reconciliation = result.kind;
    if (result.kind === 'absent') entry.returned = result.record;
    else {
      assert(result.kind === 'matched' || result.kind === 'uncertain', result.reason ?? 'No original cleanup owner returned.');
      entry.owner = result.owner;
      for (const method of ['start', 'reserveProcess', 'importTree', 'exportTree', 'files']) assert.equal(typeof entry.owner[method], 'undefined');
    }
  }
  if (entry.owner) {
    if (!entry.stopObserved) {
      try { await operation(context, `${entry.member.label}.cleanup.stop`, entry.owner.stop()); }
      catch (error) { entry.report.stopFailure = failure(error); }
      entry.stopObserved = true;
      entry.report.afterStop = await evidence.file(`${entry.member.label}-stop-returned-record.json`, Buffer.from(encode(entry.owner.recoveryRecord)), 65_536);
    }
    await operation(context, `${entry.member.label}.cleanup.destroy`, entry.owner.destroy()); entry.returned = entry.owner.recoveryRecord;
  }
  assert.equal(entry.returned.phase, 'destroyed');
  assert(!opened.recovery.members.some(({ operationId }) => operationId === entry.record.operationId));
  compareMemberInventory(entry.returned, entry.record);
  entry.settled = await evidence.file(`${entry.member.label}-settled-record.json`, Buffer.from(encode(entry.returned)), 65_536);
  entry.report.settled = entry.settled; report.settledRecords.push({ label: entry.member.label, ...entry.settled });
  await evidence.event({ kind: 'exact-original-member-cleanup-settled', label: entry.member.label, settled: entry.settled });
}

async function finish(context) {
  const failures = [];
  if (context.opened?.kind === 'opened') for (const entry of context.members) {
    try { await reconcile(context, entry); } catch (error) { failures.push({ label: entry.member.label, failure: failure(error) }); }
  }
  if (failures.length) throw new AggregateError(failures.map((item) => new Error(JSON.stringify(item))), 'Exact original multi-member cleanup remains owned.');
  if (context.owner && !context.closed) {
    await operation(context, 'coordinator.close', context.owner.close({ timeoutMs: 60_000 }));
    assert.equal(context.owner.state.kind, 'closed'); assert.equal(context.owner.state.result, 'clean');
    assert.equal(context.owner.state.generation, context.original.generation); context.closed = true;
    context.report.finalOwnerState = context.owner.state;
  }
  await observe(Promise.allSettled(context.operations), 20_000, 'Original cleanup operation join');
}

async function retain(context, error) {
  context.report.status = 'retained_cleanup'; context.report.cleanupFailures.push(failure(error));
  await context.evidence.file('retained-report-001.json', context.report);
  process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', pid: process.pid, output: context.input.output,
    retrySignal: 'SIGUSR2', message: 'Original cleanup capabilities remain resident; retry repeats exact cleanup only.' })}\n`);
  const keepAlive = setInterval(() => {}, 30_000); let requested = Promise.withResolvers();
  const retry = () => requested.resolve(); process.on('SIGUSR2', retry); let receipts = 1;
  try {
    for (;;) {
      await requested.promise; requested = Promise.withResolvers();
      try { await finish(context); return; }
      catch (cause) {
        context.report.cleanupFailures.push(failure(cause));
        if (receipts < 16) await context.evidence.file(`retained-report-${String(++receipts).padStart(3, '0')}.json`, context.report);
      }
    }
  } finally { clearInterval(keepAlive); process.off('SIGUSR2', retry); }
}

export async function multiMain(path, child) {
  const inputFile = await originalFile(absolute(path), 1024 ** 2); const input = inputFile.value;
  const keys = ['consumer', 'output', 'originalInput', 'originalReport', 'canonical'];
  if (child) keys.push('settledRecords', 'expectedCandidate', 'expectedSources');
  assert.deepEqual(Object.keys(input).sort(), keys.sort()); absolute(input.consumer); absolute(input.output);
  const original = await loadOriginalMembers(input);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.versions.node, original.config.platform.expected.controller.nodeVersion);
  assert.notEqual(input.consumer, original.config.consumer, 'Cleanup requires a separate fresh installed consumer.');
  assert(!within(original.config.output, input.output) && !within(input.output, original.config.output));
  await admitOutput(input.output, input.consumer); assert.equal(await realpath(dirname(input.output)), dirname(input.output));
  const evidence = new Evidence(input.output); await evidence.initialize(inputFile.bytes);
  const report = { format: 'agenai.desktop-coordinator-ms005-installed-cleanup.v1', status: 'running',
    mode: child ? 'fresh-clean-absence' : 'original-generation-cleanup', startedAt: new Date().toISOString(), pid: process.pid,
    input: inputFile.identity, originalInput: original.originalInput.identity, originalReport: original.retained.identity,
    originalCanonical: original.canonical.identity, generation: original.generation, runtime: { executable: process.execPath,
      node: process.versions.node, platform: process.platform, arch: process.arch }, sources: [], candidate: null, packages: [], calls: [],
    members: [], settledRecords: [], primaryFailure: null, cleanupFailures: [], finalOwnerState: null,
    scope: 'MS005 exploratory cleanup-only recovery from complete original handoff evidence and exact public canonical records. Bounded Node HTTP GET/DELETE only; no workload creation/start/import, adoption or replay. Full MS007 profiles remain separate.' };
  const context = { input, inputFile, original, evidence, report, owner: null, opened: null, closed: false, operations: [],
    members: original.members.filter(({ canonicalMember }) => canonicalMember).map((entry) => ({ ...entry, owner: null, attempt: 0, settled: null, returned: null,
      report: { label: entry.member.label, externalCheckpoint: entry.checkpoint.identity } })), interrupted: false };
  report.members = context.members.map(({ report: item }) => item);
  const interrupted = () => { context.interrupted = true; context.owner?.closeAdmission(); };
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted); let trace; let capture;
  try {
    report.sources = await freezeSources(evidence);
    if (child) assert.deepEqual(report.sources.map(({ original: file, sha256 }) => ({ original: file, sha256 })), input.expectedSources);
    await evidence.file('original-input-bytes.json', original.originalInput.bytes, 1024 ** 2);
    await evidence.file('original-report-bytes.json', original.retained.bytes);
    await evidence.file('original-canonical-bytes.bin', original.canonical.bytes);
    for (const entry of original.members) await evidence.file(`${entry.member.label}-external-original-bytes.json`, entry.checkpoint.bytes, 65_536);
    report.candidate = await installedIdentity(input.consumer);
    if (child) assert.deepEqual(report.candidate, input.expectedCandidate);
    const records = [...original.observed]; context.supplied = [];
    if (child) {
      assert.equal(input.settledRecords.length, context.members.length);
      for (const selected of input.settledRecords) {
        const entry = context.members.find(({ member }) => member.label === selected.label); assert(entry);
        const settled = await originalFile(selected.path, 65_536); assert.deepEqual(settled.identity, { path: selected.path, bytes: selected.bytes, sha256: selected.sha256 });
        assert.equal(settled.value.phase, 'destroyed'); compareMemberInventory(settled.value, entry.record);
        assert(!context.supplied.some(({ label }) => label === selected.label));
        context.supplied.push({ label: selected.label, ...settled }); records.push(settled.value);
        await evidence.file(`${selected.label}-supplied-settled-original-bytes.json`, settled.bytes, 65_536);
      }
      report.suppliedSettledRecords = input.settledRecords;
    }
    const socketPath = original.config.platform.engine.slice(7); const socket = await lstat(socketPath, { bigint: true }); assert(socket.isSocket());
    assert.equal(String(socket.dev), original.report.socket.device); assert.equal(String(socket.ino), original.report.socket.inode);
    trace = installCleanupTrace({ socketPath, path: join(input.output, 'engine-http-trace.jsonl'), records, consume: (bytes) => evidence.count(bytes) });
    capture = await installEngineCapture({ socketPath, evidence });
    const sdk = await importInstalled(input.consumer, '@agen-ai/sandbox');
    const docker = await importInstalled(input.consumer, '@agen-ai/sandbox-docker'); const node = await importInstalled(input.consumer, '@agen-ai/sandbox-docker', './node');
    context.node = node.api; report.packages = [sdk.identity, docker.identity, node.identity];
    for (const entry of context.members) assert.deepEqual(sdk.api.parseSandboxRecoveryRecord(entry.record), entry.record);
    for (const selected of context.supplied) assert.deepEqual(sdk.api.parseSandboxRecoveryRecord(selected.value), selected.value);
    context.engine = new Engine(socketPath, '1.52', { requestMs: 10_000, outputBytes: 4 * 1024 ** 2 });
    report.before = await engineInventory(context.engine); assert.equal(report.before.daemonId, original.report.engine.id);
    const routeAuthority = node.api.createDockerDesktopRouteAuthority(original.config.capabilities.network.routeAuthority);
    context.owner = node.api.createDockerDesktopCoordinator({ routeAuthority, helper: original.config.helper });
    context.opened = await operation(context, 'coordinator.reopenCleanup', context.owner.reopenCleanup({ expectedGeneration: original.generation }, { timeoutMs: 60_000 }));
    if (child) { assert.equal(context.opened.kind, 'absent'); report.reconcilePerformed = false; }
    else {
      assert.equal(context.opened.kind, 'opened'); assert.equal(context.opened.recovery.generation, original.generation);
      assert.equal(context.opened.recovery.members.length, context.members.length);
      report.publicOriginalInventory = await evidence.file('public-original-inventory.json', context.opened.recovery.members, 3 * 65_536);
      report.reconcilePerformed = true;
    }
    await finish(context);
    report.absence = await exactAbsence(context.engine, records.concat(context.members.flatMap(({ returned }) => returned ? [returned] : [])));
    report.after = await engineInventory(context.engine); compareEngineInventory(report.before, report.after, records);
    if (!child) {
      assert.equal(context.interrupted, false);
      const childInput = { ...input, output: join(input.output, 'fresh-process'), settledRecords: report.settledRecords,
        expectedCandidate: report.candidate, expectedSources: report.sources.map(({ original: file, sha256 }) => ({ original: file, sha256 })) };
      const selected = await evidence.file('fresh-process-input.json', childInput, 1024 ** 2);
      report.freshProcess = await verifyFreshProcess({ executable: process.execPath, script: fileURLToPath(new URL('controller.mjs', import.meta.url)),
        inputPath: selected.path, cwd: input.consumer, evidence, mode: '--members-absent' });
      const fresh = await originalFile(join(childInput.output, 'report.json'), 4 * 1024 ** 2);
      assert.equal(fresh.value.status, 'pass'); assert.equal(fresh.value.reconcilePerformed, false);
      assert.deepEqual(fresh.value.suppliedSettledRecords, report.settledRecords); report.freshProcess.report = fresh.identity;
    }
    report.status = 'pass';
  } catch (error) { report.primaryFailure = failure(error); report.status = 'fail'; }
  finally {
    try { await finish(context); } catch (error) { await retain(context, error); report.status = 'fail'; }
    try {
      for (const selected of [inputFile, ...original.originals, ...(context.supplied ?? [])]) assert.equal(sha(await readFile(selected.identity.path)), selected.identity.sha256);
      for (const source of report.sources) assert.equal(sha(await readFile(source.original)), source.sha256);
      assert.deepEqual(await installedIdentity(input.consumer), report.candidate);
    } catch (error) { report.identityFailure = failure(error); report.status = 'fail'; }
    report.trace = trace?.summarize() ?? null;
    if (report.trace && (report.trace.blocked || report.trace.forbiddenDispatches)) report.status = 'fail';
    if (context.interrupted) { report.interrupted = true; report.status = 'fail'; }
    if (capture) {
      try { report.engineCapture = await capture.close(); if (report.engineCapture.completeness !== 'complete') report.status = 'fail'; }
      catch (error) { report.engineCaptureFailure = failure(error); report.status = 'fail'; }
    }
    trace?.restore(); report.finishedAt = new Date().toISOString();
    await evidence.file('report.json', report); await evidence.close(); process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, output: input.output, mode: report.mode, generation: original.generation })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}
