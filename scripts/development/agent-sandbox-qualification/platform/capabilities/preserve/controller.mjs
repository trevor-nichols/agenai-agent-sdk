import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../../engine.mjs';
import { acquireJsonInput, physicalPath } from '../input.mjs';
import { liveScenarioBudget } from '../live/budget.mjs';
import { census, failure, json, jsonWriter } from '../live/evidence.mjs';
import { settleOwnerCleanup } from '../live/owner-cleanup.mjs';
import { closeSentinels } from '../live/sentinel.mjs';
import { admissionCases } from './admission.mjs';
import { acquireHostRoots, assertHostRootCurrent, cleanupCaseHost, cleanupHostRoots, verifyHostRoot } from './host-roots.mjs';
import { hostFailureCases } from './host-failures.mjs';
import { roundTripCases } from './roundtrip.mjs';
import { retainDirectoryCleanup, sha } from './shared.mjs';

const [path] = process.argv.slice(2);
assert.equal(process.argv.length, 3, 'Expected one captured preserving controller configuration.');
const { value: config } = await acquireJsonInput(path, 256 * 1024);
assert.deepEqual(Object.keys(config).sort(), ['format', 'endpoint', 'profile', 'imageDigest', 'consumer', 'output', 'capabilities',
  'fixtureOwner', 'namespacePrefix', 'sourceIdentity', 'scenarioBudget', 'guestNodeVersion', 'hostRoots'].sort());
assert.equal(config.format, 'agenai.sandbox-platform-preserve-controller.v1');
assert.equal(config.capabilities.row, 'preserve-internal'); assert.equal(config.profile, config.capabilities.profile);
assert.deepEqual(liveScenarioBudget(config.capabilities), config.scenarioBudget);
physicalPath(config.consumer); physicalPath(config.output);
assert.equal(await realpath(config.consumer), config.consumer); assert.equal(process.cwd(), config.consumer);
assert(fileURLToPath(import.meta.url).startsWith(`${config.consumer}/qualification/`));
for (const name of ['@agen-ai/sandbox', '@agen-ai/sandbox/node', '@agen-ai/sandbox-docker']) {
  assert(fileURLToPath(import.meta.resolve(name)).startsWith(`${config.consumer}/node_modules/`), 'Preserving execution requires installed public SDK imports.');
}
assert.match(config.fixtureOwner, /^[a-f0-9-]{36}$/u);
assert.match(config.namespacePrefix, /^platform-preserve-[a-f0-9]{8}-$/u);
assert.equal(config.hostRoots.length, config.capabilities.transfers.hostRoots.length);
for (const [index, root] of config.hostRoots.entries()) {
  assert.equal(root.role, config.capabilities.transfers.hostRoots[index].role);
  assert.equal(root.parent, config.capabilities.transfers.hostRoots[index].parent); await assertHostRootCurrent(root);
}
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error('Installed preserving qualification interrupted.'));
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
await mkdir(config.output, { mode: 0o700 });
const report = { format: 'agenai.sandbox-platform-preserve.v1', status: 'running', profile: config.profile,
  imageDigest: config.imageDigest, guestNodeVersion: config.guestNodeVersion, filesystem: config.capabilities.filesystem,
  installedImports: ['@agen-ai/sandbox', '@agen-ai/sandbox/node', '@agen-ai/sandbox-docker'], sourceIdentity: config.sourceIdentity,
  scenarioBudget: config.scenarioBudget, budgetRationale: 'The private sentinel case simultaneously owns two private SDK workspaces/helpers, one independent volume sentinel and the daemon observer.',
  fixtureOwner: config.fixtureOwner, namespacePrefix: config.namespacePrefix, startedAt: new Date().toISOString(), network: 'isolated',
  hostRoots: [], cases: [], requirements: {},
  caseReports: 'Individual bounded case reports retain complete observations and recovery records; this report binds their exact bytes and hashes.',
  contracts: { links: 'Confined dangling links and exact inert cycles preserve raw text; escaping and unresolved over-bound graphs reject.',
    import: 'Failed imports can retain entered regular effects while withholding links and fencing execution; no rollback promise.',
    publication: 'Host files publish only after complete validation; native representation failures retain their original input identity.' } };
