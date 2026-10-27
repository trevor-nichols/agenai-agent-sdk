import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../../engine.mjs';
import { acquireJsonInput, physicalPath } from '../input.mjs';
import { appendObservation, failure, json, jsonWriter } from '../live/evidence.mjs';
import { settleOwnerCleanup } from '../live/owner-cleanup.mjs';
import { createFixtures, sha } from '../network/fixtures.mjs';
import { census } from '../network/resources.mjs';
import { acquireHostRoots, assertHostRootCurrent, cleanupCaseHost, cleanupHostRoots, verifyHostRoot } from '../preserve/host-roots.mjs';
import { combinedCaseNames, combinedScenarioBudget } from './budget.mjs';
import { faultCases } from './faults.mjs';
import { loadExample } from './installed.mjs';
import { siblingCase, workflowCases } from './scenarios.mjs';

const [path] = process.argv.slice(2); assert.equal(process.argv.length, 3);
const { value: config } = await acquireJsonInput(path, 256 * 1024);
assert.deepEqual(Object.keys(config).sort(), ['format', 'endpoint', 'profile', 'imageDigest', 'consumer', 'output', 'capabilities',
  'fixtureOwner', 'namespacePrefix', 'sourceIdentity', 'scenarioBudget', 'guestNodeVersion', 'endpointProjection', 'hostRoots', 'entrypoint'].sort());
assert.equal(config.format, 'agenai.sandbox-platform-combined-controller.v1');
assert.equal(config.capabilities.row, 'combined'); assert.equal(config.profile, config.capabilities.profile);
assert.deepEqual(combinedScenarioBudget(config.capabilities), config.scenarioBudget);
physicalPath(config.consumer); physicalPath(config.output);
assert.equal(await realpath(config.consumer), config.consumer); assert.equal(process.cwd(), config.consumer);
assert(fileURLToPath(import.meta.url).startsWith(`${config.consumer}/qualification/`));
for (const name of ['@agen-ai/sandbox', '@agen-ai/sandbox/node', '@agen-ai/sandbox-docker', '@agen-ai/sandbox-docker/node']) {
  assert(fileURLToPath(import.meta.resolve(name)).startsWith(`${config.consumer}/node_modules/`), 'Combined execution must resolve installed public packages.');
}
assert.match(config.fixtureOwner, /^[a-f0-9-]{36}$/u); assert.match(config.namespacePrefix, /^platform-combined-[a-f0-9]{8}-$/u);
assert.equal(config.endpointProjection.effectiveEndpoint, config.endpoint);
assert.equal(config.hostRoots.length, config.capabilities.transfers.hostRoots.length);
for (const [index, root] of config.hostRoots.entries()) {
  assert.equal(root.role, config.capabilities.transfers.hostRoots[index].role);
  assert.equal(root.parent, config.capabilities.transfers.hostRoots[index].parent); await assertHostRootCurrent(root);
}
await loadExample(config);
const cancellation = new AbortController(), runs = [];
const interrupt = () => cancellation.abort(new Error('Installed combined qualification interrupted.'));
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
await mkdir(config.output, { mode: 0o700 });
const report = { format: 'agenai.sandbox-platform-combined.v1', status: 'running', profile: config.profile,
  imageDigest: config.imageDigest, guestNodeVersion: config.guestNodeVersion, sourceIdentity: config.sourceIdentity,
  entrypoint: config.entrypoint, scenarioBudget: config.scenarioBudget, namespacePrefix: config.namespacePrefix,
  fixtureOwner: config.fixtureOwner, endpointProjection: config.endpointProjection, startedAt: new Date().toISOString(),
  hostRoots: [], cases: [], selectedCases: [], requirements: {}, cleanupFailures: [],
  scope: 'Installed public fixed generic workflow. IPv4 listener controls and verified TLS; caller-owned route quiescence. No provider, account or replay authority.' };
