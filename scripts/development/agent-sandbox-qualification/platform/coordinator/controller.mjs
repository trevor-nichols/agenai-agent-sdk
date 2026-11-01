import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { release } from 'node:os';
import { Engine } from '../../engine.mjs';
import { installed } from '../research/desktop-concurrency/native/installed.mjs';
import { admitOutput, installedIdentity } from '../../scalability/identity.mjs';
import { absolute, Evidence, failure, observe, sha } from './evidence.mjs';
import { installEngineCapture } from './engine-capture.mjs';
import { cleanupMember } from './member.mjs';
import { runScenario } from './scenario.mjs';
import { parseScenario, scenarioScope } from './configuration.mjs';
import { originalFile } from '../coordinator-recovery/common.mjs';
import { effectTarget, installLostAcknowledgement } from './effect-fault.mjs';
import { handoff } from './handoff.mjs';
import { installControlLoss } from './control-loss.mjs';
import { suspendAtResponse } from './cut.mjs';

function validate(input) {
  assert.deepEqual(Object.keys(input).sort(), ['consumer', 'output', 'platform', 'capabilities', 'deploymentObservation', 'helper',
    ...(input.scenario === undefined ? [] : ['scenario']), ...(input.vmPreparation === undefined ? [] : ['vmPreparation'])].sort());
  const scenario = parseScenario(input.scenario);
  if (scenario.kind !== 'ms004') absolute(input.vmPreparation);
  else assert.equal(input.vmPreparation, undefined);
  if (scenario.kind === 'handoff' || scenario.kind === 'lost-ack') absolute(scenario.canonicalPath);
  absolute(input.consumer); absolute(input.output);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.versions.node, input.platform.expected.controller.nodeVersion);
  assert.equal(input.platform.profile, 'desktop-apple-virtualization-native-arm64', 'This exploratory row owns native/native only.');
  assert.equal(input.capabilities.profile, input.platform.profile);
  const route = input.capabilities.network.routeAuthority;
  assert.equal(route.profile, input.platform.profile); assert.equal(route.engine.endpoint, input.platform.engine);
  assert.equal(route.engine.id, input.platform.expected.daemon.id);
  assert.deepEqual(route.deployment, input.deploymentObservation.deployment);
  assert.equal(route.engine.id, input.deploymentObservation.engine.id);
  assert.equal(route.commandTimeoutMs, 5000); assert.equal(route.pollIntervalMs, 1000);
  for (const control of [route.vmObserver.control, input.capabilities.network.egress.configuration.control,
    input.capabilities.filesystem.configuration.control]) {
    assert.equal(control.heartbeatMs, 1000); assert.equal(control.leaseTimeoutMs, 60_000);
  }
  const limits = input.capabilities.limits;
  for (const [name, minimum, maximum] of [['startupMs', 1000, 120_000], ['requestMs', 1000, 30_000],
    ['cleanupMs', 1000, 60_000], ['scenarioMs', 60_000, 300_000]]) {
    assert(Number.isInteger(limits[name]) && limits[name] >= minimum && limits[name] <= maximum);
  }
  assert.equal(input.helper.protocol, 'agenai.desktop-coordinator.v1');
  assert.equal(route.kind, 'local_docker_desktop'); assert(route.engine.endpoint.startsWith('unix:///'));
  return scenario;
}

async function preparation(context) {
  const selected = await originalFile(context.input.vmPreparation, 4 * 1024 ** 2); const actual = selected.value;
  assert.equal(actual.format, 'agenai.desktop-coordinator-explicit-vm-preparation.v1');
  assert.equal(actual.status, 'pass'); assert.equal(actual.cleanup, 'confirmed_absent');
  assert.equal(actual.endpoint, context.input.platform.engine); assert.equal(actual.image, context.input.platform.sourceImage);
  assert.equal(actual.input.path, context.report.input.path); assert.equal(actual.input.sha256, context.report.input.sha256);
  assert.equal(actual.before.id, context.input.platform.expected.daemon.id); assert.equal(actual.after.id, actual.before.id);
  assert.match(actual.id, /^[a-f0-9]{64}$/u); assert.equal(actual.absence.length, 2);
  assert.deepEqual(actual.absence, [{ reference: actual.id, status: 404 }, { reference: actual.name, status: 404 }]);
  assert(actual.completedAt <= actual.finishedAt && actual.finishedAt <= context.report.startedAt);
  context.report.vmPreparation = { original: selected.identity,
    preserved: await context.evidence.file('explicit-vm-preparation-original.json', selected.bytes),
    scope: 'Successful explicit preparation receipt precedes this baseline. It does not grant authority to refresh or replace any external network identity.' };
  context.preparation = selected;
}

