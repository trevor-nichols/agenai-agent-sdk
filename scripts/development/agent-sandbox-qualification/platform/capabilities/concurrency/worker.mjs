import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquireJsonInput } from '../input.mjs';
import { Evidence, failure } from '../../coordinator/evidence.mjs';
import { effectTarget, installLostAcknowledgement } from '../../coordinator/effect-fault.mjs';
import { installControlLoss } from '../../coordinator/control-loss.mjs';
import { suspendAtResponse } from '../../coordinator/cut.mjs';
import { suspendWithOutstanding } from './cut-requests.mjs';
import { parseCanonicalEnvelope } from '../../coordinator-recovery/canonical.mjs';
import { installedIdentity } from '../../../scalability/identity.mjs';
import { concurrencyCase } from './cases.mjs';
import { concurrentMember, loadConcurrencyExample } from './installed.mjs';
import { controllerChannel } from './channel.mjs';
import { retainCleanupOwner } from './ownership.mjs';
import { assertCheckpointFault, assertTerminalCheckpointFault, everyFailureBranch, sdkFenceFailure, stoppedMemberExits } from './faults.mjs';
import { captureControlLossAdmission, classifyControlLoss } from './control-loss.mjs';
import { assertTopologyFenceOutcome, captureTopologyFence } from './topology-fence.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonicalPath = (engineId) => join(userInfo().homedir, 'Library/Application Support/AgenAI/sandbox-docker/desktop-coordination-v1',
  `${sha(`agenai.desktop-coordinator.engine.v1\0${engineId}`)}.state`);

function suspendOriginalWorkflow(context, phase) {
  const { report, evidence } = context;
  const path = context.scenario.canonicalPath, bytes = readFileSync(path); assert(bytes.length <= 4 * 1024 ** 2);
  const snapshot = parseCanonicalEnvelope(bytes).value;
  assert.equal(snapshot.generation.kind, 'dirty'); assert.equal(snapshot.generation.identity.generationId, context.authority.generation);
  const members = context.members.filter(({ owner }) => owner).map((entry) => ({ label: entry.label, namespace: entry.namespace,
    record: evidence.fileSync(`${entry.label}/cut-record.json`, entry.owner.recoveryRecord, 65_536), state: entry.owner.state,
    process: report.observations.findLast((observation) => observation.member === entry.label && observation.continuity)?.continuity.identity ?? null }));
  report.handoff = { phase, at: new Date().toISOString(), pid: process.pid,
    canonical: { path, bytes: bytes.length, sha256: sha(bytes) }, preservedCanonical: evidence.fileSync('cut-canonical-original.bin', bytes), members,
    cut: { kind: 'synchronous-original-public-workflow-self-suspension', resumeSignal: 'SIGCONT' } };
  const stored = evidence.fileSync('cut-report.json', report, 8 * 1024 ** 2);
  writeSync(1, `${JSON.stringify({ status: 'cut_ready', pid: process.pid, phase, report: stored, canonical: report.handoff.canonical })}\n`);
  process.kill(process.pid, 'SIGSTOP');
  throw new Error('Original synchronous workflow cut resumed; crash qualification remains failed.');
}