const writer = jsonWriter(join(config.output, 'combined-report.json'));
const saveReport = () => { assert(Buffer.byteLength(json(report)) <= 1024 ** 2); return writer(report); };
const rawEngine = new Engine(config.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs, outputBytes: 4 * 1024 ** 2 });
const fence = async () => {
  const socket = await lstat(config.endpoint.slice(7), { bigint: true }); assert(socket.isSocket() && !socket.isSymbolicLink());
  assert.deepEqual({ device: String(socket.dev), inode: String(socket.ino), mode: String(socket.mode), uid: String(socket.uid), gid: String(socket.gid) },
    config.endpointProjection.proxySocket, 'Original platform proxy identity changed.');
  assert.equal((await rawEngine.request('GET', '/info')).data.ID, config.endpointProjection.engineId);
};
const engine = { async request(...args) { await fence(); return rawEngine.request(...args); },
  async hijack(...args) { await fence(); return rawEngine.hijack(...args); } };
const context = { config, engine, signal: cancellation.signal, hostRoots: [],
  async probeSource() {
    return (await readFile(new URL('../../../capabilities/desktop/guest.mjs', import.meta.url), 'utf8'))
      + `\nconst command=JSON.parse(process.argv[1]);command.timeoutMs=${config.capabilities.limits.requestMs - 250};try{process.stdout.write(JSON.stringify({ok:true,result:await runGuest(command)})+'\\n');}catch(error){process.stdout.write(JSON.stringify({ok:false,error:{name:error.name,code:error.code??null,message:error.message}})+'\\n');}\n`;
  },
  async assertNoActiveOwners() {
    for (const run of runs) {
      for (const entry of run.owners) if (entry.owner) assert.equal(entry.owner.state.kind, 'destroyed');
      if (run.evidence.childOwner) assert(run.evidence.childOwner.quiescent && run.evidence.childOwner.cleanupKind,
        'An original combined controller or its recovery owner remains active.');
    }
  } };

async function cleanup(run) {
  for (const retained of run.localCleanupOwners) {
    try { await retained.retryCleanup(); await run.observe({ kind: 'original-public-workflow-cleanup-retried', owner: retained.owner.recoveryRecord }); }
    catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  }
  for (const entry of [...run.owners].reverse()) if (entry.owner) {
    try {
      await run.settleCleanup(entry, 'destroy'); assert.equal(entry.owner.state.kind, 'destroyed');
      run.evidence.owners.find(({ namespace }) => namespace === entry.namespace).finalRecord = entry.owner.recoveryRecord;
      run.evidence.census.push(...await census(engine, entry.owner.recoveryRecord, 'combined-final-exact-absence', true));
    } catch (error) { run.evidence.cleanupErrors.push({ namespace: entry.namespace, ...failure(error) }); }
  }
  for (const session of run.sessions) try { await run.observe({ kind: 'sole-isolated-sibling-reader-joined', result: await session.join() }); }
  catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  for (const proxy of [...run.proxies].reverse()) try { await proxy.close(); }
  catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  for (const action of run.afterCleanup) try { await action(); }
  catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  if (run.hostRoot) try { await verifyHostRoot(run.hostRoot); }
  catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  if (!run.evidence.cleanupErrors.length) try { await cleanupCaseHost(run); }
  catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  run.evidence.cleanupComplete = run.evidence.cleanupErrors.length === 0;
  if (!run.evidence.cleanupComplete) run.evidence.status = 'failed'; await run.save();
}