async function originalFiles(report) {
  for (const source of report.sources) assert.equal(sha(await readFile(source.original)), source.sha256, 'Qualification source changed during this attempt.');
  for (const asset of report.assets) assert.equal(sha(await readFile(asset.path)), asset.sha256, 'Prepared observer/coordinator asset changed during this attempt.');
}

async function clean(context) {
  const errors = [];
  for (const entry of context.members.toReversed()) {
    if (entry.report.finalState?.kind === 'destroyed') continue;
    try { await cleanupMember(context, entry); }
    catch (error) { errors.push({ label: entry.label, failure: failure(error) }); }
  }
  if (errors.length) return errors;
  if (context.coordinator) {
    try {
      context.coordinator.closeAdmission();
      const settling = context.coordinator.settle({ timeoutMs: 60_000 }); context.coordinatorTasks.push(settling);
      await observe(settling, 65_000, 'Original coordinator finite settlement');
      const closing = context.coordinator.close({ timeoutMs: 60_000 }); context.coordinatorTasks.push(closing);
      await observe(closing, 65_000, 'Original coordinator clean close');
      await observe(Promise.allSettled(context.coordinatorTasks), 20_000, 'Original coordinator operation join');
      context.report.coordinator.final = context.coordinator.state;
      assert.equal(context.coordinator.state.kind, 'closed');
      if (context.report.coordinator.generation !== undefined) {
        assert.equal(context.coordinator.state.result, 'clean');
        assert.equal(context.coordinator.state.generation, context.report.coordinator.generation);
      }
      await context.evidence.event({ kind: context.coordinator.state.result === 'clean' ? 'canonical-clean-close' : 'never-activated-owner-closed',
        state: context.coordinator.state });
    } catch (error) { errors.push({ coordinator: true, failure: failure(error), state: context.coordinator.state }); }
  }
  return errors;
}

async function retainOriginalOwners(context, errors) {
  context.report.status = 'retained_cleanup';
  context.report.retained = { pid: process.pid, retrySignal: 'SIGUSR2', errors, at: new Date().toISOString() };
  await context.evidence.file('retained-report-001.json', context.report);
  process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', output: context.input.output, pid: process.pid,
    retrySignal: 'SIGUSR2', message: 'Original cleanup owners remain resident. The retry signal repeats exact original cleanup only.' })}\n`);
  const keepAlive = setInterval(() => {}, 30_000);
  let retry = Promise.withResolvers();
  const requested = () => retry.resolve();
  process.on('SIGUSR2', requested);
  let receipts = 1;
  try {
    for (;;) {
      await retry.promise; retry = Promise.withResolvers();
      const next = await clean(context);
      if (!next.length) return;
      context.report.retained = { pid: process.pid, retrySignal: 'SIGUSR2', errors: next, at: new Date().toISOString() };
      if (receipts < 16) await context.evidence.file(`retained-report-${String(++receipts).padStart(3, '0')}.json`, context.report);
      process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', pid: process.pid, errors: next.length })}\n`);
    }
  } finally { clearInterval(keepAlive); process.off('SIGUSR2', requested); }
}

