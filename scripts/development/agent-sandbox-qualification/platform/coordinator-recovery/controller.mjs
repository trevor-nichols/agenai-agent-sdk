import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../engine.mjs';
import { installed } from '../research/desktop-concurrency/native/installed.mjs';
import { admitOutput, installedIdentity, within } from '../../scalability/identity.mjs';
import { absolute, encode, Evidence, failure, observe, sha } from '../coordinator/evidence.mjs';
import { compareEngineInventory, compareMemberInventory, engineInventory, exactAbsence, freezeSources,
  loadOriginal, memberConfiguration, originalFile } from './common.mjs';
import { installCleanupTrace } from './trace.mjs';
import { verifyFreshProcess } from './process.mjs';

async function publishSettled(context, record) {
  const bytes = Buffer.from(encode(record));
  if (context.settled) { assert.equal(sha(bytes), context.settled.sha256, 'A settled cleanup record cannot change.'); return; }
  context.settled = await context.evidence.file('settled-record.json', bytes, 65_536);
  context.report.settled = context.settled;
  context.report.settledEncoding = 'Exact SDK-returned record value serialized once as UTF-8 JSON; the resulting file bytes are passed unchanged to the fresh verifier.';
}

async function publicOperation(context, name, actual, timeoutMs = 60_000) {
  context.report.calls.push({ name, at: new Date().toISOString() }); context.operations.push(actual);
  return observe(actual, timeoutMs + 5000, name);
}

async function openOriginal(context) {
  if (context.opened) return context.opened;
  const opened = await publicOperation(context, 'coordinator.reopenCleanup', context.owner.reopenCleanup(
    { expectedGeneration: context.original.generation }, { timeoutMs: 60_000 }));
  context.opened = opened;
  await context.evidence.event({ kind: 'public-cleanup-opening', result: opened.kind, ownerState: context.owner.state });
  return opened;
}

async function closeOriginal(context) {
  await publicOperation(context, 'coordinator.close', context.owner.close({ timeoutMs: 60_000 }));
  assert.equal(context.owner.state.kind, 'closed');
  if (context.opened) {
    assert.equal(context.owner.state.result, 'clean');
    assert.equal(context.owner.state.generation, context.original.generation);
  }
  context.report.finalOwnerState = context.owner.state;
  context.closed = true;
  await context.evidence.event({ kind: 'original-generation-owner-closed', state: context.owner.state });
}

async function cleanupOwner(context, stopFirst) {
  if (!context.cleanup || context.cleaned) return;
  if (stopFirst) {
    await publicOperation(context, 'cleanupOwner.stop', context.cleanup.stop());
    context.report.afterStop = await context.evidence.file('stop-returned-record.json', Buffer.from(encode(context.cleanup.recoveryRecord)), 65_536);
  }
  await publicOperation(context, 'cleanupOwner.destroy', context.cleanup.destroy());
  context.cleaned = true;
  const record = context.cleanup.recoveryRecord;
  assert.equal(record.phase, 'destroyed'); await publishSettled(context, record);
  assert(!context.opened.recovery.members.some((entry) => entry.operationId === context.original.record.operationId),
    'Canonical member retirement must precede successful cleanup.');
}

async function reconcileOriginal(context) {
  const opened = await openOriginal(context);
  assert.equal(opened.kind, 'opened', 'The original dirty generation must supply its original cleanup inventory.');
  assert.equal(opened.recovery.kind, 'desktop_coordinator_cleanup'); assert.equal(opened.recovery.generation, context.original.generation);
  assert.equal(opened.recovery.members.length, 1);
  const member = opened.recovery.members[0]; compareMemberInventory(member, context.externalRecord);
  context.report.inventory = await context.evidence.file('public-original-inventory.json', opened.recovery.members, 4 * 65_536);
  context.report.selectedCanonicalRecord = await context.evidence.file('selected-canonical-record.json', Buffer.from(encode(member)), 65_536);
  const result = await publicOperation(context, 'recovery.reconcile.exactCanonicalMember', opened.recovery.reconcile({
    configuration: context.configuration, record: member,
  }, { signal: AbortSignal.timeout(60_000) }));
  context.report.reconciliation = result.kind;
  await context.evidence.event({ kind: 'exact-canonical-member-reconciled', result: result.kind,
    externalCheckpointEvidence: context.original.checkpoint.identity, selectedCanonicalRecord: context.report.selectedCanonicalRecord });
  if (result.kind === 'absent') {
    assert(!opened.recovery.members.some((entry) => entry.operationId === context.original.record.operationId));
    context.cleaned = true; await publishSettled(context, result.record); return;
  }
  assert(result.kind === 'matched' || result.kind === 'uncertain', result.reason ?? 'Cleanup reconciliation returned no original cleanup owner.');
  context.cleanup = result.owner;
  for (const method of ['start', 'reserveProcess', 'importTree', 'exportTree', 'files']) assert.equal(typeof context.cleanup[method], 'undefined');
  await cleanupOwner(context, true);
}

