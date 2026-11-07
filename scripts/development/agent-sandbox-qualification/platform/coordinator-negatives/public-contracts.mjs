import assert from 'node:assert/strict';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importInstalled, installedIdentity } from '../../scalability/identity.mjs';
import { memberConfiguration, originalFile } from '../coordinator-recovery/common.mjs';
import { absolute, Evidence, failure } from '../coordinator/evidence.mjs';
import { memberNegatives } from './cases.mjs';
import { cleanupOriginal } from './cleanup.mjs';

async function run(inputPath) {
  const selected = await originalFile(absolute(inputPath), 1024 ** 2), input = selected.value;
  assert.deepEqual(Object.keys(input).sort(), ['consumer', 'template', 'output'].sort());
  const template = await originalFile(absolute(input.template), 1024 ** 2);
  const evidence = new Evidence(absolute(input.output)); await evidence.initialize(selected.bytes);
  const candidate = await installedIdentity(absolute(input.consumer));
  const sandbox = (await importInstalled(input.consumer, '@agen-ai/sandbox')).api;
  const backend = (await importInstalled(input.consumer, '@agen-ai/sandbox', './backend')).api;
  const docker = (await importInstalled(input.consumer, '@agen-ai/sandbox-docker')).api;
  const node = (await importInstalled(input.consumer, '@agen-ai/sandbox-docker', './node')).api;
  const report = { status: 'running', scope: 'Source qualifier calls through actual installed public configuration and neutral reconciliation parsers. No Engine/native recovery result.',
    input: selected.identity, template: template.identity, candidate, cases: [], configurationParses: 0, neutralReconciliations: 0,
    transportAttempts: 0, negativeFailure: null, cleanupFailure: null, settledRecords: [], evidenceFailures: [] };
  const request = http.request, get = http.get;
  http.request = http.get = () => { report.transportAttempts += 1; throw new Error('Public contract proof forbids every HTTP dispatch.'); };
  syncBuiltinESMExports();
  try {
    const digest = `sha256:${'a'.repeat(64)}`;
    const record = sandbox.parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'contract-only', backendRevision: 'contract-v1',
      namespace: 'coordinator-contract', operationId: 'ed902f37-52eb-4af9-ae99-7b803ec740de', sandboxId: 'docker-ed902f37-52eb-4af9-ae99-7b803ec740de',
      imageDigest: template.value.platform.sourceImage, policyDigest: digest, configurationDigest: digest, phase: 'stopped',
      authority: { kind: 'verified', backendIdentity: template.value.capabilities.network.routeAuthority.engine.id },
      resources: [{ role: 'compute', name: 'coordinator-contract-compute', identity: { kind: 'identified', id: 'b'.repeat(64), fingerprint: digest } }] });
    const original = { config: template.value, generation: '0546bb39-02df-49aa-ae63-9cf188ed8cc5',
      members: [{ member: { label: 'a' }, record }] };
    const configuration = memberConfiguration(original, node, original.members[0]);
    docker.createDockerSandboxBackend(configuration);
    const canonical = Buffer.from('original canonical bytes retained');
    const reconcile = (supplied, options, result) => backend.reconcileSandboxRecovery({ backendId: record.backendId, backendRevision: record.backendRevision,
      async reconcile() { report.neutralReconciliations += 1; return result; } }, supplied, options);
    const recovery = { members: [record], async reconcile(value, options) {
      if (this !== recovery) throw new TypeError('Cleanup reconciliation requires its original recovery capability.');
      if (!value.record) throw new TypeError('Cleanup requires original member configuration and canonical record.');
      docker.createDockerSandboxBackend(value.configuration); report.configurationParses += 1;
      return reconcile(value.record, options, { kind: 'conflict', reason: 'Contract-only driver; no native member authority is provided.' });
    } };
    try {
      await memberNegatives({ recovery, configuration, routeDescriptor: template.value.capabilities.network.routeAuthority, node,
        canonical: async () => canonical, observe: async (value) => { report.cases.push(value); }, retain() { assert.fail('No native owner exists in the public parser proof.'); } });
      assert.equal(report.configurationParses, 3); assert.equal(report.neutralReconciliations, 3);
    } catch (error) { report.negativeFailure = failure(error); }
    const owner = { state: { kind: 'recovering' }, async close() { this.state = { kind: 'closed', result: 'clean', generation: original.generation }; } };
    const cleanupReport = { settledRecords: [], evidenceFailures: [] };
    const cleanup = cleanupOriginal({ original, node, owner, guard: { select() {} }, evidence, report: cleanupReport, async save() {},
      recovery: { members: [record], reconcile: (value, options) => reconcile(value.record, options, { kind: 'absent', record: { ...record, phase: 'destroyed' } }) } });
    try { await cleanup.finish(); } catch (error) { report.cleanupFailure = failure(error); }
    report.settledRecords = cleanupReport.settledRecords; report.evidenceFailures.push(...cleanupReport.evidenceFailures);
    if (!report.negativeFailure && !report.cleanupFailure) assert.equal(report.neutralReconciliations, 4);
    assert.equal(report.transportAttempts, 0);
    assert.deepEqual(await installedIdentity(input.consumer), candidate);
    report.status = !report.negativeFailure && !report.cleanupFailure && !report.evidenceFailures.length ? 'passed' : 'failed';
  } finally {
    http.request = request; http.get = get; syncBuiltinESMExports();
    await evidence.file('report.json', report); await evidence.close();
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, output: input.output, negativeFailure: report.negativeFailure, cleanupFailure: report.cleanupFailure })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { assert.equal(process.argv.length, 3, 'Usage: node coordinator-negatives/public-contracts.mjs /absolute/input.json'); await run(process.argv[2]); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
}