export async function runConcurrencyWorker(inputPath) {
  const captured = await acquireJsonInput(inputPath, 1024 ** 2), config = captured.value;
  assert.equal(config.format, 'agenai.sandbox-concurrency-worker.v1');
  assert.equal(process.cwd(), config.consumer); assert(process.send, 'Worker requires its original live supervisor.');
  const selected = concurrencyCase(config.capabilities.concurrency.caseId);
  const channel = controllerChannel(config.capabilities.limits.requestMs, config.scenarioBudget.maximumMessages);
  const evidence = new Evidence(config.output); await evidence.initialize(captured.utf8);
  const report = { format: 'agenai.sandbox-platform-concurrency-worker.v1', status: 'running', selected,
    input: { path: inputPath, bytes: captured.input.bytes, sha256: captured.input.sha256 }, startedAt: new Date().toISOString(),
    sources: config.sourceIdentity.map((source) => ({ original: join(config.qualificationDirectory, source.name), sha256: source.sha256 })),
    assets: config.preparation.assets, candidate: await installedIdentity(config.consumer),
    engine: { id: config.platform.expected.daemon.id }, coordinator: {}, members: [], observations: [],
    primaryFailure: null, cleanupFailures: [], fault: null, output: [] };
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Original workflow controller interruption.'));
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  const context = { config, input: { ...config, capabilities: config.capabilities, helper: config.capabilities.concurrency.helper,
    platform: { ...config.platform, engine: config.endpoint } }, report, evidence,
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(config.capabilities.limits.scenarioMs)]),
    observerIds: new Map(), members: [], namespace: config.namespacePrefix,
    scenario: selected.kind === 'lost_ack' ? { kind: 'lost-ack', canonicalPath: canonicalPath(report.engine.id), fault: { operation: selected.operation, role: selected.role } }
      : { kind: 'handoff', canonicalPath: canonicalPath(report.engine.id), at: selected.operation ? 'effect-response' : 'two-active',
        fault: selected.operation ? { operation: selected.operation, role: selected.role } : null },
    // The cut report names the supervisor requests still awaiting receipts when the worker suspends itself.
    outstandingRequests: () => channel.outstanding(),
    async checkpoint(record, entry, stored) {
      await channel.request('checkpoint', { label: entry.label, profile: entry.selected.profile, namespace: entry.namespace, record, stored });
    } };
  let example, workflowError, control, controlAdmission, topologyFence, acknowledgement, injected = false, faultCause;
  try {
    for (const name of ['@agen-ai/sandbox', '@agen-ai/sandbox-docker', '@agen-ai/sandbox-docker/node']) {
      assert(fileURLToPath(import.meta.resolve(name)).startsWith(`${config.consumer}/node_modules/`), 'Worker must resolve installed public SDK packages.');
    }
    context.sdk = await import('@agen-ai/sandbox'); context.docker = await import('@agen-ai/sandbox-docker');
    context.node = await import('@agen-ai/sandbox-docker/node');
    example = await loadConcurrencyExample(config);
    const route = context.node.createDockerDesktopRouteAuthority(config.capabilities.network.routeAuthority);
    context.coordinator = context.node.createDockerDesktopCoordinator({ routeAuthority: route, helper: config.capabilities.concurrency.helper });
    await context.coordinator.initialize({ timeoutMs: config.capabilities.limits.startupMs, signal: context.signal });
    context.authority = await context.coordinator.activate({ timeoutMs: config.capabilities.limits.startupMs, signal: context.signal });
    report.coordinator.generation = context.authority.generation;
    await channel.request('phase', { name: 'coordinator-active', state: context.coordinator.state });
    const suspend = (cut) => suspendWithOutstanding(report, context.outstandingRequests(), cut);
    const persisted = async (record, entry) => {
      if (entry.label === 'b' && selected.kind === 'crash' && ((selected.boundary === 'stop-entered' && record.phase === 'stopping')
        || (selected.boundary === 'cleanup-entered' && record.phase === 'destroying'))) suspend(() => suspendOriginalWorkflow(context, selected.boundary));
      if (entry.label !== 'b' || injected || !['interrupt', 'persistence'].includes(selected.kind)) return;
      const resource = record.resources.find(({ role }) => role === 'compute');
      const match = ['creating', 'identified'].includes(selected.boundary) ? resource?.identity.kind === selected.boundary : record.phase === selected.boundary;
      if (!match) return;
      injected = true; report.fault = { kind: selected.kind, boundary: selected.boundary, record, at: new Date().toISOString() };
      faultCause = new Error(`Explicit original B ${selected.kind} at ${selected.boundary}.`);
      await evidence.file('fault-original-checkpoint.json', report.fault);
      await channel.request('effect_phase', { name: 'fault-entered', fault: report.fault });
      if (selected.kind === 'interrupt') entry.cancellation.abort(faultCause);
      else throw faultCause;
    };
    const responseCut = (phase, receipt) => suspend(() =>
      suspendAtResponse({ ...context, members: context.members.filter(({ owner }) => owner) }, phase, receipt));
    const [a, b] = await Promise.all(config.capabilities.concurrency.members.map((member) => concurrentMember(context, member.label, member, persisted)));
    const replacementIndex = (selected.removalOrder ?? ['b', 'a'])[0] === 'a' ? 0 : 1;
    const c = await concurrentMember(context, 'c', config.capabilities.concurrency.members[replacementIndex], persisted);
    context.faultMember = b.entry;
    if (selected.kind === 'control_loss') control = installControlLoss({ socketPath: config.endpoint.slice(7), member: () => b.entry,
      role: selected.role, evidence });
    if (selected.kind === 'lost_ack' || selected.kind === 'crash' && selected.operation) {
      acknowledgement = installLostAcknowledgement({ socketPath: config.endpoint.slice(7), evidence,
        select: (options) => effectTarget(options, b.entry, selected),
        ...(selected.kind === 'lost_ack' ? { onErrorDeliveryCut: (receipt) => responseCut('request-error-listeners-returned', receipt) }
          : { onResponseCut: (receipt) => responseCut('response-before-delivery', receipt) }) });
    }
    const inputs = [a.input, b.input, c.input];
    inputs.forEach((input) => { input.forbidden = config.forbidden; });
    const result = await example.runConcurrentSandboxWorkflow({ coordinator: context.coordinator, members: [inputs[0], inputs[1]], replacement: inputs[2],
      startMode: selected.startMode ?? 'staged_addition', removalOrder: selected.removalOrder ?? ['b', 'a'],
      operationTimeoutMs: config.capabilities.limits.requestMs, signal: context.signal,
      async onOutput({ member, readerId, stream, bytes }) {
        await evidence.append(`${member}/original-${stream}.bin`, Buffer.from(bytes), config.capabilities.limits.maxOutputBytes);
        let output = report.output.find((entry) => entry.member === member && entry.stream === stream);
        if (!output) { output = { member, readerId, stream, bytes: 0, path: join(config.output, member, `original-${stream}.bin`) }; report.output.push(output); }
        assert.equal(output.readerId, readerId, 'Original output reader identity changed.'); output.bytes += bytes.length;
      },
      async onObservation(observation) {
        assert(report.observations.length < 256); report.observations.push(observation);
        if (observation.continuity) {
          const profile = (observation.member === 'b' ? b : observation.member === 'c' ? c : a).entry.selected.profile;
          assert.equal(observation.continuity.identity.architecture, profile.endsWith('rosetta-amd64') ? 'x64' : 'arm64');
        }
        await channel.request('observation', observation);
        if (selected.kind === 'interrupt' && selected.boundary === 'reserved' && observation.phase === 'reserved' && observation.member === 'b') {
          injected = true; report.fault = { kind: selected.kind, boundary: selected.boundary, record: observation.recoveryRecord };
          faultCause = new Error('Explicit original B interruption before acquisition.'); b.entry.cancellation.abort(faultCause);
          await channel.request('phase', { name: 'fault-entered', fault: report.fault });
        }
        if (observation.phase === 'dispatched' && observation.member === 'b') {
          if (selected.kind === 'control_loss') {
            await control.inject(); injected = true;
            await channel.request('phase', { name: 'fault-entered', role: selected.role, expectedDomain: selected.expectedDomain });
            controlAdmission = await captureControlLossAdmission({ control, coordinator: context.coordinator, members: [a.entry, b.entry],
              sdk: context.sdk, selected, timeoutMs: config.capabilities.limits.requestMs, signal: context.signal, evidence });
            report.controlLossAdmission = controlAdmission.receipt;
          }
          if (['foreign_endpoint', 'foreign_network'].includes(selected.kind)) {
            topologyFence = await captureTopologyFence({ coordinator: context.coordinator, members: [a.entry, b.entry], sdk: context.sdk,
              timeoutMs: config.capabilities.limits.requestMs, signal: context.signal, evidence, async inject() {
                await channel.request('inject', { selected, members: context.members.map((entry) => ({ label: entry.label, record: entry.owner?.recoveryRecord })) });
                injected = true;
              } });
            report.topologyFence = topologyFence.receipt;
          }
          if (selected.kind === 'crash' && selected.boundary === 'two-active' || selected.kind === 'lease_expiry') suspend(() => suspendOriginalWorkflow(context, 'two-active'));
        }
      } });
    report.result = result;
    if (selected.kind === 'persistence' && selected.boundary === 'destroyed') {
      report.faultOutcome = assertTerminalCheckpointFault({ selected, entry: b.entry, fault: report.fault, injected, cause: faultCause });
    } else assert.equal(selected.kind, 'workflow', 'The selected fault did not produce its required original failure.');
    report.status = 'passed';
  } catch (error) {
    report.primaryFailure = failure(error); workflowError = error;
    if (example && error instanceof example.ConcurrentSandboxWorkflowError) {
      report.workflowFailure = { primary: failure(error.primaryFailure.error), cleanup: error.cleanupFailures.map((item) => ({
        member: item.member, operation: item.operation, failure: failure(item.error) })) };
    }
    const state = context.coordinator?.state;
    if (state?.kind === 'fenced') {
      report.coordinator.fenceRejection = await context.coordinator.activate().then(
        () => ({ kind: 'unexpected_activation' }),
        (cause) => ({ kind: 'rejected', failure: failure(cause) }));
    }
    report.faultOutcome = { injected: injected || Boolean(acknowledgement?.report.selected), coordinator: state,
      memberStates: context.members.map((entry) => ({ label: entry.label, state: entry.owner?.state ?? null })) };
    try {
      if (state?.kind === 'fenced') assert.equal(report.coordinator.fenceRejection.kind, 'rejected',
        'An already-fenced original coordinator unexpectedly accepted activation.');
      await channel.request('fault_outcome', report.faultOutcome);
      if (selected.kind === 'control_loss') {
        Object.assign(report.faultOutcome, await classifyControlLoss({ injected, control, admission: controlAdmission,
          coordinator: context.coordinator, selected, observations: report.observations, sdk: context.sdk }));
      } else if (['foreign_endpoint', 'foreign_network'].includes(selected.kind)) {
        assert(injected); assert.equal(state.kind, 'fenced', 'Unregistered topology must fence the original group.');
        assert.equal(state.failure.kind, 'authority_lost');
        report.faultOutcome.topologyFence = assertTopologyFenceOutcome({ primary: error.primaryFailure?.error ?? error,
          fence: topologyFence, coordinator: context.coordinator, sdk: context.sdk });
      } else if (selected.kind === 'interrupt' || selected.kind === 'persistence') {
        assert(injected && !context.signal.aborted);
        report.faultOutcome.originalCheckpointFailure = assertCheckpointFault({ selected, primary: error.primaryFailure?.error ?? error,
          entry: context.faultMember, fault: report.fault, cause: faultCause });
      }
      else throw error;
      if (selected.kind === 'control_loss') {
        // A member-local control loss stopped only B.
        const exits = stoppedMemberExits(error, ['b']);
        assert(everyFailureBranch(error.primaryFailure?.error ?? error, (original) => sdkFenceFailure(original, context.sdk)
          || exits.has(original)),
          'An unrelated error cannot satisfy an injected control/topology failure.');
      }
      report.status = 'passed';
    } catch (outcomeError) { report.status = 'failed'; report.outcomeFailure = failure(outcomeError); }
  } finally {
    await channel.request('phase', { name: 'original-cleanup' }).catch((error) => report.cleanupFailures.push(failure(error)));
    const cleanupOriginal = async () => {
      const errors = [];
      if (workflowError && example && workflowError instanceof example.ConcurrentSandboxWorkflowError) {
        try { await workflowError.retryCleanup(); } catch (error) { errors.push(failure(error)); }
      }
      for (const entry of context.members.toReversed()) if (entry.owner) {
        try { await entry.owner.destroy(); entry.report.finalRecord = entry.owner.recoveryRecord; entry.report.finalState = entry.owner.state; }
        catch (error) { errors.push({ label: entry.label, failure: failure(error), record: entry.owner.recoveryRecord }); }
      }
      if (!errors.length && context.coordinator && context.coordinator.state.kind !== 'closed') {
        try {
          context.coordinator.closeAdmission(); await context.coordinator.settle({ timeoutMs: config.capabilities.limits.cleanupMs });
          await context.coordinator.close({ timeoutMs: config.capabilities.limits.cleanupMs });
          report.coordinator.final = context.coordinator.state; assert.equal(context.coordinator.state.kind, 'closed');
          assert.equal(context.coordinator.state.result, 'clean');
        } catch (error) { errors.push(failure(error)); }
      }
      report.cleanupFailures.push(...errors); report.cleanupComplete = errors.length === 0;
      if (errors.length) throw new AggregateError(errors.map((value) => new Error(JSON.stringify(value))), 'Original workflow cleanup remains owned.');
    };
    try { await cleanupOriginal(); }
    catch {
      report.status = 'failed';
      await retainCleanupOwner({ operation: cleanupOriginal, async onRetained(attempt) {
        if (attempt <= 16) await evidence.file(`retained-report-${String(attempt).padStart(3, '0')}.json`, report, 8 * 1024 ** 2);
        await channel.request('retained', { pid: process.pid, retrySignal: 'SIGUSR2', attempt }).catch(() => {});
      } });
    }
    report.control = await control?.close(); report.acknowledgement = await acknowledgement?.close();
    for (const output of report.output) { const bytes = readFileSync(output.path); assert.equal(bytes.length, output.bytes); output.sha256 = sha(bytes); }
    if (report.cleanupFailures.length) report.status = 'failed';
    report.finishedAt = new Date().toISOString(); await evidence.file('report.json', report, 8 * 1024 ** 2); await evidence.close();
    await channel.request('worker_complete', { status: report.status, cleanupComplete: report.cleanupComplete, report: join(config.output, 'report.json') }).catch(() => {});
    channel.close(); process.off('SIGTERM', interrupt); process.off('SIGINT', interrupt);
  }
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { assert.equal(process.argv.length, 3); await runConcurrencyWorker(process.argv[2]); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
}