async function finishOriginal(context) {
  await cleanupOwner(context, false);
  if (context.owner && !context.closed) await closeOriginal(context);
  await observe(Promise.allSettled(context.operations), 20_000, 'Original cleanup API observation joins');
}

async function retain(context, error) {
  context.report.status = 'retained_cleanup'; context.report.cleanupFailures.push(failure(error));
  await context.evidence.file('retained-report-001.json', context.report);
  process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', pid: process.pid, output: context.input.output,
    retrySignal: 'SIGUSR2', message: 'Original cleanup capabilities remain resident. No controller reset or process termination was performed.' })}\n`);
  let retry = Promise.withResolvers(); const requested = () => retry.resolve();
  process.on('SIGUSR2', requested); const keepAlive = setInterval(() => {}, 30_000); let receipts = 1;
  try {
    for (;;) {
      await retry.promise; retry = Promise.withResolvers();
      try {
        if (!context.child && !context.cleanup && !context.cleaned) await reconcileOriginal(context);
        await finishOriginal(context); return;
      } catch (cause) {
        context.report.cleanupFailures.push(failure(cause));
        if (receipts < 16) await context.evidence.file(`retained-report-${String(++receipts).padStart(3, '0')}.json`, context.report);
        process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', pid: process.pid, failures: context.report.cleanupFailures.length })}\n`);
      }
    }
  } finally { clearInterval(keepAlive); process.off('SIGUSR2', requested); }
}

async function verifyOriginals(context) {
  for (const input of [context.inputFile, context.original.originalInput, context.original.retained, context.original.checkpoint]) {
    assert.equal(sha(await readFile(input.identity.path)), input.identity.sha256, 'Original input/evidence bytes changed.');
  }
  if (context.suppliedSettled) assert.equal(sha(await readFile(context.suppliedSettled.identity.path)), context.suppliedSettled.identity.sha256);
  for (const source of context.report.sources) assert.equal(sha(await readFile(source.original)), source.sha256, 'Cleanup qualifier source changed during execution.');
  assert.deepEqual(await installedIdentity(context.input.consumer), context.report.candidate, 'The installed candidate changed during cleanup.');
}

