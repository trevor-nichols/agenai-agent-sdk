import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freemem, loadavg } from 'node:os';
import { lstat, mkdir, readFile, realpath, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine, until } from '../../../engine.mjs';
import { runOwnedCommand } from '../../../command.mjs';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { installedIdentity } from '../../../scalability/identity.mjs';
import { verifyObservedTuple } from '../../configuration.mjs';
import { createDaemonObserver, cleanupDaemonObserver } from '../../observer/index.mjs';
import { originalBytes, originalFile, exactAbsence, engineInventory, originalCanonical } from '../../coordinator-recovery/common.mjs';
import { failure } from '../../coordinator/evidence.mjs';
import { createFixtures } from '../network/fixtures.mjs';
import { backend, request } from '../network/installed.mjs';
import { identified } from '../network/resources.mjs';
import { jsonWriter } from '../live/evidence.mjs';
import { concurrencyCase, concurrencyCases, concurrencyEffects } from './cases.mjs';
import { admitConcurrencyTopology, concurrencyScenarioBudget } from './budget.mjs';
import { admitConcurrencyPreparation } from './admission.mjs';
import { concurrencyProofOwners } from './coverage.mjs';
import { loadConcurrencyExample } from './installed.mjs';
import { ConcurrencyEvidence, createPhaseCollector, createConcurrencyCapture } from './evidence.mjs';
import { retainCleanupOwner, runResidentCommand } from './ownership.mjs';
import { assertPhysicalWorkspace, denialBeforeTopology } from './denial.mjs';
import { createWorkerRequests } from './requests.mjs';
import { outstandingAtCut } from './cut-requests.mjs';
import { supersededContinuityControl } from './faults.mjs';
import { observeHelperExit } from './control-loss.mjs';
import { canonicalAfterCut, leaseSettled } from './cut-settlement.mjs';

function groupExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function processIdentity(pid) {
  const result = await runOwnedCommand({ command: '/bin/ps', args: ['-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'command='],
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeoutMs: 5000, maxOutputBytes: 16 * 1024 });
  assert(result.stdout.trim().startsWith(String(pid)), 'Original child process identity is unavailable.');
  return result.stdout;
}

async function originalChild({ context, inputPath, handle, recordCheckpoint }) {
  context.signal.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(new URL('worker.mjs', import.meta.url)), inputPath],
    { cwd: context.config.consumer, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const output = { stdout: [], stderr: [], bytes: 0, pid: child.pid, status: null, signal: null, closed: false,
    intervention: false, quiescent: false, originalIdentity: null, requests: 0 };
  let line = '', handoffStarted = false, failureValue;
  let original;
  context.liveChild = child; context.childState = output;
  const crash = async (ready) => {
    const cut = await originalFile(typeof ready.report === 'string' ? ready.report : ready.report.path, 8 * 1024 ** 2);
    assert.equal(cut.value.handoff.pid, child.pid);
    assert.equal(await processIdentity(child.pid), original, 'Original controller process identity changed before signaling.');
    const preserved = await originalBytes(cut.value.handoff.preservedCanonical.path, 4 * 1024 ** 2);
    assert.equal(preserved.identity.sha256, cut.value.handoff.canonical.sha256, 'Preserved cut canonical differs from its original read.');
    const selfSuspension = cut.value.handoff.cut.kind === 'synchronous-original-public-workflow-self-suspension';
    assert.equal(selfSuspension, ['crash', 'lease_expiry'].includes(context.selected.kind) && !context.selected.operation,
      'The cut kind does not match the selected case.');
    context.cutCanonical = { bytes: preserved.bytes, path: cut.value.handoff.canonical.path, successor: selfSuspension };
    const settled = async () => canonicalAfterCut(context.cutCanonical.bytes, (await originalCanonical(context.cutCanonical.path)).bytes,
      { successor: context.cutCanonical.successor });
    context.report.cutCanonical = await settled();
    context.report.originalCut = cut.identity;
    await context.collector.phase('fault-entered', { caseId: context.selected.id, originalCut: cut.identity });
    if (context.selected.kind === 'lease_expiry') {
      process.kill(child.pid, 'SIGSTOP');
      context.report.lease = { pauseIntent: new Date().toISOString(), originalPid: child.pid, observations: [] };
      const duration = Math.max(context.config.capabilities.filesystem.configuration.control.leaseTimeoutMs,
        context.config.capabilities.network.egress.configuration.control.leaseTimeoutMs,
        context.config.capabilities.network.routeAuthority.vmObserver.control.leaseTimeoutMs);
      const deadline = performance.now() + duration + context.config.capabilities.limits.cleanupMs;
      await until(async () => {
        assert(performance.now() < deadline, 'Paused-controller native helper lease settlement was not observed.');
        const states = [];
        for (const member of cut.value.handoff.members) {
          const stored = await originalFile(member.record.path, 65_536);
          // Compute states are retained as evidence; only leased helper/observer roles can settle a pause.
          for (const resource of stored.value.resources.filter(({ role, identity }) =>
            ['compute', 'filesystem', 'egress_broker', 'egress_relay', 'route_observer'].includes(role) && identity.kind === 'identified')) {
            const response = await context.engine.request('GET', `/containers/${resource.identity.id}/json`, undefined, { allowed: [200, 404] });
            states.push({ role: resource.role, id: resource.identity.id, status: response.status,
              running: response.status === 200 ? response.data.State.Running : false });
          }
        }
        context.report.lease.observations.push({ at: new Date().toISOString(), states });
        assert(context.report.lease.observations.length <= Math.ceil((duration + context.config.capabilities.limits.cleanupMs) / 250) + 1);
        if (leaseSettled(states)) return true;
        await delay(250); return false;
      }, duration + context.config.capabilities.limits.cleanupMs, 'Native lease expiry deadline.');
    } else if (ready.status === 'handoff_ready') process.kill(child.pid, 'SIGSTOP');
    // Exact identity and immutable cut bytes are rechecked immediately before termination.
    assert.equal(await processIdentity(child.pid), original);
    if (context.selected.kind !== 'lease_expiry') context.report.cutCanonical = await settled();
    process.kill(child.pid, 'SIGKILL'); output.selectedSignalSent = true;
    if (ready.status === 'cut_ready') context.collector.bindCut({ cut: cut.identity, outstanding: outstandingAtCut(context.selected, cut.value) });
  };
  const requests = createWorkerRequests({ maximumMessages: context.config.scenarioBudget.maximumMessages,
    members: () => context.report.members, recordCheckpoint, handle,
    reply: (id, outcome) => { if (child.connected) child.send({ kind: 'reply', id, ...outcome }); },
    fail: (error) => { failureValue ??= error; } });
  child.on('message', (message) => { requests.receive(message); output.requests = requests.count; });
  child.stdout.on('data', (chunk) => {
    output.bytes += chunk.length;
    if (output.bytes > 256 * 1024) { failureValue ??= new Error('Original child diagnostics exceeded their byte capacity.'); return; }
    output.stdout.push(Buffer.from(chunk)); line += chunk.toString('utf8');
    for (;;) {
      const end = line.indexOf('\n'); if (end < 0) break;
      const text = line.slice(0, end); line = line.slice(end + 1);
      try {
        const item = JSON.parse(text);
        if (['handoff_ready', 'cut_ready'].includes(item.status) && !handoffStarted) {
          handoffStarted = true; if (item.status === 'cut_ready') context.handoff.abort();
          requests.enqueue(() => crash(item));
        }
      } catch { /* Ordinary diagnostics are retained unchanged below. */ }
    }
  });
  child.stderr.on('data', (chunk) => {
    output.bytes += chunk.length;
    if (output.bytes <= 256 * 1024) output.stderr.push(Buffer.from(chunk));
    else failureValue ??= new Error('Original child diagnostics exceeded their byte capacity.');
  });
  child.once('error', (error) => { failureValue ??= error; if (!child.pid) context.childNeverStarted = true; });
  child.once('exit', (status, signal) => { output.status = status; output.signal = signal; });
  child.once('close', () => { output.closed = true; });
  original = await processIdentity(child.pid); output.originalIdentity = original;
  const deadline = performance.now() + context.config.capabilities.limits.scenarioMs;
  while ((!output.closed || groupExists(child.pid)) && performance.now() < deadline) await delay(25);
  await requests.settled();
  output.quiescent = output.closed && !groupExists(child.pid);
  if (!output.quiescent) {
    const { stdout: _stdout, stderr: _stderr, ...retained } = output;
    context.report.retainedChild = { ...retained, failure: failure(failureValue ?? new Error('Original child remains active.')) };
    throw new Error('Original controller/holder remains owned; no replacement controller may start.');
  }
  await context.evidence.file('worker-stdout.log', Buffer.concat(output.stdout), 256 * 1024);
  await context.evidence.file('worker-stderr.log', Buffer.concat(output.stderr), 256 * 1024);
  delete output.stdout; delete output.stderr;
  context.report.predecessorQuiescence = await context.evidence.file('predecessor-quiescence.json', output, 64 * 1024);
  if (failureValue) throw failureValue;
  if (['crash', 'lost_ack', 'lease_expiry'].includes(context.selected.kind)) assert(output.signal === 'SIGKILL' && output.selectedSignalSent === true);
  return output;
}

export async function runConcurrencyController(path) {
  const input = await originalFile(path, 1024 ** 2), config = input.value;
  assert.equal(config.format, 'agenai.sandbox-platform-concurrency-controller.v1');
  assert.equal(await realpath(config.consumer), config.consumer); assert.equal(process.cwd(), config.consumer);
  assert(fileURLToPath(import.meta.url).startsWith(`${config.consumer}/qualification/`));
  assert.deepEqual(concurrencyScenarioBudget(config.capabilities), config.scenarioBudget);
  await admitConcurrencyPreparation(config.capabilities, config.platform);
  await loadConcurrencyExample(config);
  assert.deepEqual(await installedIdentity(config.consumer), config.installedIdentity);
  const selected = concurrencyCase(config.capabilities.concurrency.caseId);
  const evidence = new ConcurrencyEvidence(config.output, config.capabilities.concurrency.evidence.maxAttemptBytes, config.scenarioBudget);
  await evidence.initialize(input.bytes);
  const report = { format: 'agenai.sandbox-platform-desktop-concurrency.v1', status: 'running', selected,
    composition: config.capabilities.concurrency.composition, input: input.identity, entrypoint: config.entrypoint,
    sourceIdentity: config.sourceIdentity, installedIdentity: config.installedIdentity, scenarioBudget: config.scenarioBudget,
    inventory: concurrencyCases.map((entry) => ({ ...entry, status: 'pending' })), effects: concurrencyEffects, proofOwners: concurrencyProofOwners,
    startedAt: new Date().toISOString(), primaryFailure: null, cleanup: { complete: false, failures: [] }, members: {}, counterControls: [], supersededControls: [] };
  const writeReport = jsonWriter(join(config.output, 'report.json'));
  const save = () => {
    if (proxy) report.proxyAdmission = proxy.capacity();
    assert(Buffer.byteLength(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2)) + 1 <= config.scenarioBudget.maximumReportBytes,
      'Concurrency report exceeded its calculated metadata capacity.');
    return writeReport(report);
  };
  const captureCancellation = new AbortController();
  const collector = createPhaseCollector({ evidence, budget: config.scenarioBudget,
    responseBytes: config.capabilities.concurrency.evidence.maxResponseBytes, requiredPhases: config.scenarioBudget.requiredPhases,
    onFailure(error) {
      report.captureFailure ??= failure(error); captureCancellation.abort(error);
      if (context.liveChild && !context.childState.closed) context.liveChild.kill('SIGTERM');
    } });
  const observerIds = new Map();
  const capture = createConcurrencyCapture({ collector, budget: config.scenarioBudget, observerIds, maxResponseBytes: config.capabilities.concurrency.evidence.maxResponseBytes });
  const context = { config, selected, report, evidence, collector, observerIds, handoff: new AbortController(),
    signal: AbortSignal.any([captureCancellation.signal, AbortSignal.timeout(config.capabilities.limits.scenarioMs)]),
    async probeSource() {
      return (await readFile(new URL('../../../capabilities/desktop/guest.mjs', import.meta.url), 'utf8'))
        + `\nconst command=JSON.parse(process.argv[1]);const timeoutMs=${config.capabilities.limits.requestMs - 250};try{const result=command.kind==='controls'?await Promise.all(command.commands.map(value=>runGuest({...value,timeoutMs}))):await runGuest({...command,timeoutMs});process.stdout.write(JSON.stringify({ok:true,result})+'\\n');}catch(error){process.stdout.write(JSON.stringify({ok:false,error:{name:error.name,code:error.code??null,message:error.message}})+'\\n');}\n`;
    }, async assertNoActiveOwners() { assert.equal(context.bootstrap?.state.kind, 'destroyed'); } };
  const retryOriginal = () => {
    if (context.recoveryResident) context.recoveryResident.retryCleanup();
    else if (context.liveChild && !context.childState.closed) {
      if (context.workerRetained) context.liveChild.kill('SIGUSR2');
      else if (report.originalCut && !context.childState.selectedSignalSent) context.liveChild.kill('SIGCONT');
    }
  };
  process.on('SIGUSR2', retryOriginal);
  const stopAdmission = () => { context.liveChild?.kill('SIGTERM'); };
  process.on('SIGTERM', stopAdmission); process.on('SIGINT', stopAdmission);
  let observer, proxy, fixtures, fault, workerConfiguration;
  let observerEntered = false;
  const observerRecordPath = join(config.output, 'observer/record.json');
  const direct = new Engine(config.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs, outputBytes: 4 * 1024 ** 2 });
  const records = [];
  try {
    await collector.phase('attempt-admitted'); await save();
    const floor = config.capabilities.concurrency.machine;
    report.machine = { freeMemoryBytes: freemem(), availableMemoryBytes: process.availableMemory(),
      node: process.versions.node, libuv: process.versions.uv, loadAverage: loadavg(), policy: floor };
    assert(report.machine.availableMemoryBytes >= floor.minimumAvailableMemoryBytes && report.machine.loadAverage[0] <= floor.maximumLoadAverage,
      'Captured machine resource floors refuse new native work.');
    const disk = await statfs(config.output, { bigint: true });
    report.machine.freeDiskBytes = String(disk.bavail * disk.bsize);
    assert(disk.bavail * disk.bsize >= BigInt(config.capabilities.concurrency.evidence.maxAttemptBytes + 64 * 1024 ** 2),
      'Captured disk floor must hold the complete admitted evidence budget plus publication margin before native effects.');
    report.platform = verifyObservedTuple(config.platform, (await direct.request('GET', '/version')).data, (await direct.request('GET', '/info')).data);
    report.initialInventory = await engineInventory(direct);
    report.topologyAdmission = admitConcurrencyTopology(config.scenarioBudget, report.initialInventory);
    const imageRoles = [[config.platform.observerImage, 'arm64'],
      ...config.capabilities.concurrency.members.map((member) => [member.imageDigest, member.profile.endsWith('rosetta-amd64') ? 'amd64' : 'arm64']),
      ...[config.capabilities.filesystem.configuration.imageDigest, config.capabilities.network.egress.configuration.imageDigest,
        config.capabilities.network.routeAuthority.vmObserver.imageDigest, config.capabilities.network.fixtures.imageDigest].map((image) => [image, 'arm64'])];
    report.images = [];
    for (const [id, architecture] of imageRoles) {
      const actual = (await direct.request('GET', `/images/${id}/json`)).data;
      assert.equal(actual.Id, id); assert.equal(actual.Architecture, architecture); assert.equal(actual.Os, 'linux');
      assert.equal(Object.keys(actual.Config?.Volumes ?? {}).length, 0); report.images.push(actual);
    }
    const images = [...new Set(config.capabilities.concurrency.members.map(({ imageDigest }) => imageDigest))];
    observerEntered = true;
    observer = await createDaemonObserver({ endpoint: config.endpoint, imageDigest: config.platform.observerImage, architecture: 'arm64',
      output: join(config.output, 'observer'), maxScopes: config.scenarioBudget.observerCapacity,
      roleImages: { compute: images, export: images, filesystem: [config.capabilities.filesystem.configuration.imageDigest],
        egress_broker: [config.capabilities.network.egress.configuration.imageDigest], egress_relay: [config.capabilities.network.egress.configuration.imageDigest],
        route_observer: [config.capabilities.network.routeAuthority.vmObserver.imageDigest] }, namespacePrefixes: [config.namespacePrefix],
      qualificationFixtures: { owner: config.fixtureOwner, public_marker: [config.capabilities.network.fixtures.imageDigest], vm_marker: [config.capabilities.network.fixtures.imageDigest] } });
    const beforeTopology = denialBeforeTopology(context);
    proxy = await createTraceProxy({ socketPath: join(config.output, 'e.sock'), upstreamEndpoint: config.endpoint,
      maxConnections: config.scenarioBudget.proxy.maxConnections, maxActiveRequests: config.scenarioBudget.proxy.maxActiveRequests,
      maxPendingRequests: config.scenarioBudget.proxy.maxPendingRequests,
      tracePath: join(config.output, 'engine-requests.jsonl'), observeResponse: observer.observeResponse,
      observeRequest: async (value) => { capture.observeRequest(value); await beforeTopology(value); },
      observeResponseBody: capture.observeResponseBody, observeRequestSettled: capture.observeRequestSettled, observeUpgrade: capture.observeUpgrade });
    proxy.setRow('desktop-concurrency');
    const socket = await lstat(proxy.endpoint.slice(7), { bigint: true });
    report.endpointProjection = { originalEndpoint: config.endpoint, effectiveEndpoint: proxy.endpoint,
      engineId: config.platform.expected.daemon.id, device: String(socket.dev), inode: String(socket.ino),
      originalRouteDescriptor: config.capabilities.network.routeAuthority };
    const effectiveCapabilities = { ...config.capabilities, network: { ...config.capabilities.network, routeAuthority: {
      ...config.capabilities.network.routeAuthority, engine: { ...config.capabilities.network.routeAuthority.engine, endpoint: proxy.endpoint } } } };
    const fixtureConfig = { ...config, endpoint: proxy.endpoint, capabilities: effectiveCapabilities };
    context.engine = new Engine(proxy.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs, outputBytes: 4 * 1024 ** 2 });
    const fixtureContext = { ...context, config: fixtureConfig };
    fixtures = await createFixtures(fixtureContext); context.fixtures = fixtures;
    await fixtures.startBase({ includeForeignMarker: selected.kind === 'foreign_endpoint' });
    await collector.phase('fixture-bootstrap', { captureRequired: true });
    const bootstrapDirectory = join(config.output, 'bootstrap'); await mkdir(bootstrapDirectory, { mode: 0o700 });
    const bootstrap = await backend(fixtureConfig, { namespace: `${config.namespacePrefix}bootstrap`, directory: bootstrapDirectory });
    const target = fixtures.targets().specialHost;
    context.bootstrap = bootstrap.backend.reserve(request(fixtureConfig, { destinations: [
      { hostname: effectiveCapabilities.network.positive.hostname, port: 443 },
      { hostname: effectiveCapabilities.network.fixtures.publicHostname, port: 443 }, { hostname: 'host.docker.internal', port: target.port }],
    }), { kind: 'persisted', persist: async (record) => {
      await jsonWriter(join(bootstrapDirectory, 'recovery.json'))(record);
      for (const resource of record.resources) if (resource.role === 'route_observer' && resource.identity.kind === 'identified') {
        observerIds.set(resource.identity.id, { label: 'bootstrap', namespace: `${config.namespacePrefix}bootstrap`, profile: config.profile });
      }
    } });
    await context.bootstrap.start({ signal: context.signal });
    await fixtures.captureBootstrap({ observe: (value) => evidence.event(value) }, { entry: { namespace: `${config.namespacePrefix}bootstrap`, owner: context.bootstrap }, owner: context.bootstrap });
    const specialDns = await fixtures.probeBroker(null, { owner: context.bootstrap }, { kind: 'lookup', hostname: 'host.docker.internal' });
    assert.equal(specialDns.ipv4.length, 1, 'Special-host direct control requires one exact captured IPv4 address.');
    report.specialHostResolution = specialDns;
    await context.bootstrap.destroy(); records.push(context.bootstrap.recoveryRecord);
    await fixtures.activatePublic();
    report.baselineInventory = await engineInventory(context.engine);
    report.fixedFixtures = structuredClone(fixtures.record);
    const targets = fixtures.targets();
    const forbidden = ['host', 'specialHost', 'vmHost', 'gateway', 'sibling', 'siblingMarker'].map((name) => ({
      name, hostname: targets[name].host, address: name === 'specialHost' ? specialDns.ipv4[0] : targets[name].host,
      port: targets[name].port, probe: targets[name].probe, marker: targets[name].marker, transport: 'tcp' }));
    forbidden.push({ ...forbidden.find(({ name }) => name === 'siblingMarker'), name: 'sibling-udp', transport: 'udp' });
    forbidden.push({ ...forbidden.find(({ name }) => name === 'sibling'), name: 'public-alias', hostname: effectiveCapabilities.network.fixtures.publicHostname });
    workerConfiguration = { ...config, format: 'agenai.sandbox-concurrency-worker.v1', output: join(config.output, 'worker'),
      endpoint: proxy.endpoint, capabilities: effectiveCapabilities, forbidden: forbidden.map(({ name: _name, ...fixture }) => fixture) };
    const workerInput = await evidence.file('worker-input.json', workerConfiguration, 1024 ** 2);
    let counters;
    const recordCheckpoint = (value) => {
      report.members[value.label] = value;
      for (const resource of value.record.resources) if (resource.role === 'route_observer' && resource.identity.kind === 'identified') {
        observerIds.set(resource.identity.id, { label: value.label, namespace: value.namespace, profile: value.profile });
      }
    };
    const handle = async (kind, value, members, requestId) => {
      if (kind === 'phase' || kind === 'effect_phase') {
        if (value.name === 'fault-entered' && value.role === 'route_observer') context.failedObserverMember = 'b';
        if (value.name === 'fault-entered') context.faultEntered = true;
        if (value.name === 'fault-entered' && selected.kind === 'control_loss') {
          context.failedMember = 'b';
          const helper = (label) => ({ label, id: identified(members[label].record, value.role).identity.id });
          context.controlWitness = observeHelperExit({ engine: context.engine, selected: helper('b'), peer: helper('a'),
            timeoutMs: Math.floor(config.capabilities.limits.requestMs / 2) }).catch((error) => ({ failure: failure(error) }));
        }
        await collector.phase(value.name, value); await context.engine.request('GET', '/networks'); return;
      }
      if (kind === 'output') { await evidence.event({ kind: 'original-primary-output-receipt', ...value }); return; }
      if (kind === 'observation') {
        const phaseName = value.member ? `${value.phase}:${value.member}` : value.phase;
        const vmRequired = Object.values(members).filter((member) => !context.expectedGroupFence
          && member.label !== context.failedObserverMember && member.record.phase === 'running')
          .flatMap((member) => member.record.resources.filter(({ role, identity }) => role === 'route_observer' && identity.kind === 'identified')
            .map(({ identity }) => identity.id));
        await collector.phase(phaseName, { observation: value, requestId, captureRequired: true, vmCandidates: vmRequired });
        await context.engine.request('GET', '/networks');
        if (value.phase === 'prepared') await assertPhysicalWorkspace(context, members[value.member]);
        if (vmRequired.length) await collector.awaitNative(vmRequired, { timeoutMs: config.capabilities.limits.requestMs, signal: context.handoff.signal });
        const superseded = value.phase.endsWith('continuity_before') && supersededContinuityControl(value, { faultEntered: context.faultEntered,
          failedMember: context.failedMember, topologyInjected: context.topologyInjected });
        if (superseded) {
          report.supersededControls.push({ member: value.member, checkpoint: value.checkpoint, observationSequence: value.sequence,
            requestId, reason: superseded, coordinator: value.coordinator?.kind ?? null, recordPhase: members[value.member]?.record.phase ?? null });
        } else if (value.phase.endsWith('continuity_before')) {
          const member = members[value.member]; assert(member);
          const broker = identified(member.record, 'egress_broker');
          const results = await fixtures.execute(null, broker.identity.id, { kind: 'controls', commands: forbidden.map((fixture) => ({
            kind: fixture.transport, host: fixture.address, port: fixture.port, probe: fixture.probe, reply: true })) });
          forbidden.forEach((fixture, index) => assert.equal(results[index].bytes, fixture.marker,
            'A forbidden target is unreachable from the independent broker control.'));
          const before = await until(async () => {
            const actual = await fixtures.census(); return Object.values(actual).every(({ active }) => active === 0) ? actual : false;
          }, config.capabilities.limits.requestMs, 'Independent control sockets did not join.');
          counters = { member: value.member, checkpoint: value.checkpoint, before, controls: results };
        }
        if (value.phase.endsWith('continuity') && value.continuity) {
          assert(!context.topologyInjected, 'A fenced original group cannot report healthy member continuity.');
          assert(!report.supersededControls.some(({ member, checkpoint }) => member === value.member && checkpoint === value.checkpoint),
            'A member whose independent controls the selected failure superseded reported continuity.');
          assert(counters && counters.member === value.member && counters.checkpoint === value.checkpoint);
          const after = await fixtures.census(); assert.deepEqual(after, counters.before, 'A forbidden listener received an original-primary attempt.');
          assert.equal(value.continuity.forbidden.length, forbidden.length);
          report.counterControls.push({ ...counters, after, observationSequence: value.sequence }); counters = null;
        }
        return;
      }
      if (kind === 'inject') {
        context.expectedGroupFence = true; context.topologyInjected = true; context.faultEntered = true;
        await collector.phase('fault-entered', { selected });
        if (selected.kind === 'foreign_endpoint') {
          const container = fixtures.record.resources.find((item) => item.role === 'public_marker' && item.state === 'running'
            && item.body.HostConfig.NetworkMode === 'bridge'); assert(container);
          const network = identified(value.members.find(({ label }) => label === 'b').record, 'network');
          fault = { kind: 'endpoint', container: container.id, network: network.identity.id };
          await evidence.file('foreign-topology-intent.json', fault);
          await context.engine.request('POST', `/networks/${fault.network}/connect`, { Container: fault.container });
        } else {
          const body = { Driver: 'bridge', Internal: true, EnableIPv6: false,
            Labels: { 'ai.agen.sandbox.backend': 'agenai-docker', 'ai.agen.sandbox.namespace': `${config.namespacePrefix}unregistered`, 'ai.agen.sandbox.role': 'network' } };
          fault = { kind: 'network', name: `${config.namespacePrefix}unregistered`, id: null, body };
          await evidence.file('foreign-topology-intent.json', fault);
          fault.id = (await context.engine.request('POST', '/networks/create', { ...body, Name: fault.name })).data.Id;
        }
        await evidence.file('foreign-topology-entered.json', fault); return;
      }
      if (kind === 'fault_outcome') {
        report.faultOutcome = value;
        if (fault) {
          if (fault.kind === 'endpoint') await context.engine.request('POST', `/networks/${fault.network}/disconnect`, { Container: fault.container, Force: false });
          else await context.engine.request('DELETE', `/networks/${fault.id}`);
          fault.cleaned = true;
        }
        if (context.controlWitness) report.controlLossWitness = await context.controlWitness;
        return report.controlLossWitness;
      }
      if (kind === 'retained') {
        context.workerRetained = true;
        report.retainedWorker = value; await save();
        process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', pid: process.pid, retrySignal: 'SIGUSR2', originalWorker: value.pid })}\n`);
        return;
      }
      assert.equal(kind, 'worker_complete'); report.workerComplete = value;
    };
    report.child = await originalChild({ context, inputPath: workerInput.path, handle, recordCheckpoint });
    if (report.originalCut) {
      // Recovery opens the live canonical, so its relation to the preserved cut bytes is proven after quiescence.
      report.recoveryCanonical = canonicalAfterCut(context.cutCanonical.bytes, (await originalCanonical(context.cutCanonical.path)).bytes,
        { successor: context.cutCanonical.successor });
      await collector.phase('original-cleanup', { captureRequired: true });
      const recoveryInput = { format: 'agenai.sandbox-concurrency-recovery.v1', workerInput: workerInput.path,
        originalReport: report.originalCut.path, predecessorQuiescence: report.predecessorQuiescence.path,
        output: join(config.output, 'recovery') };
      const recoveryPath = await evidence.file('recovery-input.json', recoveryInput, 1024 ** 2);
      const command = await runResidentCommand({ command: process.execPath, args: [fileURLToPath(new URL('recovery.mjs', import.meta.url)), recoveryPath.path],
        cwd: config.consumer, env: process.env, directory: join(config.output, 'recovery-command'), timeoutMs: 4 * config.capabilities.limits.cleanupMs });
      report.recoveryCommand = command;
      if (command.disposition === 'retained_cleanup') {
        context.recoveryResident = command; context.recoveryReportPath = join(recoveryInput.output, 'report.json');
        throw new Error('Original cleanup-only recovery owner remains resident.');
      }
      const cleanup = await originalFile(join(recoveryInput.output, 'report.json'), 8 * 1024 ** 2); assert.equal(cleanup.value.status, 'passed'); report.recovery = cleanup.identity;
      const freshInput = await evidence.file('fresh-process-input.json', { ...recoveryInput, output: join(config.output, 'fresh-process'),
        settledRecords: cleanup.value.settledRecords }, 1024 ** 2);
      report.freshCommand = await runResidentCommand({ command: process.execPath,
        args: [fileURLToPath(new URL('recovery.mjs', import.meta.url)), '--absent', freshInput.path],
        cwd: config.consumer, env: process.env, directory: join(config.output, 'fresh-command'), timeoutMs: 2 * config.capabilities.limits.cleanupMs });
      if (report.freshCommand.disposition === 'retained_cleanup') {
        context.recoveryResident = report.freshCommand; context.recoveryReportPath = join(config.output, 'fresh-process/report.json');
        throw new Error('Original fresh-process absence owner remains resident.');
      }
      const fresh = await originalFile(join(config.output, 'fresh-process/report.json'), 8 * 1024 ** 2);
      assert.equal(fresh.value.status, 'passed'); assert.equal(fresh.value.reconcilePerformed, false); report.freshRecovery = fresh.identity;
      for (const stored of cleanup.value.settledRecords) records.push((await originalFile(stored.path, 65_536)).value);
    } else {
      const worker = await originalFile(join(workerConfiguration.output, 'report.json'), 8 * 1024 ** 2);
      report.worker = worker.identity;
      records.push(...worker.value.members.flatMap((member) => member.finalRecord ? [member.finalRecord] : []));
      assert.equal(worker.value.status, 'passed');
      if (selected.kind === 'workflow') {
        for (const label of ['b', 'c']) {
          const proof = report.denialBeforeTopology?.find((entry) => entry.path.endsWith(`-${label}.json`)); assert(proof);
          const actual = await originalFile(proof.path, 4 * 1024 ** 2);
          assert(actual.value.brokerPolicies.length > 0, 'Required candidate admission lacks an original live broker denied-coverage proof.');
        }
        assert.equal(report.physicalWorkspaces.length, 3, 'Each original and replacement workspace needs independent physical readback.');
      }
    }
    await collector.phase('exact-absence', { captureRequired: true }); report.absence = await exactAbsence(context.engine, records);
    report.status = 'passed';
  } catch (error) { report.primaryFailure = failure(error); report.status = 'failed'; }
  finally {
    // The bounded helper witness settles before its proxy and capture close.
    if (context.controlWitness) report.controlLossWitness ??= await context.controlWitness;
    if (context.bootstrap && context.bootstrap.state.kind !== 'destroyed') {
      try { await context.bootstrap.destroy(); } catch (error) { report.cleanup.failures.push(failure(error)); }
    }
    const finishOuter = async () => {
      if (context.bootstrap && context.bootstrap.state.kind !== 'destroyed') await context.bootstrap.destroy();
      if (context.liveChild && (!context.childState.closed || groupExists(context.liveChild.pid))) {
        throw new Error('Original workflow process or holder remains active; proxy and independent observer retained.');
      }
      let memberSafe = !context.liveChild || context.childNeverStarted || report.workerComplete?.cleanupComplete === true || Boolean(report.freshRecovery);
      if (context.recoveryResident) {
        assert(!groupExists(context.recoveryResident.pid), 'Original cleanup-only process remains active.');
        const receipt = await originalFile(context.recoveryReportPath, 8 * 1024 ** 2);
        assert.equal(receipt.value.cleanupComplete, true, 'Original recovery did not settle its complete cleanup obligations.');
        for (const stored of receipt.value.settledRecords) records.push((await originalFile(stored.path, 65_536)).value);
        report.retainedRecoverySettlement = receipt.identity; memberSafe = true;
      }
      if (!memberSafe && workerConfiguration && !report.originalCut) {
        const receipt = await originalFile(join(workerConfiguration.output, 'report.json'), 8 * 1024 ** 2);
        assert.equal(receipt.value.cleanupComplete, true);
        records.push(...receipt.value.members.flatMap((member) => member.finalRecord ? [member.finalRecord] : []));
        report.retainedWorkerSettlement = receipt.identity; memberSafe = true;
      }
      assert(memberSafe, 'Exact member cleanup remains unproven; original endpoint authority is retained.');
      if (records.length) report.cleanupAbsence = await exactAbsence(context.engine, records);
      if (fixtures) await fixtures.close({ releaseNetworks: true });
      if (observer && !report.kernelAbsence) {
        assert(observer.record.scopes.length <= config.scenarioBudget.maximumScopes, 'Observed scopes exceeded the frozen resource census.');
        report.kernelAbsence = await observer.assertAllEmpty(); await observer.close(); report.observer = observer.record;
      } else if (observerEntered && !observer) {
        report.observer = await cleanupDaemonObserver({ endpoint: config.endpoint, recordPath: observerRecordPath });
        report.kernelAbsence = report.observer.finalCensus;
      }
      if (proxy && !report.proxy) {
        await proxy.close(); report.proxy = { closed: true, endpoint: proxy.endpoint, tracePath: proxy.tracePath,
          summary: proxy.summary('desktop-concurrency'), admission: proxy.capacity() };
      }
    };
    try { await finishOuter(); }
    catch (error) {
      report.status = 'failed'; report.cleanup.failures.push(failure(error));
      await retainCleanupOwner({ async operation() {
        try { await finishOuter(); }
        catch (cause) { report.cleanup.failures.push(failure(cause)); throw cause; }
      }, async onRetained(attempt) {
        report.retainedOwner = { pid: process.pid, retrySignal: 'SIGUSR2', attempt,
          endpoint: proxy?.endpoint, observerRecord: observerEntered ? observerRecordPath : undefined, originalWorker: context.liveChild?.pid,
          originalRecovery: context.recoveryResident?.pid };
        await save();
        process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', ...report.retainedOwner })}\n`);
      } });
    }
    const admission = proxy?.capacity();
    if (admission && (admission.connections.rejected > 0 || admission.requests.rejected > 0)) {
      collector.fail(new Error('Qualification proxy refused original traffic because its admitted capacity was exhausted.'));
    }
    const absentContainers = new Set([...(report.absence ?? []), ...(report.cleanupAbsence ?? [])]
      .filter(({ status }) => status === 404).map(({ reference }) => reference));
    report.capture = await capture.close({ absentContainers }); report.phaseCapture = await collector.close();
    report.fixtures = fixtures?.record;
    report.cleanup.complete = Boolean(report.kernelAbsence?.kernelEmpty) && Boolean(fixtures?.record.closed) && Boolean(report.proxy);
    if (!report.cleanup.complete || report.phaseCapture.completeness !== 'complete') report.status = 'failed';
    for (const image of report.images ?? []) {
      try { assert.deepEqual((await direct.request('GET', `/images/${image.Id}/json`)).data, image, 'Borrowed source/helper image changed.'); }
      catch (error) { report.status = 'failed'; report.cleanup.failures.push(failure(error)); }
    }
    if (report.cleanup.complete) {
      try { report.finalInventory = await engineInventory(direct); assert.deepEqual(report.finalInventory, report.initialInventory,
        'Qualification changed unrelated Engine resource identities or left owned resources present.'); }
      catch (error) { report.status = 'failed'; report.cleanup.failures.push(failure(error)); }
    }
    const result = report.inventory.find(({ id }) => id === selected.id); result.status = report.status;
    report.finishedAt = new Date().toISOString(); await save(); await evidence.close();
    process.off('SIGUSR2', retryOriginal); process.off('SIGTERM', stopAdmission); process.off('SIGINT', stopAdmission);
  }
  if (report.status !== 'passed') process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ status: report.status, caseId: selected.id, report: join(config.output, 'report.json') })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { assert.equal(process.argv.length, 3); await runConcurrencyController(process.argv[2]); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
}