async function main(inputPath) {
  absolute(inputPath);
  assert.equal(await realpath(inputPath), inputPath);
  const stat = await lstat(inputPath); assert(stat.isFile() && stat.size <= 1024 ** 2);
  const raw = await readFile(inputPath); assert(raw.length <= 1024 ** 2);
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); const selectedScenario = validate(input);
  await admitOutput(input.output, input.consumer); assert.equal(await realpath(dirname(input.output)), dirname(input.output));
  const evidence = new Evidence(input.output); await evidence.initialize(raw);
  const report = { format: selectedScenario.kind === 'ms004' ? 'agenai.desktop-coordinator-ms004-exploratory.v1' : 'agenai.desktop-coordinator-ms005-exploratory.v1', status: 'running',
    startedAt: new Date().toISOString(), input: { path: inputPath, bytes: raw.length, sha256: sha(raw) },
    scope: scenarioScope(selectedScenario),
    scenario: selectedScenario,
    runtime: { executable: process.execPath, command: process.argv, node: process.versions.node, platform: process.platform, arch: process.arch, osRelease: release(), pid: process.pid },
    sources: [], assets: [], candidate: null, packages: [], coordinator: {}, members: [], observations: [],
    primaryFailure: null, cleanupFailures: [] };
  const cancellation = new AbortController();
  const interrupted = () => cancellation.abort(new Error('Exploratory controller interruption requests original cleanup.'));
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  const scenario = AbortSignal.timeout(input.capabilities.limits.scenarioMs);
  const context = { input, evidence, report, signal: AbortSignal.any([cancellation.signal, scenario]), members: [],
    coordinator: null, coordinatorTasks: [], scenario: selectedScenario,
    namespace: `ms00${selectedScenario.kind === 'ms004' ? '4' : '5'}-exploratory-${randomUUID().slice(0, 8)}`, guestSources: new Map() };
  context.handoff = (phase, receipt) => handoff(context, phase, receipt);
  try {
    report.sources = await evidence.freezeSources();
    if (selectedScenario.kind !== 'ms004') await preparation(context);
    context.engineCapture = await installEngineCapture({ socketPath: input.platform.engine.slice(7), evidence });
    for (const name of ['guest.mjs', 'guest-network.mjs']) {
      const source = report.sources.find((entry) => entry.original.endsWith(`/${name}`)); assert(source);
      const bytes = await readFile(source.path); assert.equal(sha(bytes), source.sha256); context.guestSources.set(name, bytes);
    }
    report.candidate = await installedIdentity(input.consumer);
    const sdk = await installed(input.consumer, '@agen-ai/sandbox');
    const docker = await installed(input.consumer, '@agen-ai/sandbox-docker');
    const node = await installed(input.consumer, '@agen-ai/sandbox-docker', './node');
    Object.assign(context, { sdk: sdk.api, docker: docker.api, node: node.api });
    report.packages = [sdk.identity, docker.identity, node.identity];
    assert.equal(typeof docker.api.createCoordinatedDockerSandboxBackend, 'function');
    assert.equal(typeof node.api.createDockerDesktopCoordinator, 'function');
    const route = input.capabilities.network.routeAuthority;
    for (const asset of [route.hostObserver.executable, input.helper.executable]) {
      absolute(asset.path); assert.equal(await realpath(asset.path), asset.path);
      const before = await lstat(asset.path); assert(before.isFile() && before.size <= 32 * 1024 ** 2);
      assert.equal(sha(await readFile(asset.path)), asset.sha256); report.assets.push(asset);
    }
    const socket = await lstat(input.platform.engine.slice(7), { bigint: true }); assert(socket.isSocket() && !socket.isSymbolicLink());
    report.socket = { endpoint: input.platform.engine, device: String(socket.dev), inode: String(socket.ino), uid: String(socket.uid), mode: String(socket.mode) };
    context.engine = new Engine(input.platform.engine.slice(7), '1.52', { requestMs: 10_000, outputBytes: 4 * 1024 ** 2 });
    if (context.preparation) {
      for (const reference of [context.preparation.value.id, context.preparation.value.name]) {
        await context.engine.request('GET', `/containers/${reference}/json`, undefined, { allowed: [404] });
      }
    }
    const version = (await context.engine.request('GET', '/version')).data;
    const info = (await context.engine.request('GET', '/info')).data;
    assert.equal(info.ID, route.engine.id); assert.equal(version.Version, input.platform.expected.daemon.version);
    assert.equal(version.ApiVersion, '1.52'); assert.equal(info.KernelVersion, input.platform.expected.daemon.kernelVersion);
    report.engine = { id: info.ID, kernel: info.KernelVersion, version: version.Version, apiVersion: version.ApiVersion };
    const networkIds = async () => (await context.engine.request('GET', '/networks')).data.map(({ Id }) => Id).sort();
    report.initialNetworks = await networkIds(); assert(report.initialNetworks.length <= 128);
    context.routeAuthority = node.api.createDockerDesktopRouteAuthority(route);
    context.coordinator = node.api.createDockerDesktopCoordinator({ routeAuthority: context.routeAuthority, helper: input.helper });
    report.coordinator.initial = context.coordinator.state;
    await evidence.event({ kind: 'attempt-admitted', candidate: report.candidate, engine: report.engine, socket: report.socket });
    const initialization = context.coordinator.initialize({ timeoutMs: 60_000, signal: context.signal }); context.coordinatorTasks.push(initialization);
    await observe(initialization, 65_000, 'Explicit coordinator initialization');
    const activating = context.coordinator.activate({ timeoutMs: 60_000, signal: context.signal }); context.coordinatorTasks.push(activating);
    context.authority = await observe(activating, 65_000, 'Original coordinator activation');
    report.coordinator.generation = context.authority.generation;
    await evidence.event({ kind: 'coordinator-activated', state: context.coordinator.state, generation: context.authority.generation });
    if ((selectedScenario.kind === 'handoff' || selectedScenario.kind === 'lost-ack') && selectedScenario.fault) {
      context.ackFault = installLostAcknowledgement({ socketPath: input.platform.engine.slice(7), evidence,
        select: (options) => effectTarget(options, context.faultMember, selectedScenario.fault),
        ...(selectedScenario.kind === 'handoff' ? { onResponseCut: (receipt) => suspendAtResponse(context, 'response-before-delivery', receipt) }
          : { onErrorDeliveryCut: (receipt) => suspendAtResponse(context, 'request-error-listeners-returned', receipt) }) });
    }
    if (selectedScenario.kind === 'control-loss') context.controlFault = installControlLoss({ socketPath: input.platform.engine.slice(7),
      member: () => context.faultMember, role: selectedScenario.role, evidence });
    await runScenario(context);
    context.signal.throwIfAborted(); report.scenarioCompleted = true;
  } catch (error) {
    report.primaryFailure = failure(error); await evidence.event({ kind: 'attempt-failed', failure: report.primaryFailure });
  }
  finally {
    cancellation.abort(new Error('Exploratory scenario entered original-owner cleanup.'));
    context.coordinator?.closeAdmission();
    report.cleanupFailures = await clean(context);
    if (report.cleanupFailures.length) await retainOriginalOwners(context, report.cleanupFailures);
    report.status = report.scenarioCompleted && !report.primaryFailure && !report.cleanupFailures.length ? 'pass' : 'fail';
    try {
      await originalFiles(report);
      if (context.preparation) assert.equal(sha(await readFile(context.preparation.identity.path)), context.preparation.identity.sha256);
      if (report.candidate) assert.deepEqual(await installedIdentity(input.consumer), report.candidate, 'Installed candidate changed during this attempt.');
      assert.equal(sha(await readFile(inputPath)), report.input.sha256, 'Attempt input changed during execution.');
      if (context.engine) {
        const info = (await context.engine.request('GET', '/info')).data; assert.equal(info.ID, report.engine.id);
        report.finalNetworks = (await context.engine.request('GET', '/networks')).data.map(({ Id }) => Id).sort();
        assert.deepEqual(report.finalNetworks, report.initialNetworks, 'Original Engine network census did not return to its initial identities.');
      }
    } catch (error) { report.status = 'fail'; report.finalIdentityFailure = failure(error); }
    try {
      if (context.ackFault) report.acknowledgementFault = await context.ackFault.close();
      if (context.controlFault) report.controlAttachment = await context.controlFault.close();
      if (context.engineCapture) {
        report.engineCapture = await context.engineCapture.close();
        if (report.engineCapture.completeness !== 'complete') report.status = 'fail';
      }
    } catch (error) { report.status = 'fail'; report.engineCaptureFailure = failure(error); }
    report.finishedAt = new Date().toISOString();
    await evidence.file('report.json', report); await evidence.close();
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, output: input.output, generation: report.coordinator.generation,
    members: report.members.map(({ label, finalState }) => ({ label, state: finalState?.kind })), report: `${input.output}/report.json` })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

try {
  const args = process.argv.slice(2);
  assert.equal(args.length, 1, 'Usage: node coordinator/controller.mjs /absolute/native-input.json');
  await main(args[0]);
} catch (error) { process.stderr.write(`${JSON.stringify({ status: 'fail', failure: failure(error) })}\n`); process.exitCode = 1; }