async function main(path, child) {
  const inputFile = await originalFile(absolute(path), 1024 ** 2); const input = inputFile.value;
  const required = ['consumer', 'output', 'originalInput', 'retainedReport', 'checkpoint'];
  if (child) required.push('settledRecord', 'expectedGeneration', 'expectedCandidate', 'expectedSources');
  assert.deepEqual(Object.keys(input).sort(), required.sort()); absolute(input.consumer); absolute(input.output);
  const original = await loadOriginal(input);
  assert.notEqual(input.consumer, original.config.consumer, 'Cleanup qualification requires a separate fresh installed consumer.');
  assert(!within(original.config.output, input.output) && !within(input.output, original.config.output),
    'Cleanup output must be separate from the immutable original native attempt.');
  if (child) assert.equal(input.expectedGeneration, original.generation);
  await admitOutput(input.output, input.consumer); assert.equal(await realpath(dirname(input.output)), dirname(input.output));
  const evidence = new Evidence(input.output); await evidence.initialize(inputFile.bytes);
  const report = { format: 'agenai.desktop-coordinator-installed-cleanup-prerequisite.v1', status: 'running', mode: child ? 'fresh-clean-absence' : 'original-generation-cleanup',
    startedAt: new Date().toISOString(), pid: process.pid, runtime: { executable: process.execPath, node: process.versions.node, platform: process.platform, arch: process.arch },
    input: inputFile.identity, originalInput: original.originalInput.identity, retainedReport: original.retained.identity,
    originalCheckpoint: original.checkpoint.identity, generation: original.generation, sources: [], calls: [],
    candidate: null, packages: [], finalOwnerState: null, primaryFailure: null, cleanupFailures: [],
    scope: 'MS004 standalone original-generation cleanup prerequisite. Public cleanup-only API, bounded Node HTTP GET/DELETE trace, exact original name/ID absence; no full MS007/crash qualification or arbitrary raw-socket trace claim.' };
  const context = { input, inputFile, original, evidence, report, child, owner: null, opened: null, cleanup: null,
    operations: [], cleaned: false, closed: false, settled: null, suppliedSettled: null, interrupted: false };
  const interrupted = () => { context.interrupted = true; context.owner?.closeAdmission(); };
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  let trace;
  try {
    report.sources = await freezeSources(evidence);
    if (child) assert.deepEqual(report.sources.map(({ original: file, sha256 }) => ({ original: file, sha256 })), input.expectedSources);
    await evidence.file('original-input-bytes.json', original.originalInput.bytes, 1024 ** 2);
    await evidence.file('original-retained-report-bytes.json', original.retained.bytes);
    await evidence.file('original-checkpoint-bytes.json', original.checkpoint.bytes, 65_536);
    report.candidate = await installedIdentity(input.consumer);
    if (child) assert.deepEqual(report.candidate, input.expectedCandidate);
    const records = [original.record];
    if (child) {
      context.suppliedSettled = await originalFile(input.settledRecord, 65_536);
      compareMemberInventory(context.suppliedSettled.value, original.record);
      report.suppliedSettled = context.suppliedSettled.identity; records.push(context.suppliedSettled.value);
      await evidence.file('supplied-settled-bytes.json', context.suppliedSettled.bytes, 65_536);
    }
    const socketPath = original.config.platform.engine.slice(7);
    const socket = await lstat(socketPath, { bigint: true }); assert(socket.isSocket());
    assert.equal(String(socket.dev), original.report.socket.device); assert.equal(String(socket.ino), original.report.socket.inode);
    trace = installCleanupTrace({ socketPath, path: join(input.output, 'engine-http-trace.jsonl'), records, consume: (bytes) => evidence.count(bytes) });
    const sdk = await installed(input.consumer, '@agen-ai/sandbox');
    const docker = await installed(input.consumer, '@agen-ai/sandbox-docker');
    const node = await installed(input.consumer, '@agen-ai/sandbox-docker', './node');
    report.packages = [sdk.identity, docker.identity, node.identity];
    context.externalRecord = sdk.api.parseSandboxRecoveryRecord(JSON.parse(original.checkpoint.bytes.toString('utf8')));
    assert.deepEqual(context.externalRecord, original.checkpoint.value, 'Original external checkpoint evidence must parse without rewriting.');
    context.configuration = memberConfiguration(original, node.api);
    const routeAuthority = node.api.createDockerDesktopRouteAuthority(original.config.capabilities.network.routeAuthority);
    context.owner = node.api.createDockerDesktopCoordinator({ routeAuthority, helper: original.config.helper });
    context.engine = new Engine(socketPath, '1.52', { requestMs: 10_000, outputBytes: 4 * 1024 ** 2 });
    report.before = await engineInventory(context.engine); assert.equal(report.before.daemonId, original.report.engine.id);
    if (child) {
      sdk.api.parseSandboxRecoveryRecord(context.suppliedSettled.value);
      const opened = await openOriginal(context); assert.equal(opened.kind, 'absent');
      report.reconcilePerformed = false;
      report.reconcileDisposition = 'No recovery handle exists after clean reopen; the supplied settled bytes were preserved and independently checked only.';
    } else { await reconcileOriginal(context); report.reconcilePerformed = true; }
    await finishOriginal(context);
    report.absence = await exactAbsence(context.engine, records.concat(context.cleanup ? [context.cleanup.recoveryRecord] : []));
    report.after = await engineInventory(context.engine); compareEngineInventory(report.before, report.after, original.record);
    if (!child) {
      assert.equal(context.interrupted, false, 'Interrupted cleanup qualification cannot start another process.');
      const childInput = { ...input, output: join(input.output, 'fresh-process'), settledRecord: context.settled.path,
        expectedGeneration: original.generation, expectedCandidate: report.candidate,
        expectedSources: report.sources.map(({ original: file, sha256 }) => ({ original: file, sha256 })) };
      const selected = await evidence.file('fresh-process-input.json', childInput, 1024 ** 2);
      report.freshProcess = await verifyFreshProcess({ executable: process.execPath, script: fileURLToPath(import.meta.url),
        inputPath: selected.path, cwd: input.consumer, evidence });
      const childReport = await originalFile(join(childInput.output, 'report.json'), 4 * 1024 ** 2);
      assert.equal(childReport.value.status, 'pass'); assert.equal(childReport.value.reconcilePerformed, false);
      assert.equal(childReport.value.suppliedSettled.sha256, context.settled.sha256);
      assert.equal(childReport.value.finalOwnerState.generation, original.generation);
      report.freshProcess.report = childReport.identity;
    }
    report.status = 'pass';
  } catch (error) { report.primaryFailure = failure(error); report.status = 'fail'; }
  finally {
    try { await finishOriginal(context); }
    catch (error) { await retain(context, error); report.status = 'fail'; }
    try { await verifyOriginals(context); }
    catch (error) { report.identityFailure = failure(error); report.status = 'fail'; }
    report.trace = trace?.summarize() ?? null;
    if (report.trace && (report.trace.blocked || report.trace.forbiddenDispatches)) report.status = 'fail';
    if (context.interrupted) { report.interrupted = true; report.status = 'fail'; }
    trace?.restore(); report.finishedAt = new Date().toISOString();
    await evidence.file('report.json', report); await evidence.close();
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, mode: report.mode, output: input.output, report: join(input.output, 'report.json'), generation: original.generation })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

try {
  const args = process.argv.slice(2); const child = args[0] === '--absent';
  const members = args[0] === '--members' || args[0] === '--members-absent';
  assert.equal(args.length, child || members ? 2 : 1, 'Usage: node coordinator-recovery/controller.mjs [--members] /absolute/input.json');
  if (members) await (await import('./multi-controller.mjs')).multiMain(args[1], args[0] === '--members-absent');
  else await main(args[child ? 1 : 0], child);
} catch (error) { process.stderr.write(`${JSON.stringify({ status: 'fail', failure: failure(error) })}\n`); process.exitCode = 1; }