try {
  await saveReport(); context.hostRoots = await acquireHostRoots(context, report, saveReport);
  context.fixtures = await createFixtures(context); await context.fixtures.startBase();
  const cases = [...workflowCases(context), siblingCase(context), ...faultCases(context)];
  assert.deepEqual(cases.map(([name]) => name), combinedCaseNames(config.capabilities));
  report.selectedCases = cases.map(([name]) => name);
  report.requirements = { D15: cases.slice(0, config.hostRoots.length * 2 + 1).map(([name]) => name),
    D16: cases.slice(config.hostRoots.length * 2).map(([name]) => name),
    ...(config.profile === 'linux-x64' ? { D17: cases.map(([name]) => name) } : {}) };
  await saveReport();
  for (const [index, [name, action]] of cases.entries()) {
    cancellation.signal.throwIfAborted(); const caseId = `c${String(index + 1).padStart(2, '0')}`;
    const directory = join(config.output, caseId); await mkdir(directory, { mode: 0o700 });
    const reportPath = join(directory, 'case-report.json'), writeCase = jsonWriter(reportPath);
    const evidence = { name, directory, status: 'running', startedAt: new Date().toISOString(), owners: [], observations: [], census: [], cleanupErrors: [] };
    const run = { caseId, directory, evidence, owners: [], sessions: [], proxies: [], localCleanupOwners: [], afterCleanup: [],
      save() { assert(Buffer.byteLength(json(evidence)) <= 8 * 1024 ** 2); return writeCase(evidence); },
      observe: (value) => appendObservation(evidence, value, run.save),
      settleCleanup: (entry, operation) => settleOwnerCleanup(entry.owner, operation, { cleanupMs: config.capabilities.limits.cleanupMs,
        observe: (value) => run.observe({ namespace: entry.namespace, ...value }) }) };
    runs.push(run); const summary = { name, reportPath, status: 'running', cleanupComplete: false };
    report.cases.push(summary); await run.save(); await saveReport();
    const deadline = new AbortController(); context.signal = AbortSignal.any([cancellation.signal, deadline.signal]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true; deadline.abort(new Error('Captured combined scenario deadline.'));
      for (const entry of run.owners) if (entry.owner) void entry.owner.stop().catch(() => {});
    }, config.capabilities.limits.scenarioMs);
    try { await action(run); assert.equal(timedOut, false); evidence.status = 'passed'; }
    catch (error) { evidence.status = 'failed'; evidence.failure = failure(error); }
    finally {
      clearTimeout(timer); await cleanup(run); evidence.finishedAt = new Date().toISOString(); await run.save();
      const bytes = await readFile(reportPath); Object.assign(summary, { status: evidence.status,
        cleanupComplete: evidence.cleanupComplete, bytes: bytes.length, sha256: sha(bytes),
        originalReservations: run.owners.filter(({ owner }) => owner).length + Number(evidence.childOwner?.originalReservationConfirmed ?? false) });
      await saveReport();
    }
    process.stdout.write(JSON.stringify({ event: 'case_completed', name, status: evidence.status, cleanupComplete: evidence.cleanupComplete }) + '\n');
    if (evidence.status !== 'passed' || !evidence.cleanupComplete) break;
  }
} catch (error) { report.failure = failure(error); }
finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  let closed = true;
  try { await context.assertNoActiveOwners(); } catch (error) { closed = false; report.cleanupFailures.push(failure(error)); }
  try { if (context.fixtures) await context.fixtures.close({ releaseNetworks: closed }); }
  catch (error) { report.cleanupFailures.push(failure(error)); }
  report.fixtures = context.fixtures?.record ?? null;
  report.hostCleanup = await cleanupHostRoots(report, saveReport, closed && report.cases.every(({ cleanupComplete }) => cleanupComplete));
  report.matrix = Object.fromEntries(Object.entries(report.requirements).map(([requirement, names]) => [requirement, {
    status: names.every((name) => report.cases.some((entry) => entry.name === name && entry.status === 'passed' && entry.cleanupComplete)) ? 'passed' : 'failed', cases: names,
  }]));
  report.status = report.cases.length === combinedCaseNames(config.capabilities).length
    && report.cases.every((entry) => entry.status === 'passed' && entry.cleanupComplete
      && entry.originalReservations === (entry.name === 'simultaneous-sibling-isolation' ? 2 : 1))
    && report.fixtures?.closed && report.fixtures.controlFailures.length === 0 && report.hostCleanup.complete
    && !report.failure && !report.cleanupFailures.length ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString(); await saveReport();
}
if (report.status !== 'passed') process.exitCode = 1;
process.stdout.write(JSON.stringify({ status: report.status, report: join(config.output, 'combined-report.json') }) + '\n');
