import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFreeEnvironment } from '../../ci-profile.mjs';
import { Engine } from '../../engine.mjs';
import { createTraceProxy } from '../../selective/proxy/index.mjs';
import { admitOutput, installedIdentity, within } from '../../scalability/identity.mjs';
import { createDaemonObserver, cleanupDaemonObserver } from '../observer/index.mjs';
import { absolute, encode, Evidence, failure, sha } from '../coordinator/evidence.mjs';
import { compareEngineInventory, engineInventory, originalFile } from '../coordinator-recovery/common.mjs';
import { jsonWriter } from '../capabilities/live/evidence.mjs';
import { assertOriginals } from './original.mjs';
import { coldSourceClosure } from './source-closure.mjs';
import { joinOriginalChild } from './child.mjs';
import { finishOuter } from './outer-cleanup.mjs';
import { retainSignals, retainUntilFinished } from './cleanup.mjs';
import { retainOriginalHandoff } from './handoff.mjs';

export async function runObservedNegatives(inputPath) {
  const selected = await originalFile(absolute(inputPath), 1024 ** 2), input = selected.value;
  assert.deepEqual(Object.keys(input).sort(), ['consumer', 'cleanupConsumer', 'output', 'sdkOutput', 'recoveryOutput',
    'template', 'supervisor', 'observerImage', 'fixtureImage', 'expectedCandidate'].sort());
  for (const path of [input.consumer, input.cleanupConsumer, input.output, input.sdkOutput, input.recoveryOutput,
    input.template, input.supervisor.path, input.supervisor.python]) absolute(path);
  assert.deepEqual(Object.keys(input.supervisor).sort(), ['path', 'python', 'sha256']);
  assert.match(input.supervisor.sha256, /^[a-f0-9]{64}$/u);
  for (const image of [input.observerImage, input.fixtureImage]) assert.match(image, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.equal(process.versions.node, '24.18.0');
  assert.notEqual(input.consumer, input.cleanupConsumer);
  assert.deepEqual(await installedIdentity(input.consumer), input.expectedCandidate);
  assert.deepEqual(await installedIdentity(input.cleanupConsumer), input.expectedCandidate);
  const template = await originalFile(input.template, 1024 ** 2);
  const supervisor = await originalFileSource(input.supervisor.path, input.supervisor.sha256);
  for (const output of [input.output, input.sdkOutput, input.recoveryOutput]) {
    await admitOutput(output, input.consumer); await admitOutput(output, input.cleanupConsumer);
    for (const other of [input.output, input.sdkOutput, input.recoveryOutput]) if (other !== output) assert(!within(output, other));
  }
  const evidence = new Evidence(input.output); await evidence.initialize(selected.bytes);
  const socketPath = join(input.output, 'e.sock'); assert(Buffer.byteLength(socketPath) <= 100);
  const report = { format: 'agenai.desktop-coordinator-observed-negatives.v1', status: 'running', pid: process.pid,
    input: selected.identity, startedAt: new Date().toISOString(), sources: [], steps: [], observer: null,
    cleanupComplete: false, primaryFailure: null, cleanupFailures: [], evidenceFailures: [],
    proxyLimits: { maxConnections: 32, maxActiveRequests: 32, maxPendingRequests: 10 },
    scope: 'One original installed native/native delete-cut generation, F07 negatives and exact recovery under an independent outer PID/start/cgroup observer. Explicit VM preparation remains a separate bounded create/start/wait/delete phase.' };
  const checkpoint = jsonWriter(join(input.output, 'record.json')), save = () => checkpoint(report);
  const signals = retainSignals(report);
  let proxy, observer, observerEntered = false, cleanupOnlyInput, originalInput, predecessor, recoveryInput, handoff;
  let cleanupAttempts = 0;
  const engine = new Engine(template.value.platform.engine.slice(7), '1.52', { requestMs: 15_000, outputBytes: 4 * 1024 ** 2 });
  const images = [...new Set([input.observerImage, input.fixtureImage, template.value.platform.sourceImage,
    template.value.capabilities.filesystem.configuration.imageDigest,
    template.value.capabilities.network.egress.configuration.imageDigest,
    template.value.capabilities.network.routeAuthority.vmObserver.imageDigest])];
  const imageCensus = async (phase) => {
    const result = [];
    for (const [index, image] of images.entries()) {
      const response = await engine.request('GET', `/images/${encodeURIComponent(image)}/json`, undefined, { binary: true });
      const raw = await evidence.file(`image-${phase}-${index}.json`, response.data, 4 * 1024 ** 2);
      const actual = JSON.parse(response.data.toString('utf8'));
      assert.equal(actual.Id, image); assert.equal(actual.Os, 'linux'); assert.equal(actual.Architecture, 'arm64');
      assert.equal(Object.keys(actual.Config.Volumes ?? {}).length, 0);
      if ([input.observerImage, input.fixtureImage, template.value.platform.sourceImage].includes(image)) {
        assert.deepEqual(actual.Config.Env, ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
          'Every Node primary requires an explicitly sanitized image.');
      }
      result.push({ image, raw, actual });
    }
    return result;
  };
  const env = credentialFreeEnvironment(process.env, join(input.output, 'docker-config'));
  const command = async (name, executable, args, cwd, cleanupOnly = false) => {
    const output = join(input.output, `${name}${cleanupOnly ? `-${++cleanupAttempts}` : ''}-command`); await mkdir(output, { mode: 0o700 });
    if (!cleanupOnly) signals.assertCurrent();
    let step;
    const child = await joinOriginalChild({ command: executable, args, cwd, env, output,
      async onSpawn(value) {
        if (name === 'original-delete-cut' && value.pid) report.originalChildEntered = true;
        if (name === 'installed-recovery-negatives' && value.pid) report.negativeChildEntered = true;
        if (name === 'interrupted-original-cleanup' && value.pid) report.cleanupChildEntered = true;
        step = { name, ...value, output }; report.steps.push(step); await save();
      } });
    Object.assign(step, child); await save();
    return child;
  };
  const completeOuter = async () => {
    if (report.originalChildEntered && !report.originalGenerationClosed) {
      const admitted = await handoff.admit();
      if (admitted.kind === 'rejected') {
        const closed = await originalFile(join(input.sdkOutput, 'report.json'), 4 * 1024 ** 2);
        assert.deepEqual(closed.value.input, originalInput);
        const state = closed.value.coordinator.final;
        assert.equal(state.kind, 'closed');
        if (closed.value.coordinator.generation !== undefined) {
          assert.equal(state.result, 'clean'); assert.equal(state.generation, closed.value.coordinator.generation);
        } else assert.equal(state.result, 'never_activated');
        report.originalGenerationClosed = true; report.originalCleanup = closed.identity;
      } else if (!report.negativeChildEntered && !report.cleanupChildEntered) {
        predecessor = admitted.predecessor; cleanupOnlyInput = await handoff.cleanupInput();
        await command('interrupted-original-cleanup', process.execPath,
          [fileURLToPath(new URL('../coordinator-recovery/controller.mjs', import.meta.url)), '--members', cleanupOnlyInput.path], input.cleanupConsumer, true);
      }
      if (report.negativeChildEntered || report.cleanupChildEntered) {
        const closed = await originalFile(join(input.recoveryOutput, 'report.json'), 4 * 1024 ** 2);
        assert.deepEqual(closed.value.input, report.negativeChildEntered ? recoveryInput : cleanupOnlyInput);
        report.originalGenerationClosed = closed.value.finalOwnerState?.kind === 'closed' && closed.value.finalOwnerState.result === 'clean'
          && closed.value.finalOwnerState.generation === predecessor.value.barrier.generation;
        report.originalCleanup = closed.identity;
      }
      assert(report.originalGenerationClosed, 'Retain the exact proxy/observer until original canonical clean-close acknowledgement is confirmed.');
    }
    await finishOuter({ proxy, observer, observerEntered, socketPath, report,
      observerFallback: () => cleanupDaemonObserver({ endpoint: template.value.platform.engine, recordPath: join(input.output, 'observer/record.json') }) });
  };
  try {
    report.sources = await coldSourceClosure(evidence, ['platform/coordinator-negatives/outer.mjs',
      'platform/coordinator-negatives/recovery.mjs', 'platform/coordinator/prepare-vm.mjs']);
    await evidence.file('supervisor-original.py', supervisor.bytes, 1024 ** 2);
    proxy = await createTraceProxy({ socketPath, upstreamEndpoint: template.value.platform.engine,
      tracePath: join(input.output, 'engine-http.jsonl'), ...report.proxyLimits,
      async observeResponse(value) { if (observer) await observer.observeResponse(value); } });
    proxy.setRow('coordinator-negatives');
    const config = structuredClone(template.value);
    config.consumer = input.consumer; config.output = input.sdkOutput;
    const upstreamEndpoint = config.platform.engine;
    config.platform.engine = proxy.endpoint; config.capabilities.network.routeAuthority.engine.endpoint = proxy.endpoint;
    config.capabilities.platformManifestSha256 = sha(Buffer.from(encode(config.platform)));
    config.vmPreparation = join(input.output, 'vm-preparation/report.json');
    assert.deepEqual(config.scenario.fault, { operation: 'delete', role: 'compute' });
    assert.equal(config.scenario.kind, 'handoff'); assert.equal(config.scenario.at, 'effect-response');
    const caps = config.capabilities;
    const roles = [
      { role: 'compute', count: 2, ...caps.workload.resources },
      { role: 'filesystem', count: 2, ...caps.filesystem.configuration.resources },
      { role: 'route_observer', count: 2, ...caps.network.routeAuthority.vmObserver.resources },
      { role: 'egress_broker', count: 2, ...caps.network.egress.configuration.broker.resources },
      { role: 'egress_relay', count: 2, ...caps.network.egress.configuration.relay.resources },
      { role: 'independent_daemon_observer', count: 1, cpus: 1, memoryBytes: 256 * 1024 ** 2, pids: 32 },
      { role: 'stopped_foreign_fixture', count: 1, cpus: 0.125, memoryBytes: 64 * 1024 ** 2, pids: 16 },
    ];
    report.resourceBudget = { roles, nanoCpus: roles.reduce((sum, value) => sum + value.count * value.cpus * 1e9, 0),
      memoryBytes: roles.reduce((sum, value) => sum + value.count * value.memoryBytes, 0) };
    assert(report.resourceBudget.nanoCpus <= 4e9 && report.resourceBudget.memoryBytes <= 4 * 1024 ** 3);
    report.imageAdmission = await imageCensus('admission');
    originalInput = await evidence.file('original-input.json', config);
    const prepared = await command('explicit-vm-preparation', process.execPath,
      [fileURLToPath(new URL('../coordinator/prepare-vm.mjs', import.meta.url)), originalInput.path, join(input.output, 'vm-preparation')], input.consumer);
    assert.equal(prepared.code, 0); assert.equal(prepared.signal, null);
    const preparation = await originalFile(config.vmPreparation, 4 * 1024 ** 2);
    assert.equal(preparation.value.status, 'pass'); assert.equal(preparation.value.cleanup, 'confirmed_absent');
    report.vmPreparation = preparation.identity;
    report.inventoryBefore = await engineInventory(engine); report.imagesBefore = await imageCensus('before');
    observerEntered = true;
    observer = await createDaemonObserver({ endpoint: upstreamEndpoint, imageDigest: input.observerImage,
      architecture: 'arm64', output: join(input.output, 'observer'), namespacePrefixes: ['ms005-exploratory-'],
      roleImages: { compute: [config.platform.sourceImage], export: [config.platform.sourceImage],
        filesystem: [caps.filesystem.configuration.imageDigest], route_observer: [caps.network.routeAuthority.vmObserver.imageDigest],
        egress_broker: [caps.network.egress.configuration.imageDigest], egress_relay: [caps.network.egress.configuration.imageDigest] } });
    report.observer = observer.record; report.endpoint = { upstream: upstreamEndpoint, originalAndRecovery: proxy.endpoint }; await save();
    const handoffOutput = join(input.output, 'handoff');
    handoff = retainOriginalHandoff({ originalInput, sdkOutput: input.sdkOutput, handoffOutput,
      consumer: input.cleanupConsumer, output: input.recoveryOutput, evidence, report });
    const cut = await command('original-delete-cut', input.supervisor.python,
      [input.supervisor.path, process.execPath, fileURLToPath(new URL('../coordinator/controller.mjs', import.meta.url)), originalInput.path, handoffOutput], input.consumer);
    assert.equal(cut.code, 0); assert.equal(cut.signal, null);
    const admitted = await handoff.admit(); assert.equal(admitted.kind, 'cut'); predecessor = admitted.predecessor;
    cleanupOnlyInput = await handoff.cleanupInput();
    recoveryInput = await evidence.file('recovery-input.json', { consumer: input.cleanupConsumer, output: input.recoveryOutput,
      originalInput: originalInput.path, originalReport: predecessor.value.barrier.report.path,
      canonical: join(input.sdkOutput, 'cut-canonical-original.bin'), predecessor: predecessor.identity.path,
      fixtureImage: input.fixtureImage, expectedCandidate: input.expectedCandidate });
    const recovery = await command('installed-recovery-negatives', process.execPath,
      ['--inspect-port=127.0.0.1:0', fileURLToPath(new URL('./recovery.mjs', import.meta.url)), recoveryInput.path], input.cleanupConsumer);
    const recovered = await originalFile(join(input.recoveryOutput, 'report.json'), 4 * 1024 ** 2);
    report.recovery = recovered.identity;
    report.originalGenerationClosed = recovered.value.originalCleanupComplete && recovered.value.finalOwnerState?.kind === 'closed'
      && recovered.value.finalOwnerState.result === 'clean' && recovered.value.finalOwnerState.generation === predecessor.value.barrier.generation;
    assert.equal(recovery.code, 0); assert.equal(recovery.signal, null);
    assert.equal(recovered.value.status, 'passed'); assert.equal(recovered.value.cleanupComplete, true);
    const original = await originalFile(predecessor.value.barrier.report.path, 4 * 1024 ** 2);
    const members = new Set(original.value.handoff.members.map(({ record }) => record.path));
    assert.equal(members.size, 2);
    const operations = new Set(original.value.members.map(({ originalRecord }) => originalRecord.operationId));
    assert.equal(observer.record.scopes.filter(({ role }) => role === 'compute').length, 2);
    assert(observer.record.scopes.every(({ operationId }) => operations.has(operationId)));
    const capacity = proxy.capacity(); report.proxyCapacity = capacity;
    assert.equal(capacity.connections.rejected, 0); assert.equal(capacity.requests.rejected, 0); assert.equal(capacity.pendingRequests.rejected, 0);
    report.status = 'passed';
  } catch (error) { report.primaryFailure = failure(error); report.status = 'failed'; }
  finally {
    await retainUntilFinished(completeOuter, report, save);
    try {
      if (report.inventoryBefore) {
        report.inventoryAfter = await engineInventory(engine);
        compareEngineInventory(report.inventoryBefore, report.inventoryAfter, []);
        report.imagesAfter = await imageCensus('after');
        assert.deepEqual(report.imagesAfter.map(({ actual }) => actual), report.imagesBefore.map(({ actual }) => actual),
          'Borrowed image response changed after explicit VM preparation.');
      }
      await assertOriginals([selected, template, supervisor], report.sources);
      assert.deepEqual(await installedIdentity(input.consumer), input.expectedCandidate);
      assert.deepEqual(await installedIdentity(input.cleanupConsumer), input.expectedCandidate);
    } catch (error) { report.evidenceFailures.push(failure(error)); }
    if (report.cleanupFailures.length || report.evidenceFailures.length || report.interrupted) report.status = 'failed';
    report.finishedAt = new Date().toISOString(); await save(); await evidence.file('report.json', report); await evidence.close();
    signals.close();
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, cleanupComplete: report.cleanupComplete, output: input.output })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

async function originalFileSource(path, expected) {
  const { originalBytes } = await import('../coordinator-recovery/common.mjs');
  const selected = await originalBytes(path, 1024 ** 2); assert.equal(selected.identity.sha256, expected); return selected;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { assert.equal(process.argv.length, 3, 'Usage: node coordinator-negatives/outer.mjs /absolute/input.json'); await runObservedNegatives(process.argv[2]); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
}
