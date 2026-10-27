import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../../engine.mjs';
import { acquireJsonInput, physicalPath } from '../input.mjs';
import { liveScenarioBudget } from './budget.mjs';
import { confinementCases } from './confinement.mjs';
import { crashCases } from './crash.mjs';
import { census, failure, jsonWriter } from './evidence.mjs';
import { faultCases } from './faults.mjs';
import { lifecycleCases } from './lifecycle.mjs';
import { operationCases } from './operations.mjs';
import { settleOwnerCleanup } from './owner-cleanup.mjs';
import { closeSentinels } from './sentinel.mjs';

const [path] = process.argv.slice(2);
assert.equal(process.argv.length, 3, 'Expected one captured live controller configuration.');
const { value: config } = await acquireJsonInput(path, 256 * 1024);
assert.deepEqual(Object.keys(config).sort(), ['format', 'endpoint', 'profile', 'imageDigest', 'consumer', 'output',
  'capabilities', 'fixtureOwner', 'namespacePrefix', 'sourceIdentity', 'scenarioBudget', 'guestNodeVersion'].sort());
assert.equal(config.format, 'agenai.sandbox-platform-live-controller.v1');
assert.equal(config.capabilities.row, 'live-files'); assert.equal(config.profile, config.capabilities.profile);
assert.deepEqual(liveScenarioBudget(config.capabilities), config.scenarioBudget);
physicalPath(config.consumer); physicalPath(config.output);
assert.equal(await realpath(config.consumer), config.consumer); assert.equal(process.cwd(), config.consumer);
assert(fileURLToPath(import.meta.url).startsWith(`${config.consumer}/qualification/`), 'Native orchestration must run from its independent copied consumer.');
for (const name of ['@agen-ai/sandbox', '@agen-ai/sandbox-docker']) {
  const resolved = fileURLToPath(import.meta.resolve(name));
  assert(resolved.startsWith(`${config.consumer}/node_modules/`), 'Only the installed public SDK may satisfy native orchestration imports.');
}
assert.match(config.fixtureOwner, /^[a-f0-9-]{36}$/u);
assert.match(config.namespacePrefix, /^platform-live-[a-f0-9]{8}-$/u);
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error('Installed live qualification interrupted.'));
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
await mkdir(config.output, { mode: 0o700 });
const report = { format: 'agenai.sandbox-platform-live.v1', status: 'running', profile: config.profile,
  imageDigest: config.imageDigest, guestNodeVersion: config.guestNodeVersion, filesystem: config.capabilities.filesystem, sourceIdentity: config.sourceIdentity,
  installedImports: ['@agen-ai/sandbox', '@agen-ai/sandbox-docker'], scenarioBudget: config.scenarioBudget,
  fixtureOwner: config.fixtureOwner, namespacePrefix: config.namespacePrefix,
  network: 'isolated', startedAt: new Date().toISOString(), cases: [],
  counterEncoding: 'bigint is canonical decimal; null is unavailable acknowledgement',
  limitations: [{ mechanism: 'mount-crossing', status: 'unsupported_fixture',
    reason: 'Unprivileged workload mount attempt is retained separately; no successful crossing fixture is claimed.' }],
  scope: 'Exact selected controller/daemon/workload/helper tuple, public installed SDK and controlled processes; no provider, account or model prerequisite.' };
const saveReport = jsonWriter(join(config.output, 'live-report.json'));
const engine = new Engine(config.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs,
  outputBytes: 4 * 1024 ** 2 });
const baseContext = { config, engine, signal: cancellation.signal };
const groups = { operations: operationCases(baseContext), confinement: confinementCases(baseContext),
  lifecycle: lifecycleCases(baseContext), faults: faultCases(baseContext), crash: crashCases(baseContext) };
const selected = Object.values(groups).flat();
report.selectedCases = selected.map(([name]) => name);
report.requirements = { D05: groups.operations.map(([name]) => name),
  D06: groups.confinement.map(([name]) => name), D07: [...groups.lifecycle, ...groups.faults, ...groups.crash].map(([name]) => name) };
await saveReport(report);

async function settleCleanup(run, entry, operation) {
  await settleOwnerCleanup(entry.owner, operation, { cleanupMs: config.capabilities.limits.cleanupMs,
    async observe(observation) {
      run.evidence.observations.push({ kind: 'original-owner-cleanup-observation', namespace: entry.namespace, ...observation });
      await run.save();
    } });
}