const writeReport = jsonWriter(join(config.output, 'preserve-report.json'));
const saveReport = () => { assert(Buffer.byteLength(json(report)) <= 1024 ** 2); return writeReport(report); };
const engine = new Engine(config.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs, outputBytes: 4 * 1024 ** 2 });
const context = { config, engine, signal: cancellation.signal, hostRoots: [] };

async function retryDirectory(run, retained) {
  if (retained.errorEvidence.complete) return;
  const deadline = performance.now() + config.capabilities.limits.cleanupMs; let lastFailure;
  for (let attempt = 1; attempt <= 8 && performance.now() < deadline; attempt++) {
    const observation = { attempt, startedAt: new Date().toISOString(), status: 'entered' };
    retained.errorEvidence.attempts.push(observation); await run.save(); let timer;
    try {
      if (performance.now() >= deadline) throw new Error('Original directory cleanup observation budget expired before retry entry.');
      await Promise.race([retained.owner.retryCleanup(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Original directory cleanup remains owned after its captured observation budget.')),
          Math.max(1, deadline - performance.now()));
      })]);
      observation.status = 'fulfilled'; retained.errorEvidence.complete = true;
    } catch (error) { lastFailure = error; observation.status = 'rejected'; observation.failure = failure(error); }
    finally { clearTimeout(timer); observation.finishedAt = new Date().toISOString(); await run.save(); }
    if (retained.errorEvidence.complete) return;
    if (performance.now() < deadline) await delay(Math.min(100, deadline - performance.now()));
  }
  throw new Error('The exact original directory cleanup owner remains retained.', { cause: lastFailure });
}

