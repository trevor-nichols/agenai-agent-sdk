import { nativeControllerReady } from '../../native-controller.mjs';
import { cleanupDiagnostic, finishRunCleanup, finishSuiteCleanup } from '../cleanup/obligations.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../../engine.mjs';
import { acquireJsonInput, physicalPath } from '../input.mjs';
import { liveScenarioBudget } from '../live/budget.mjs';
import { census, failure, json, jsonWriter } from '../live/evidence.mjs';
import { originalOwnerCleanup, settleOwnerCleanup } from '../live/owner-cleanup.mjs';
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
await nativeControllerReady();
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

async function cleanup(run) {
  await finishRunCleanup(run, { timeoutMs: config.capabilities.limits.cleanupMs,
    readerKind: 'sole-preserving-guest-reader-joined', census: (entry) => census(engine, entry.owner.recoveryRecord, 'case-final-absence', true),
    async beforeOwners(cleanup) {
      for (const [index, retained] of run.localCleanupOwners.entries()) {
        await cleanup.step(`directory-${index}`, () => retained.owner.retryCleanup(), { retryRejected: true });
        retained.errorEvidence.complete = true;
      }
      await cleanup.step('sentinels', () => closeSentinels(run, context),
        { retryRejected: true, complete: () => run.fixtures.every(({ removed }) => removed) });
    }, async after(cleanup) {
      if (run.hostRoot) await cleanup.step('host-root-proof', () => verifyHostRoot(run.hostRoot), { proof: true });
      await cleanup.step('case-host', () => cleanupCaseHost(run), { retryRejected: true, complete: () => run.evidence.host?.removed });
    } });
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
      for (const entry of run.owners) void originalOwnerCleanup(entry.owner, 'stop').catch(() => {});
    }, config.capabilities.limits.scenarioMs);
    try { await action(run); assert.equal(timedOut, false); evidence.status = 'passed'; }
    catch (error) { retainDirectoryCleanup(run, error); evidence.status = 'failed'; evidence.failure = failure(error); }
    finally {
      clearTimeout(timer); await cleanup(run); evidence.finishedAt = new Date().toISOString(); await run.save();
      const bytes = await readFile(reportPath); assert(bytes.length <= 2 * 1024 ** 2);
      Object.assign(summary, { status: evidence.status, cleanupComplete: evidence.cleanupComplete, variant: evidence.variant,
        bytes: bytes.length, sha256: sha(bytes) }); await saveReport();
    }
    cleanupDiagnostic({ event: 'case_completed', name, status: evidence.status, cleanupComplete: evidence.cleanupComplete });
    if (evidence.status !== 'passed' || !evidence.cleanupComplete) break;
  }
} catch (error) { report.failure = failure(error); }
finally {
  await finishSuiteCleanup(report, { timeoutMs: config.capabilities.limits.cleanupMs, save: saveReport,
    async operation(cleanup) {
      await cleanup.step('host-roots', async () => {
        report.hostCleanup = await cleanupHostRoots(report, saveReport, report.cases.every(({ cleanupComplete }) => cleanupComplete));
        assert(report.hostCleanup.complete);
      }, { retryRejected: true, complete: () => report.hostRoots.every(({ created, removed }) => !created || removed) });
    } });
  report.matrix = Object.fromEntries(Object.entries(report.requirements).map(([row, names]) => [row, {
    status: names.length > 0 && names.every((name) => report.cases.some((entry) => entry.name === name && entry.status === 'passed' && entry.cleanupComplete)) ? 'passed' : 'failed', cases: names,
  }]));
  report.status = report.selectedCases?.length === report.cases.length && report.cases.every(({ status, cleanupComplete }) => status === 'passed' && cleanupComplete)
    && report.hostCleanup.complete && !report.cleanupFailures.length && !report.failure ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString(); await saveReport();
}
if (report.status !== 'passed') process.exitCode = 1;
process.stdout.write(`${JSON.stringify({ status: report.status, report: join(config.output, 'preserve-report.json') })}\n`);
