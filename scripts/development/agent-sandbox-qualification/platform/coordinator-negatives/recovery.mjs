import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../engine.mjs';
import { admitOutput, installedIdentity } from '../../scalability/identity.mjs';
import { installed } from '../research/desktop-concurrency/native/installed.mjs';
import { absolute, Evidence, failure } from '../coordinator/evidence.mjs';
import { installEngineCapture } from '../coordinator/engine-capture.mjs';
import { compareEngineInventory, engineInventory, exactAbsence, freezeSources, memberConfiguration, originalFile } from '../coordinator-recovery/common.mjs';
import { verifyFreshProcess } from '../coordinator-recovery/process.mjs';
import { jsonWriter } from '../capabilities/live/evidence.mjs';
import { assertOriginals, freezeOwnSources, originalDeleteCut, originalFileBytes } from './original.mjs';
import { installGuard } from './guard.mjs';
import { memberNegatives, wrongGeneration } from './cases.mjs';
import { createReplacement, deletedCompute } from './fixture.mjs';
import { cleanupOriginal, retainSignals, retainUntilFinished } from './cleanup.mjs';

export async function runRecoveryNegatives(inputPath) {
  const selected = await originalFile(absolute(inputPath), 1024 ** 2), input = selected.value;
  assert.deepEqual(Object.keys(input).sort(), ['consumer', 'output', 'originalInput', 'originalReport', 'canonical',
    'predecessor', 'fixtureImage', 'expectedCandidate'].sort());
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.equal(process.versions.node, '24.18.0');
  const original = await originalDeleteCut(input), collision = deletedCompute(original);
  assert.notEqual(input.consumer, original.config.consumer, 'Native negatives require a separate installed copy of the same candidate.');
  assert.deepEqual(await installedIdentity(input.consumer), input.expectedCandidate);
  assert.deepEqual(original.report.candidate, input.expectedCandidate, 'The original workload must use the exact selected installed tuple.');
  await admitOutput(input.output, input.consumer);
  const evidence = new Evidence(input.output); await evidence.initialize(selected.bytes);
  const report = { format: 'agenai.desktop-coordinator-negative-qualification.v1', status: 'running',
    pid: process.pid, startedAt: new Date().toISOString(), input: selected.identity, generation: original.generation,
    cases: [], fixture: {}, settledRecords: [], sources: [], originalCleanupComplete: false, cleanupComplete: false,
    primaryFailure: null, cleanupFailures: [], evidenceFailures: [],
    scope: 'Installed public dirty-generation negatives and selected native wrong-generation/same-name preservation only; no resume or execution capability.' };
  const checkpoint = jsonWriter(join(input.output, 'record.json')), save = () => checkpoint(report);
  const signals = retainSignals(report);
  const socketPath = original.config.platform.engine.slice(7);
  const engine = new Engine(socketPath, '1.52', { requestMs: 15_000, outputBytes: 4 * 1024 ** 2 });
  let guard, capture, wrong, owner, cleanup, fixture, nodeApi;
  const observed = async (value) => { report.cases.push(value); await save(); };
  const finish = async () => {
    if (wrong && wrong !== owner && wrong.state.kind !== 'closed') { guard.select({ kind: 'read_only' }); await wrong.close({ timeoutMs: 60_000 }); }
    if (!owner && nodeApi) owner = nodeApi.createDockerDesktopCoordinator({ helper: original.config.helper,
      routeAuthority: nodeApi.createDockerDesktopRouteAuthority(original.config.capabilities.network.routeAuthority) });
    if (owner && !cleanup && owner.state.kind !== 'closed') {
      const opened = await owner.reopenCleanup({ expectedGeneration: original.generation }, { timeoutMs: 60_000 });
      assert.equal(opened.kind, 'opened');
      cleanup = cleanupOriginal({ original, node: nodeApi,
        owner, recovery: opened.recovery, guard, report, evidence, save });
    }
    if (cleanup) await cleanup.finish();
    if (fixture) { guard.select({ kind: 'read_only' }); await fixture.remove(); }
    report.cleanupComplete = (!owner || owner.state.kind === 'closed') && (!wrong || wrong.state.kind === 'closed')
      && (!report.fixture.entered || report.fixture.removed);
    assert(report.cleanupComplete, 'The original negative-proof owners remain outstanding.');
  };
  try {
    report.sources = [...await freezeSources(evidence), ...await freezeOwnSources(evidence)];
    for (const [index, file] of original.originals.entries()) await evidence.file(`original-${index}.bin`, file.bytes);
    report.candidate = await installedIdentity(input.consumer);
    const socket = await lstat(socketPath, { bigint: true }); assert(socket.isSocket() && !socket.isSymbolicLink());
    assert.equal(String(socket.dev), original.report.socket.device); assert.equal(String(socket.ino), original.report.socket.inode);
    guard = installGuard({ socketPath, path: join(input.output, 'http-trace.jsonl'), records: original.observed,
      completedDeletes: [original.report.handoff.receipt.selected.target] });
    capture = await installEngineCapture({ socketPath, evidence });
    const node = (await installed(input.consumer, '@agen-ai/sandbox-docker', './node')).api;
    nodeApi = node;
    const createOwner = () => node.createDockerDesktopCoordinator({ helper: original.config.helper,
      routeAuthority: node.createDockerDesktopRouteAuthority(original.config.capabilities.network.routeAuthority) });
    const canonical = () => originalFileBytes(original.config.scenario.canonicalPath);
    wrong = createOwner();
    signals.assertCurrent();
    await wrongGeneration({ owner: wrong, generation: original.generation, canonical, observe: observed,
      retain(recovery) {
        owner = wrong;
        cleanup = cleanupOriginal({ original, node, owner, recovery, guard, report, evidence, save });
      } });
    await wrong.close({ timeoutMs: 60_000 });
    const actualImage = (await engine.request('GET', `/images/${input.fixtureImage}/json`)).data;
    assert.equal(actualImage.Id, input.fixtureImage); assert.equal(actualImage.Os, 'linux'); assert.equal(actualImage.Architecture, 'arm64');
    assert.deepEqual(actualImage.Config.Env, ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']);
    assert.equal(Object.keys(actualImage.Config.Volumes ?? {}).length, 0);
    fixture = createReplacement({ engine, guard, image: input.fixtureImage, selected: collision, checkpoint: report.fixture, save });
    signals.assertCurrent();
    await fixture.create(); report.before = await engineInventory(engine);
    owner = createOwner();
    const opened = await owner.reopenCleanup({ expectedGeneration: original.generation }, { timeoutMs: 60_000 }); assert.equal(opened.kind, 'opened');
    const recovery = opened.recovery; assert.equal(recovery.generation, original.generation);
    cleanup = cleanupOriginal({ original, node, owner, recovery, guard, report, evidence, save });
    const first = original.members.find(({ record }) => record.operationId === recovery.members[0]?.operationId); assert(first);
    await memberNegatives({ recovery, configuration: memberConfiguration(original, node, first),
      routeDescriptor: original.config.capabilities.network.routeAuthority, node, canonical, observe: observed, retain: cleanup.retain });
    guard.select({ kind: 'cleanup' }); await cleanup.finish();
    assert.equal(report.evidenceFailures.length, 0, 'Failed evidence does not authorize a fresh verifier.');
    guard.select({ kind: 'read_only' });
    report.cases.push({ name: 'known-original-id-preserves-different-same-name-id', result: await fixture.preserved() });
    report.afterOriginalCleanup = await engineInventory(engine);
    compareEngineInventory(report.before, report.afterOriginalCleanup, original.observed);
    await fixture.remove();
    report.absence = await exactAbsence(engine, original.observed);
    report.cleanupComplete = true;
    const childInput = { consumer: input.consumer, output: join(input.output, 'fresh-process'), originalInput: input.originalInput,
      originalReport: input.originalReport, canonical: input.canonical, settledRecords: report.settledRecords,
      expectedCandidate: report.candidate, expectedSources: report.sources.filter(({ original: path }) => !path.includes('/coordinator-negatives/'))
        .map(({ original: path, sha256 }) => ({ original: path, sha256 })) };
    const child = await evidence.file('fresh-process-input.json', childInput);
    signals.assertCurrent();
    report.freshProcess = await verifyFreshProcess({ executable: process.execPath,
      script: fileURLToPath(new URL('../coordinator-recovery/controller.mjs', import.meta.url)), mode: '--members-absent',
      inputPath: child.path, cwd: input.consumer, evidence });
    const fresh = await originalFile(join(childInput.output, 'report.json'), 4 * 1024 ** 2);
    assert.equal(fresh.value.status, 'pass'); assert.equal(fresh.value.reconcilePerformed, false);
    report.status = 'passed';
  } catch (error) { report.primaryFailure = failure(error); report.status = 'failed'; }
  finally {
    if (guard) await retainUntilFinished(finish, report, save);
    try {
      await assertOriginals([selected, ...original.originals], report.sources);
      assert.deepEqual(await installedIdentity(input.consumer), input.expectedCandidate);
      report.http = guard?.snapshot() ?? [];
      assert(!report.http.some(({ dispatch }) => dispatch === 'blocked'), 'A prohibited HTTP attempt invalidates qualification.');
      if (capture) { report.capture = await capture.close(); assert.equal(report.capture.completeness, 'complete'); }
    } catch (error) { report.evidenceFailures.push(failure(error)); report.status = 'failed'; }
    guard?.restore();
    report.evidenceFailures.push(...(guard?.failures() ?? []).map((error) => failure(error)));
    if (report.cleanupFailures.length || report.evidenceFailures.length || report.fixture.evidenceFailures?.length || report.interrupted) report.status = 'failed';
    report.finishedAt = new Date().toISOString(); await evidence.file('report.json', report); await evidence.close(); await save();
    signals.close();
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, cleanupComplete: report.cleanupComplete, output: input.output })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { assert.equal(process.argv.length, 3, 'Usage: node coordinator-negatives/recovery.mjs /absolute/input.json'); await runRecoveryNegatives(process.argv[2]); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
}