async function cleanup(run) {
  for (const before of [...run.beforeCleanup].reverse()) {
    try { await before(); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  for (const retained of run.localCleanupOwners) {
    try { await retryDirectory(run, retained); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  let sentinelsClosed = true;
  try { await closeSentinels(run, context); } catch (error) { sentinelsClosed = false; run.evidence.cleanupErrors.push(failure(error)); }
  for (const entry of [...run.owners].reverse()) {
    try {
      await run.settleCleanup(entry, sentinelsClosed ? 'destroy' : 'stop');
      assert(sentinelsClosed, 'Workspace destruction remains owned until the independent volume fixture retires.');
      assert.equal(entry.owner.state.kind, 'destroyed');
      const ownerEvidence = run.evidence.owners.find(({ namespace }) => namespace === entry.namespace);
      ownerEvidence.finalRecord = entry.owner.recoveryRecord;
      run.evidence.census.push(...await census(engine, entry.owner.recoveryRecord, 'case-final-absence', true));
    } catch (error) { run.evidence.cleanupErrors.push({ namespace: entry.namespace, ...failure(error) }); }
  }
  for (const session of run.sessions) {
    try { run.evidence.observations.push({ kind: 'sole-preserving-guest-reader-joined', result: await session.join() }); }
    catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  for (const proxy of [...run.proxies].reverse()) {
    try { await proxy.close(); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  for (const after of run.afterCleanup) {
    try { await after(); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  try { if (run.hostRoot) await verifyHostRoot(run.hostRoot); }
  catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  if (run.evidence.cleanupErrors.length === 0) {
    try { await cleanupCaseHost(run); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  run.evidence.cleanupComplete = run.evidence.cleanupErrors.length === 0;
  if (!run.evidence.cleanupComplete) run.evidence.status = 'failed';
  await run.save();
}

try {
  await saveReport(); context.hostRoots = await acquireHostRoots(context, report, saveReport);
  const groups = { D08: roundTripCases(context), D09: admissionCases(context), D10: hostFailureCases(context) };
  const selected = Object.values(groups).flat(); assert(selected.length > 0 && selected.length <= 256);
  report.selectedCases = selected.map(([name]) => name); assert.equal(new Set(report.selectedCases).size, selected.length);
  report.requirements = Object.fromEntries(Object.entries(groups).map(([row, cases]) => [row, cases.map(([name]) => name)])); await saveReport();
  for (let index = 0; index < selected.length; index++) {
    cancellation.signal.throwIfAborted(); const [name, action] = selected[index];
    const caseId = `c${String(index + 1).padStart(3, '0')}`; const directory = join(config.output, caseId);
    await mkdir(directory, { mode: 0o700 }); const reportPath = join(directory, 'case-report.json');
    const evidence = { name, directory, status: 'running', startedAt: new Date().toISOString(), owners: [], fixtures: [],
      observations: [], census: [], localDirectoryCleanup: [], cleanupErrors: [] };
    const writeCase = jsonWriter(reportPath);
    const run = { directory, caseId, evidence, owners: [], sessions: [], fixtures: [], proxies: [], localCleanupOwners: [], beforeCleanup: [], afterCleanup: [],
      save: () => { assert(Buffer.byteLength(json(evidence)) <= 2 * 1024 ** 2); return writeCase(evidence); },
      settleCleanup: (entry, operation) => settleOwnerCleanup(entry.owner, operation, { cleanupMs: config.capabilities.limits.cleanupMs,
        async observe(observation) { evidence.observations.push({ namespace: entry.namespace, ...observation }); await run.save(); } }) };
    const summary = { name, directory, reportPath, status: 'running', cleanupComplete: false };
    report.cases.push(summary); await run.save(); await saveReport();
    const deadline = new AbortController(); let timedOut = false;
    context.signal = AbortSignal.any([cancellation.signal, deadline.signal]);
    const timer = setTimeout(() => {
      timedOut = true; deadline.abort(new Error('Preserving scenario deadline.'));
      for (const entry of run.owners) void entry.owner.stop().catch(() => {});
    }, config.capabilities.limits.scenarioMs);
    try { await action(run); assert.equal(timedOut, false); evidence.status = 'passed'; }
    catch (error) { retainDirectoryCleanup(run, error); evidence.status = 'failed'; evidence.failure = failure(error); }
    finally {
      clearTimeout(timer); await cleanup(run); evidence.finishedAt = new Date().toISOString(); await run.save();
      const bytes = await readFile(reportPath); assert(bytes.length <= 2 * 1024 ** 2);
      Object.assign(summary, { status: evidence.status, cleanupComplete: evidence.cleanupComplete, variant: evidence.variant,
        bytes: bytes.length, sha256: sha(bytes) }); await saveReport();
    }
    process.stdout.write(`${JSON.stringify({ event: 'case_completed', name, status: evidence.status, cleanupComplete: evidence.cleanupComplete })}\n`);
    if (!evidence.cleanupComplete) break;
  }
} catch (error) { report.failure = failure(error); }
finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  report.hostCleanup = await cleanupHostRoots(report, saveReport, report.cases.every(({ cleanupComplete }) => cleanupComplete));
  report.matrix = Object.fromEntries(Object.entries(report.requirements).map(([row, names]) => [row, {
    status: names.length > 0 && names.every((name) => report.cases.some((entry) => entry.name === name && entry.status === 'passed' && entry.cleanupComplete)) ? 'passed' : 'failed', cases: names,
  }]));
  report.status = report.selectedCases?.length === report.cases.length && report.cases.every(({ status, cleanupComplete }) => status === 'passed' && cleanupComplete)
    && report.hostCleanup.complete && !report.failure ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString(); await saveReport();
}
if (report.status !== 'passed') process.exitCode = 1;
process.stdout.write(`${JSON.stringify({ status: report.status, report: join(config.output, 'preserve-report.json') })}\n`);
