import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../../engine.mjs';
import { credentialFreeEnvironment } from '../../ci-profile.mjs';
import { admitOutput, installedIdentity } from '../../scalability/identity.mjs';
import { absolute, Evidence, failure } from '../coordinator/evidence.mjs';
import { originalFile } from '../coordinator-recovery/common.mjs';
import { assertOriginals } from './original.mjs';
import { coldSourceClosure } from './source-closure.mjs';
import { assertOriginalHistory } from './cold-history.mjs';
import { captureBackendLogs } from './backend-log.mjs';
import { backendEvents, assertCachedPrecondition, assertColdOutcome } from './cold-proof.mjs';
import { joinOriginalChild } from './child.mjs';
import { coldScenario, parseScenario } from '../coordinator/configuration.mjs';

const containers = (values) => values.map(({ Id, Names, ImageID, State, Labels }) => ({ Id, Names, ImageID, State, Labels })).sort((a, b) => a.Id.localeCompare(b.Id));
const volumes = (value) => (value.Volumes ?? []).map(({ Name, Driver, Labels, Options, Scope }) => ({ Name, Driver, Labels, Options, Scope })).sort((a, b) => a.Name.localeCompare(b.Name));

export async function runColdAdmission(inputPath) {
  const inputFile = await originalFile(absolute(inputPath), 1024 ** 2), input = inputFile.value;
  assert.deepEqual(Object.keys(input).sort(), ['consumer', 'output', 'controllerInput', 'backendSocket', 'backendLogs', 'expectedCandidate'].sort());
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.equal(process.versions.node, '24.18.0');
  const controllerInput = await originalFile(input.controllerInput, 1024 ** 2), config = controllerInput.value;
  const scenario = parseScenario(config.scenario);
  assert(coldScenario(scenario), 'The cold wrapper runs only scenarios that begin from Desktop’s own VM state.');
  if (scenario.backendLogs) assert.deepEqual(scenario.backendLogs, input.backendLogs);
  assert.equal(config.consumer, input.consumer); assert.equal(config.vmPreparation, undefined);
  assert.equal(config.platform.profile, 'desktop-apple-virtualization-native-arm64');
  assert.deepEqual(await installedIdentity(input.consumer), input.expectedCandidate);
  await admitOutput(input.output, input.consumer);
  const evidence = new Evidence(input.output); await evidence.initialize(inputFile.bytes);
  const report = { format: 'agenai.desktop-coordinator-cold-admission.v1', status: 'running', startedAt: Date.now(),
    pid: process.pid, input: inputFile.identity, controllerInput: controllerInput.identity, scenario: scenario.kind, sources: [], observations: [],
    child: null, outcome: null, primaryFailure: null, originalCleanupComplete: false,
    scope: 'Actual cold cached Desktop preconditions, one original installed controller that passes its selected scenario on the first attempt from a live member baseline, SDK-create wake, default-bridge replacement and original cleanup. No settings change, VM preparation or retry.' };
  const save = () => writeFile(join(input.output, 'record.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const engine = new Engine(config.platform.engine.slice(7), '1.52', { requestMs: 15_000, outputBytes: 4 * 1024 ** 2 });
  const backendSettings = async () => {
    const http = await import('node:http');
    const dispatchedAt = Date.now();
    return new Promise((resolve, reject) => {
      const request = http.get({ socketPath: input.backendSocket, path: '/app/settings/flat', agent: false, timeout: 15_000 }, (response) => {
        const chunks = []; let bytes = 0;
        response.on('data', (chunk) => { bytes += chunk.length; if (bytes > 4 * 1024 ** 2) response.destroy(new Error('Desktop settings response bound exceeded.')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          try { assert.equal(response.statusCode, 200); resolve({ raw: Buffer.concat(chunks), value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            dispatchedAt, finishedAt: Date.now() }); }
          catch (error) { reject(error); }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Desktop settings GET deadline.'))); request.on('error', reject);
    });
  };
  const get = async (name, path) => {
    const dispatchedAt = Date.now();
    const actual = await engine.request('GET', path, undefined, { binary: true });
    const retained = await evidence.file(`${name}.bin`, actual.data, 4 * 1024 ** 2);
    report.observations.push({ method: 'GET', endpoint: config.platform.engine, path, status: actual.status, retained,
      dispatchedAt, finishedAt: Date.now() });
    return JSON.parse(actual.data.toString('utf8'));
  };
  try {
    report.sources = await coldSourceClosure(evidence);
    report.candidate = await installedIdentity(input.consumer);
    const settings = await backendSettings(); report.settings = await evidence.file('desktop-settings.json', settings.raw);
    report.observations.push({ method: 'GET', endpoint: input.backendSocket, path: '/app/settings/flat', status: 200,
      dispatchedAt: settings.dispatchedAt, finishedAt: settings.finishedAt, retained: report.settings });
    const first = { info: await get('cached-info-first', '/info'), at: Date.now() };
    await delay(1500);
    const second = { info: await get('cached-info-second', '/info'), at: Date.now() };
    report.before = { info: first.info, networks: await get('before-networks', '/networks'),
      containers: containers(await get('before-containers', '/containers/json?all=1')), volumes: volumes(await get('before-volumes', '/volumes')) };
    assert(report.before.containers.every(({ State }) => State !== 'running'), 'Every prior native owner must settle before natural cold admission.');
    await delay(250);
    const logs = await captureBackendLogs(input.backendLogs, evidence, 'admission');
    report.backendAdmission = logs.map(({ source, retained }) => ({ source, retained }));
    assertCachedPrecondition({ settings: settings.value, first, second, events: backendEvents(logs.map(({ bytes }) => bytes)),
      startedAt: report.startedAt, finishedAt: Date.now() });
    report.cached = { first, second }; await save();
    const script = fileURLToPath(new URL('../coordinator/controller.mjs', import.meta.url));
    const hook = fileURLToPath(new URL('./cold-hook.mjs', import.meta.url));
    report.child = await joinOriginalChild({ command: process.execPath, args: ['--import', hook, script, input.controllerInput],
      cwd: input.consumer, env: { ...credentialFreeEnvironment(process.env, join(input.output, 'docker-config')),
        AGENAI_COLD_HTTP_TRACE: join(input.output, 'original-http-history.jsonl'), AGENAI_COLD_ENGINE_SOCKET: config.platform.engine.slice(7) }, output: input.output,
      async onSpawn(child) { report.child = child; await save(); } });
    const original = await originalFile(join(config.output, 'report.json'), 4 * 1024 ** 2);
    report.originalReport = original.identity;
    report.originalCleanupComplete = original.value.cleanupFailures.length === 0 && original.value.coordinator.final?.kind === 'closed'
      && original.value.coordinator.final.result === 'clean' && original.value.members.every(({ finalState }) => finalState?.kind === 'destroyed');
    report.after = { info: await get('after-info', '/info'), networks: await get('after-networks', '/networks'),
      containers: containers(await get('after-containers', '/containers/json?all=1')), volumes: volumes(await get('after-volumes', '/volumes')) };
    const finalLogs = await captureBackendLogs(input.backendLogs, evidence, 'final');
    report.backendFinal = finalLogs.map(({ source, retained }) => ({ source, retained }));
    const finalEvents = backendEvents(finalLogs.map(({ bytes }) => bytes));
    assertCachedPrecondition({ settings: settings.value, first, second, events: finalEvents,
      startedAt: report.startedAt, finishedAt: report.child.startedAt });
    const workflowEvents = (await readFile(join(config.output, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    report.outcome = assertColdOutcome({ scenario, report: original.value, before: report.before, after: report.after,
      events: finalEvents, workflowEvents, child: report.child, sourceInputSha256: controllerInput.identity.sha256 });
    const history = (await readFile(join(input.output, 'original-http-history.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    report.history = assertOriginalHistory(history);
    assert.deepEqual(original.value.candidate, input.expectedCandidate);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.primaryFailure = failure(error); }
  finally {
    try {
      await assertOriginals([inputFile, controllerInput], report.sources);
      assert.deepEqual(await installedIdentity(input.consumer), input.expectedCandidate);
    } catch (error) { report.status = 'failed'; report.identityFailure = failure(error); }
    report.finishedAt = Date.now(); await save(); await evidence.file('report.json', report); await evidence.close();
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, originalCleanupComplete: report.originalCleanupComplete, output: input.output })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { assert.equal(process.argv.length, 3, 'Usage: node coordinator-negatives/cold.mjs /absolute/input.json'); await runColdAdmission(process.argv[2]); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
}