async function cleanup(run) {
  let sentinelsClosed = true;
  try { await closeSentinels(run, baseContext); }
  catch (error) { sentinelsClosed = false; run.evidence.cleanupErrors.push(failure(error)); }
  for (const entry of [...run.owners].reverse()) {
    try {
      if (!sentinelsClosed) {
        await run.settleCleanup(entry, 'stop');
        throw new Error('Workspace destruction retained until its sentinel fixture ownership settles.');
      }
      await run.settleCleanup(entry, 'destroy');
      entry.record = entry.owner.recoveryRecord;
      run.evidence.owners.find(({ namespace }) => namespace === entry.namespace).finalRecord = entry.record;
      run.evidence.census.push(...await census(engine, entry.record, 'case-final-absence', true));
    } catch (error) { run.evidence.cleanupErrors.push({ namespace: entry.namespace, ...failure(error) }); }
  }
  for (const session of run.sessions) {
    try { run.evidence.observations.push({ kind: 'sole-guest-reader-joined', result: await session.join() }); }
    catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  for (const proxy of [...run.proxies].reverse()) {
    try { await proxy.close(); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  for (const after of run.afterCleanup) {
    try { await after(); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  if (run.evidence.crashOwner && (!run.evidence.crashOwner.controllerQuiescent || !run.evidence.crashOwner.recovered)) {
    run.evidence.cleanupErrors.push({ name: 'RetainedControllerOwnership', ...run.evidence.crashOwner });
  }
  run.evidence.cleanupComplete = run.evidence.cleanupErrors.length === 0;
  if (!run.evidence.cleanupComplete) run.evidence.status = 'failed';
  await run.save();
}

try {
  for (let index = 0; index < selected.length; index++) {
    const [name, action] = selected[index];
    cancellation.signal.throwIfAborted();
    const directory = join(config.output, `c${String(index + 1).padStart(2, '0')}`);
    await mkdir(directory, { mode: 0o700 });
    const evidence = { name, directory, status: 'running', owners: [], fixtures: [], observations: [], census: [], cleanupErrors: [] };
    const writeCase = jsonWriter(join(directory, 'case-report.json'));
    const run = { directory, evidence, owners: [], sessions: [], fixtures: [], proxies: [], afterCleanup: [],
      save: () => writeCase(evidence), settleCleanup: (entry, operation) => settleCleanup(run, entry, operation) };
    report.cases.push(evidence); await run.save(); await saveReport(report);
    const deadline = new AbortController(); let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true; deadline.abort(new Error('Live scenario deadline.'));
      for (const entry of run.owners) void entry.owner.stop().catch(() => {});
    }, config.capabilities.limits.scenarioMs);
    // Each case closes over one context. Its signal joins the outer interrupt and scenario deadline.
    const signal = AbortSignal.any([cancellation.signal, deadline.signal]);
    baseContext.signal = signal;
    try {
      await action(run);
      assert.equal(timedOut, false, 'Scenario exceeded its captured deadline.');
      evidence.status = 'passed';
    } catch (error) { evidence.status = 'failed'; evidence.failure = failure(error); }
    finally { clearTimeout(timer); await cleanup(run); await saveReport(report); }
    process.stdout.write(`${JSON.stringify({ event: 'case_completed', name, status: evidence.status, cleanupComplete: evidence.cleanupComplete })}\n`);
    if (!evidence.cleanupComplete) break;
  }
} catch (error) { report.failure = failure(error); }
finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  report.matrix = Object.fromEntries(Object.entries(report.requirements).map(([row, names]) => [row, {
    status: names.every((name) => report.cases.some((entry) => entry.name === name && entry.status === 'passed' && entry.cleanupComplete)) ? 'passed' : 'failed', cases: names,
  }]));
  report.status = report.cases.length === selected.length && report.cases.every(({ status, cleanupComplete }) => status === 'passed' && cleanupComplete)
    && !report.failure ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString(); await saveReport(report);
}
if (report.status !== 'passed') process.exitCode = 1;
process.stdout.write(`${JSON.stringify({ status: report.status, report: join(config.output, 'live-report.json') })}\n`);
