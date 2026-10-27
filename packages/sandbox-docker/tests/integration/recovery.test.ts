// ------------------------------------------------------------------------------------------------
//                recovery.test.ts - Fresh cleanup-only controller recovery - Independent real Engine proof
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseSandboxRecoveryRecord, SandboxValidationError } from '@agen-ai/sandbox';
import type { SandboxCleanupOwner, SandboxRecoveryRecord, SandboxReservation } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { atomicJson, collectBytes, engineGet, failureSummary, fixturePlatform, observeResource, openSuite,
  reservePersisted, resourceId, sandboxRequest } from './support/common.js';
import type { ResourceObservation } from './support/common.js';
import { checkCleanupEvidence } from './support/evidence.js';
import type { CleanupEvidenceEvent, CleanupEvidenceReport, CleanupEvidenceRow } from './support/evidence.js';
import { createFaultProxy } from './support/fault-proxy.js';
import type { FaultGate } from './support/fault-proxy.js';
import { checkDatasetSnapshot, datasetBackend, selectedDataset, startDatasetPeer } from './support/dataset.js';

function data(value: unknown): Record<string, unknown> {
  const isData = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
  assert(isData(value));
  return value;
}

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse((await collectBytes(createReadStream(filename))).toString('utf8'));
}

function message(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); child.removeListener('message', received); child.removeListener('close', closed); child.removeListener('error', failed); };
    const received = (input: unknown) => {
      try { const value = data(input); assert.equal(value.kind, kind); finish(); resolve(value); }
      catch (error) { finish(); reject(error); }
    };
    const failed = (error: Error) => { finish(); reject(error); };
    const closed = () => { finish(); reject(new Error(`Controller closed before ${kind}.`)); };
    const timer = setTimeout(() => { finish(); reject(new Error(`Controller did not report ${kind} within its deadline.`)); }, 90_000);
    child.once('message', received);
    child.once('close', closed);
    child.once('error', failed);
  });
}

function controller(mode: 'start' | 'create' | 'recover', configPath: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/recovery-controller.mjs', import.meta.url)), [mode, configPath], {
    execArgv: [], env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => {});
  assert(child.stdout && child.stderr);
  const output = Promise.all([collectBytes(child.stdout), collectBytes(child.stderr)]);
  void output.catch(() => { child.kill('SIGKILL'); });
  return { child, closed, output };
}

function mutateEngine(endpoint: string, method: 'POST' | 'DELETE', route: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (encoded) assert(encoded.byteLength <= 16_384);
    const operation = request({ socketPath: endpoint.slice(7), path: `/v1.52${route}`, method, agent: false,
      headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.byteLength } : {},
    }, (response) => {
      const collected = collectBytes(response, 65_536);
      void collected.then((bytes) => {
        assert(response.statusCode !== undefined);
        resolve({ status: response.statusCode, body: bytes.length ? JSON.parse(bytes.toString('utf8')) : null });
      }).catch(reject);
    });
    const timer = setTimeout(() => operation.destroy(new Error('Exact sentinel fixture operation timed out.')), 15_000);
    operation.once('close', () => clearTimeout(timer));
    operation.once('error', reject);
    operation.end(encoded);
  });
}

type SentinelPlan =
  | Readonly<{ role: 'compute'; name: string; imageDigest: string; labels: Readonly<Record<string, string>> }>
  | Readonly<{ role: 'storage'; name: string; labels: Readonly<Record<string, string>> }>;
type Sentinel = SentinelPlan & Readonly<{ id: string }>;

test('fresh controller reconciles cleanup only after exact controller death and preserves unrelated resources', { timeout: 600_000 }, async () => {
  const suite = await openSuite('recovery');
  const { endpoint, directory } = suite;
  const selected = process.env.AGENAI_SANDBOX_TEST_DATASETS === '1' ? selectedDataset(suite.fixture) : undefined;
  const backend = selected ? datasetBackend(suite, selected.datasets) : suite.backend;
  const imageInspection = await engineGet(endpoint, `/images/${encodeURIComponent(suite.imageDigest)}/json`);
  assert.equal(imageInspection.status, 200);
  const image = data(imageInspection.body);
  assert.equal(image.Id, suite.imageDigest);
  const configuredLabels = data(image.Config).Labels;
  const inheritedLabels: Record<string, string> = {};
  if (configuredLabels !== null && configuredLabels !== undefined) {
    for (const [key, value] of Object.entries(data(configuredLabels))) {
      assert(typeof value === 'string');
      inheritedLabels[key] = value;
    }
  }
  Object.freeze(inheritedLabels);
  await atomicJson(path.join(directory, 'selected-image-metadata.json'), { imageDigest: suite.imageDigest, labels: inheritedLabels });
  const marker = `${suite.namespace}-workload`;
  const paths = { recordPath: path.join(directory, 'controller-recovery.json'), plannedPath: path.join(directory, 'controller-planned.json'),
    returnedPath: path.join(directory, 'reconciled-before-cleanup.json'), resultPath: path.join(directory, 'controller-result.json') };
  const configPath = path.join(directory, 'controller-config.json');
  await atomicJson(configPath, { format: 'agenai.ms005-controller-config.v1', endpoint, namespace: suite.namespace,
    profile: suite.profile, imageDigest: suite.imageDigest, user: suite.user, marker,
    ...(selected ? { datasets: selected.datasets, datasetFixture: selected.fixture } : {}), ...paths });
  const controllers: ReturnType<typeof controller>[] = [];
  const sentinels: Sentinel[] = [];
  const sentinelPlans: SentinelPlan[] = [];
  const observations: ResourceObservation[] = [];
  const facts: unknown[] = [];
  const cleanupFailures: unknown[] = [];
  const rows: CleanupEvidenceRow[] = [];
  let primaryFailure: unknown;
  let original: SandboxRecoveryRecord | undefined;
  let verificationOwner: SandboxReservation | undefined;
  let verificationPeer: Awaited<ReturnType<typeof startDatasetPeer>> | undefined;
  let completed = false;

  const createSentinel = async (role: 'compute' | 'storage', name: string): Promise<Sentinel> => {
    const labels = Object.freeze({ ...(role === 'compute' ? inheritedLabels : {}), 'ai.agen.ms005.sentinel': suite.namespace });
    const planned: SentinelPlan = role === 'compute' ? { role, name, imageDigest: suite.imageDigest, labels } : { role, name, labels };
    sentinelPlans.push(planned);
    await atomicJson(path.join(directory, 'sentinel-plans.json'), { namespace: suite.namespace, resources: sentinelPlans });
    const Labels = labels;
    const result = role === 'storage' ? await mutateEngine(endpoint, 'POST', '/volumes/create', { Name: name, Driver: 'local', Labels })
      : await mutateEngine(endpoint, 'POST', `/containers/create?name=${encodeURIComponent(name)}&platform=${encodeURIComponent(fixturePlatform(suite.profile))}`, {
        Image: suite.imageDigest, User: `${suite.user.uid}:${suite.user.gid}`, Entrypoint: ['/bin/sh'], Cmd: ['-c', 'exit 0'], Labels,
        HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] },
      });
    assert.equal(result.status, 201);
    const body = data(result.body);
    const id = role === 'storage' ? body.Name : body.Id;
    assert.equal(typeof id, 'string');
    assert(typeof id === 'string');
    const sentinel: Sentinel = { ...planned, id };
    sentinels.push(sentinel);
    await atomicJson(path.join(directory, 'sentinels.json'), sentinels);
    return sentinel;
  };
  const preserveSentinels = async (checkpoint: string) => {
    for (const sentinel of sentinels) {
      const route = sentinel.role === 'storage' ? `/volumes/${encodeURIComponent(sentinel.id)}` : `/containers/${sentinel.id}/json`;
      const result = await engineGet(endpoint, route);
      observations.push({ role: sentinel.role, id: sentinel.id, httpStatus: result.status, checkpoint, controllerPid: process.pid, observedAt: new Date().toISOString() });
      assert.equal(result.status, 200, 'Unrelated task-owned sentinel must survive recovery.');
      const body = data(result.body);
      assert.equal(body.Name, sentinel.role === 'storage' ? sentinel.name : `/${sentinel.name}`);
      assert.deepEqual(sentinel.role === 'storage' ? body.Labels : data(body.Config).Labels, sentinel.labels);
      if (sentinel.role === 'compute') {
        assert.equal(body.Id, sentinel.id);
        assert.equal(body.Image, sentinel.imageDigest);
        assert.deepEqual({ running: data(body.State).Running, status: data(body.State).Status }, { running: false, status: 'created' });
      }
    }
  };
  const liveWorkload = async (record: SandboxRecoveryRecord, checkpoint: string) => {
    const id = resourceId(record, 'compute');
    const inspection = await engineGet(endpoint, `/containers/${id}/json`);
    observations.push({ role: 'compute', id, httpStatus: inspection.status, checkpoint, controllerPid: process.pid, observedAt: new Date().toISOString() });
    assert.equal(inspection.status, 200);
    const inspected = data(inspection.body);
    assert.equal(inspected.Id, id);
    assert.equal(data(inspected.State).Running, true);
    assert(Array.isArray(inspected.ExecIDs) && inspected.ExecIDs.length === 1 && typeof inspected.ExecIDs[0] === 'string');
    const top = await engineGet(endpoint, `/containers/${id}/top`);
    assert.equal(top.status, 200);
    const table = data(top.body);
    assert(Array.isArray(table.Processes));
    const workload = table.Processes.filter((row: unknown) => Array.isArray(row) && row.some((field: unknown) => typeof field === 'string' && field.includes(marker)));
    assert.equal(workload.length, 1, 'Exactly one original marked native command must remain alive.');
    facts.push({ checkpoint, compute: id, execIds: inspected.ExecIDs, workload: workload[0] });
    return inspected.ExecIDs;
  };
  const checkDestroyed = async (record: SandboxRecoveryRecord, label: string) => {
    const events: CleanupEvidenceEvent[] = [{ sequence: 1, kind: 'sdk-close', result: 'fulfilled' }];
    const expected = record.resources.map((resource) => ({ role: resource.role, id: resourceId(record, resource.role) }));
    for (const resource of record.resources) {
      const observation = await observeResource(endpoint, resource, label);
      observations.push(observation);
      events.push({ sequence: events.length + 1, kind: 'observation', source: 'independent-engine',
        role: observation.role, id: observation.id, httpStatus: observation.httpStatus });
    }
    const row = { label, expected, events };
    const verdict = checkCleanupEvidence({ format: 'agenai.sandbox-cleanup-evidence.v1', rows: [row] });
    facts.push({ checkpoint: label, checker: verdict });
    assert.deepEqual(verdict, { kind: 'accepted', rows: 1 });
    rows.push(row);
  };

  try {
    const first = controller('start', configPath);
    controllers.push(first);
    const started = await message(first.child, 'started');
    original = parseSandboxRecoveryRecord(started.record);
    assert.deepEqual(parseSandboxRecoveryRecord(await readJson(paths.recordPath)), original);
    assert.equal(started.pid, first.child.pid);
    assert.notEqual(started.pid, process.pid);
    if (selected) {
      assert.deepEqual(started.dataset, { byteLength: selected.fixture.byteLength, sha256: selected.fixture.sha256 });
      assert.equal((await suite.backend.reconcile(original)).kind, 'conflict', 'A backend without the borrowed attachment cannot adopt its recovery record.');
    }
    const execIds = await liveWorkload(original, 'before-controller-death');
    assert.equal(first.child.kill('SIGKILL'), true);
    assert.deepEqual(await first.closed, { code: null, signal: 'SIGKILL' });
    await first.output;
    assert.deepEqual(await liveWorkload(original, 'after-controller-close-before-recovery'), execIds);
    const planned = parseSandboxRecoveryRecord(await readJson(paths.plannedPath));
    const sentinelCompute = await createSentinel('compute', `${original.resources.find((resource) => resource.role === 'compute')?.name}-similar`);
    await createSentinel('storage', `${original.resources.find((resource) => resource.role === 'storage')?.name}-similar`);
    await preserveSentinels('before-reconciliation-matrix');

    const absent = backend.reserve(sandboxRequest(), { kind: 'in_process' }).recoveryRecord;
    assert.equal((await backend.reconcile(absent)).kind, 'absent');
    await assert.rejects(Reflect.apply(backend.reconcile, backend, [null]), SandboxValidationError);
    facts.push({ checkpoint: 'absent-record', result: 'absent', record: absent, missingRecord: 'rejected' });
    const compute = original.resources.find((resource) => resource.role === 'compute');
    assert(compute?.identity.kind === 'identified');
    const variants = [
      { label: 'stale-planned', record: planned },
      { label: 'mismatched-label-binding', record: parseSandboxRecoveryRecord({ ...original, policyDigest: `sha256:${'f'.repeat(64)}` }) },
      { label: 'mismatched-id', record: parseSandboxRecoveryRecord({ ...original, resources: original.resources.map((resource) => resource.role === 'compute'
        ? { ...resource, identity: { ...compute.identity, id: sentinelCompute.id } } : resource) }) },
      { label: 'mismatched-name', record: parseSandboxRecoveryRecord({ ...original, resources: original.resources.map((resource) => resource.role === 'compute'
        ? { ...resource, name: sentinelCompute.name } : resource) }) },
    ];
    for (const variant of variants) {
      const result = await backend.reconcile(variant.record);
      assert.equal(result.kind, 'conflict', variant.label);
      facts.push({ checkpoint: variant.label, result, record: variant.record });
      await preserveSentinels(variant.label);
    }

    const fresh = controller('recover', configPath);
    controllers.push(fresh);
    const reconciled = await message(fresh.child, 'reconciled');
    assert.notEqual(reconciled.pid, started.pid);
    assert.notEqual(reconciled.pid, process.pid);
    assert.equal(reconciled.cleanupOnly, true);
    const returned = parseSandboxRecoveryRecord(reconciled.record);
    assert.deepEqual(returned, original);
    assert.deepEqual(parseSandboxRecoveryRecord(await readJson(paths.returnedPath)), returned);
    assert.deepEqual(parseSandboxRecoveryRecord(await readJson(paths.recordPath)), returned);
    assert.deepEqual(await liveWorkload(returned, 'fresh-reconciled-before-cleanup'), execIds);
    await preserveSentinels('fresh-reconciled-before-cleanup');
    const destruction = message(fresh.child, 'destroyed');
    fresh.child.send({ command: 'destroy' });
    const destroyed = await destruction;
    assert.deepEqual(await fresh.closed, { code: 0, signal: null });
    await fresh.output;
    const final = parseSandboxRecoveryRecord(destroyed.record);
    assert.equal(final.phase, 'destroyed');
    assert.deepEqual(final.resources, original.resources, 'Recovery must not allocate fresh resource identities.');
    await checkDestroyed(final, 'fresh-controller-sdk-destroy');
    const result = data(await readJson(paths.resultPath));
    assert.deepEqual({ executionResumed: result.executionResumed, commandsDispatched: result.commandsDispatched }, { executionResumed: false, commandsDispatched: 0 });
    await preserveSentinels('after-fresh-controller-sdk-destroy');
    assert.equal((await backend.reconcile(original)).kind, 'absent');

    if (selected) {
      const preservedImage = await engineGet(endpoint, `/images/${encodeURIComponent(suite.imageDigest)}/json`);
      assert.equal(preservedImage.status, 200); assert.equal(data(preservedImage.body).Id, suite.imageDigest);
      verificationOwner = reservePersisted(backend, sandboxRequest(), directory, 'dataset-after-recovery');
      const verification = await verificationOwner.start();
      const peer = verificationPeer = await startDatasetPeer(verification, selected.fixture, 'recovered');
      checkDatasetSnapshot(await peer.ready, selected.fixture, 'recovered', 'before-sibling-cleanup');
      const [snapshots, stderr, exit] = await peer.done;
      assert.equal(snapshots.length, 1); assert.equal(stderr.length, 0); assert.deepEqual(exit, { kind: 'exited', code: 0 });
      await verificationOwner.destroy();
      await checkDestroyed(verificationOwner.recoveryRecord, 'dataset-reader-after-fresh-recovery-destroy');
      facts.push({ checkpoint: 'borrowed-dataset-survives-fresh-controller-cleanup', dataset: selected,
        observed: snapshots[0], verificationRecord: verificationOwner.recoveryRecord, physicalSharing: 'not_measured' });
    }

    // A new, unrelated container now occupies the exact retired name. The old ID cannot adopt it.
    await createSentinel('compute', compute.name);
    assert.equal((await backend.reconcile(original)).kind, 'absent');
    const creating = parseSandboxRecoveryRecord({ ...original, resources: original.resources.map((resource) => resource.role === 'compute'
      ? { ...resource, identity: { kind: 'creating' } } : resource) });
    assert.equal((await backend.reconcile(creating)).kind, 'conflict');
    await preserveSentinels('reused-exact-name-preserved');
    facts.push({ checkpoint: 'reused-exact-name', identifiedRecordResult: 'absent', creatingRecordResult: 'conflict',
      originalControllerPid: started.pid, freshControllerPid: reconciled.pid, originalExecIds: execIds });
    completed = true;
  } catch (error) { primaryFailure = error; }
  finally {
    if (verificationOwner) {
      try { await verificationOwner.destroy(); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (verificationPeer) {
      try { await verificationPeer.done; }
      catch (error) { cleanupFailures.push(error); }
    }
    for (const owned of controllers) {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill('SIGKILL');
      try { await owned.closed; await owned.output; }
      catch (error) { cleanupFailures.push(error); }
    }
    if (!completed) {
      try {
        const latest = parseSandboxRecoveryRecord(await readJson(paths.recordPath));
        const result = await backend.reconcile(latest);
        facts.push({ checkpoint: 'later-emergency-recovery', result: result.kind });
        if (result.kind === 'matched' || result.kind === 'uncertain') {
          await atomicJson(path.join(directory, 'emergency-before-cleanup.json'), result.owner.recoveryRecord);
          await result.owner.destroy();
          await checkDestroyed(result.owner.recoveryRecord, 'later-emergency-sdk-destroy');
        } else assert.equal(result.kind, 'absent');
      } catch (error) { cleanupFailures.push(error); }
    }
    // Exact fixture cleanup starts only after the unrelated-resource preservation checkpoints.
    for (const planned of sentinelPlans) {
      try {
        const recorded = sentinels.find((sentinel) => sentinel.role === planned.role && sentinel.name === planned.name);
        const reference = recorded?.id ?? planned.name;
        const route = planned.role === 'storage' ? `/volumes/${encodeURIComponent(reference)}` : `/containers/${encodeURIComponent(reference)}/json`;
        const inspected = await engineGet(endpoint, route);
        if (inspected.status === 404) continue;
        assert.equal(inspected.status, 200);
        const body = data(inspected.body);
        assert.equal(body.Name, planned.role === 'storage' ? planned.name : `/${planned.name}`);
        const labels = planned.role === 'storage' ? body.Labels : data(body.Config).Labels;
        assert.deepEqual(labels, planned.labels);
        const id = planned.role === 'storage' ? body.Name : body.Id;
        assert(typeof id === 'string');
        if (recorded) assert.equal(id, recorded.id);
        if (planned.role === 'compute') assert.equal(body.Image, planned.imageDigest);
        const removal = await mutateEngine(endpoint, 'DELETE', planned.role === 'storage' ? `/volumes/${encodeURIComponent(id)}` : `/containers/${id}?force=true&v=false`);
        assert.equal(removal.status, 204);
        const absence = await engineGet(endpoint, planned.role === 'storage' ? `/volumes/${encodeURIComponent(id)}` : `/containers/${id}/json`);
        observations.push({ role: planned.role, id, httpStatus: absence.status, checkpoint: 'exact-sentinel-fixture-cleanup', controllerPid: process.pid, observedAt: new Date().toISOString() });
        assert.equal(absence.status, 404);
      } catch (error) { cleanupFailures.push(error); }
    }
    await atomicJson(path.join(directory, 'report.json'), { format: 'agenai.sandbox-docker-recovery-evidence.v1',
      namespace: suite.namespace, endpoint, imageDigest: suite.imageDigest, node: process.version, original, dataset: selected,
      observations, facts, sentinels, cleanupEvidence: { format: 'agenai.sandbox-cleanup-evidence.v1', rows },
      primaryFailure: failureSummary(primaryFailure), cleanupFailures: cleanupFailures.map((error) => failureSummary(error)), modelCalls: 0, credentialReads: 0 });
  }
  if (primaryFailure || cleanupFailures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures], 'Fresh-controller qualification failed; original verdict and later exact cleanup retained.');
});

test('fresh controller advances the durable creating identity after death before the real create reply', { timeout: 300_000 }, async () => {
  const suite = await openSuite('creating-owner');
  const proxy = await createFaultProxy({ upstreamEndpoint: suite.endpoint, directory: suite.directory });
  const backend = createDockerSandboxBackend({ endpoint: proxy.endpoint, namespace: suite.namespace, profile: suite.profile,
    imageDigest: suite.imageDigest, user: suite.user, spillDirectory: suite.directory });
  const paths = { recordPath: path.join(suite.directory, 'controller-recovery.json'), plannedPath: path.join(suite.directory, 'controller-planned.json'),
    returnedPath: path.join(suite.directory, 'reconciled-before-cleanup.json'), resultPath: path.join(suite.directory, 'controller-result.json') };
  const config = { format: 'agenai.ms005-controller-config.v1', endpoint: proxy.endpoint, namespace: suite.namespace,
    profile: suite.profile, imageDigest: suite.imageDigest, user: suite.user, marker: `${suite.namespace}-not-dispatched`, ...paths };
  const configPath = path.join(suite.directory, 'controller-config.json');
  await atomicJson(configPath, config);
  const controllers: ReturnType<typeof controller>[] = [];
  const observations: ResourceObservation[] = [];
  const facts: unknown[] = [];
  const cleanupFailures: unknown[] = [];
  const rows: CleanupEvidenceRow[] = [];
  let gate: FaultGate | undefined;
  let entered = false;
  let original: SandboxRecoveryRecord | undefined;
  let finalRecord: SandboxRecoveryRecord | undefined;
  let nativeId: string | undefined;
  let primaryFailure: unknown;
  let completed = false;

  const inspectAcquired = async (record: SandboxRecoveryRecord, checkpoint: string) => {
    const expected = record.resources.flatMap((resource) => resource.identity.kind === 'identified'
      ? [{ role: resource.role, id: resource.identity.id }] : []);
    assert(expected.some((resource) => resource.role === 'compute' && resource.id === nativeId));
    const events: CleanupEvidenceEvent[] = [{ sequence: 1, kind: 'sdk-close', result: 'fulfilled' }];
    for (const resource of record.resources) {
      const observation = await observeResource(suite.endpoint, resource, checkpoint);
      observations.push(observation);
      assert.equal(observation.httpStatus, 404);
      if (resource.identity.kind === 'identified') events.push({ sequence: events.length + 1, kind: 'observation', source: 'independent-engine',
        role: observation.role, id: observation.id, httpStatus: observation.httpStatus });
      else facts.push({ checkpoint: `${checkpoint}-planned-name-absent`, role: resource.role, name: resource.name, httpStatus: observation.httpStatus });
    }
    const row = { label: checkpoint, expected, events };
    assert.deepEqual(checkCleanupEvidence({ format: 'agenai.sandbox-cleanup-evidence.v1', rows: [row] }), { kind: 'accepted', rows: 1 });
    rows.push(row);
  };
  const inspectUnstarted = async (id: string, checkpoint: string) => {
    const observed = await engineGet(suite.endpoint, `/containers/${id}/json`);
    observations.push({ role: 'compute', id, httpStatus: observed.status, checkpoint, controllerPid: process.pid, observedAt: new Date().toISOString() });
    assert.equal(observed.status, 200);
    const body = data(observed.body);
    assert.equal(body.Id, id);
    assert.equal(body.Image, suite.imageDigest);
    assert.deepEqual({ running: data(body.State).Running, status: data(body.State).Status }, { running: false, status: 'created' });
    assert.deepEqual(body.ExecIDs ?? [], [], 'No command may be dispatched by partial-start or cleanup-only recovery.');
    facts.push({ checkpoint, id, name: body.Name, imageDigest: body.Image, state: body.State, execIds: body.ExecIDs ?? [] });
  };

  try {
    const first = controller('create', configPath);
    controllers.push(first);
    const reserved = await message(first.child, 'reserved');
    const planned = parseSandboxRecoveryRecord(reserved.record);
    assert.deepEqual(parseSandboxRecoveryRecord(await readJson(paths.plannedPath)), planned);
    const plannedCompute = planned.resources.find((resource) => resource.role === 'compute');
    assert(plannedCompute?.identity.kind === 'planned');
    gate = proxy.arm({ method: 'POST', path: `/v1.52/containers/create?name=${encodeURIComponent(plannedCompute.name)}&platform=${encodeURIComponent(fixturePlatform(suite.profile))}`,
      mode: 'hold_reply', timeoutMs: 45_000 });
    first.child.send({ command: 'start' });
    await gate.entered;
    entered = true;
    const response = await gate.responded;
    assert.equal(response.status, 201);
    const returnedNativeId = /"Id"\s*:\s*"([a-f0-9]{64})"/u.exec(response.responsePrefix);
    assert(returnedNativeId, 'Held real create response must expose its exact independently inspectable native ID.');
    nativeId = returnedNativeId[1];
    assert(typeof nativeId === 'string');
    await inspectUnstarted(nativeId, 'native-create-effect-before-controller-death');
    original = parseSandboxRecoveryRecord(await readJson(paths.recordPath));
    assert.equal(original.operationId, planned.operationId);
    assert.deepEqual(original.resources.map((resource) => [resource.role, resource.identity.kind]),
      [['compute', 'creating'], ['storage', 'identified'], ['export', 'planned']]);
    await atomicJson(path.join(suite.directory, 'failed-controller-record.json'), original);
    assert.equal(first.child.kill('SIGKILL'), true);
    assert.deepEqual(await first.closed, { code: null, signal: 'SIGKILL' });
    await first.output;
    assert.deepEqual(parseSandboxRecoveryRecord(await readJson(paths.recordPath)), original);
    gate.release();
    await gate.settled;
    await inspectUnstarted(nativeId, 'after-controller-close-and-held-reply-join');
    assert.equal((await suite.backend.reconcile(original)).kind, 'conflict', 'Changing even the forwarding endpoint must not adopt the original record.');
    facts.push({ checkpoint: 'different-endpoint-rejected', originalEndpoint: proxy.endpoint, otherEndpoint: suite.endpoint, result: 'conflict' });
    const fresh = controller('recover', configPath);
    controllers.push(fresh);
    const reconciled = await message(fresh.child, 'reconciled');
    assert.notEqual(reconciled.pid, reserved.pid);
    assert.equal(reconciled.cleanupOnly, true);
    const returned = parseSandboxRecoveryRecord(reconciled.record);
    assert.equal(returned.operationId, original.operationId);
    assert.deepEqual(returned.resources.map((resource) => [resource.role, resource.name]), original.resources.map((resource) => [resource.role, resource.name]));
    assert.equal(resourceId(returned, 'compute'), nativeId);
    assert.deepEqual(returned.resources.find((resource) => resource.role === 'storage'), original.resources.find((resource) => resource.role === 'storage'));
    assert.deepEqual(returned.resources.find((resource) => resource.role === 'export'), original.resources.find((resource) => resource.role === 'export'));
    assert.deepEqual(parseSandboxRecoveryRecord(await readJson(paths.returnedPath)), returned);
    assert.deepEqual(parseSandboxRecoveryRecord(await readJson(paths.recordPath)), returned);
    await inspectUnstarted(nativeId, 'advanced-record-durable-before-cleanup');
    facts.push({ checkpoint: 'creating-identity-advanced-before-cleanup', originalControllerPid: reserved.pid, freshControllerPid: reconciled.pid,
      nativeId, returnedRecord: returned, commandDispatches: 0 });
    const destruction = message(fresh.child, 'destroyed');
    fresh.child.send({ command: 'destroy' });
    const destroyed = await destruction;
    assert.deepEqual(await fresh.closed, { code: 0, signal: null });
    await fresh.output;
    finalRecord = parseSandboxRecoveryRecord(destroyed.record);
    assert.equal(finalRecord.phase, 'destroyed');
    assert.deepEqual(finalRecord.resources, returned.resources);
    await inspectAcquired(finalRecord, 'fresh-creating-owner-sdk-destroy');
    const result = data(await readJson(paths.resultPath));
    assert.deepEqual({ executionResumed: result.executionResumed, commandsDispatched: result.commandsDispatched }, { executionResumed: false, commandsDispatched: 0 });
    assert.equal(proxy.observations.filter((entry) => entry.method === 'POST' && entry.path === response.path).length, 1);
    assert.equal(proxy.observations.filter((entry) => entry.method === 'POST' && /\/(?:exec|start)(?:\?|$)/u.test(entry.path)).length, 0);
    completed = true;
  } catch (error) { primaryFailure = error; }
  finally {
    for (const owned of controllers) {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill('SIGKILL');
      try { await owned.closed; await owned.output; }
      catch (error) { cleanupFailures.push(error); }
    }
    gate?.release();
    if (gate && entered) {
      try { await gate.settled; }
      catch (error) { cleanupFailures.push(error); }
    }
    if (!completed) {
      try {
        const latest = parseSandboxRecoveryRecord(await readJson(paths.recordPath));
        const recovered = await backend.reconcile(latest);
        facts.push({ checkpoint: 'later-emergency-recovery', result: recovered.kind });
        if (recovered.kind === 'matched' || recovered.kind === 'uncertain') {
          await atomicJson(path.join(suite.directory, 'emergency-before-cleanup.json'), recovered.owner.recoveryRecord);
          await recovered.owner.destroy();
          finalRecord = recovered.owner.recoveryRecord;
          await inspectAcquired(finalRecord, 'later-emergency-creating-owner-sdk-destroy');
        } else assert.equal(recovered.kind, 'absent');
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await proxy.close(); }
    catch (error) { cleanupFailures.push(error); }
    await atomicJson(path.join(suite.directory, 'report.json'), { format: 'agenai.sandbox-docker-creating-owner-evidence.v1',
      namespace: suite.namespace, endpoint: suite.endpoint, imageDigest: suite.imageDigest, node: process.version,
      original, finalRecord, nativeId, observations, facts, proxyObservations: proxy.observations,
      cleanupEvidence: { format: 'agenai.sandbox-cleanup-evidence.v1', rows },
      primaryFailure: failureSummary(primaryFailure), cleanupFailures: cleanupFailures.map((error) => failureSummary(error)), modelCalls: 0, credentialReads: 0 });
  }
  if (primaryFailure || cleanupFailures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures], 'Creating-identity controller recovery failed; original record and later cleanup retained.');
});

test('independent real observer rejects a false successful close before the original SDK owner removes the workload', { timeout: 300_000 }, async () => {
  const suite = await openSuite('false-close');
  const owner = reservePersisted(suite.backend, sandboxRequest(), suite.directory, 'false-close');
  const observations: ResourceObservation[] = [];
  const facts: unknown[] = [];
  const cleanupFailures: unknown[] = [];
  let primaryFailure: unknown;
  let record = owner.recoveryRecord;
  let originalOwner: SandboxCleanupOwner = owner;
  try {
    const sandbox = await owner.start();
    originalOwner = sandbox;
    const processReservation = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: ['-e', 'process.stdout.write("READY\\n");setInterval(()=>{},1000)'], env: {}, cwd: sandbox.workspace });
    const streams = await processReservation.start();
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('False-close native workload readiness timed out.')), 15_000);
      streams.stdout.once('data', (bytes: Buffer) => { clearTimeout(timer); resolve(bytes.toString('utf8')); });
      streams.stdout.once('error', reject);
    });
    assert.equal(ready, 'READY\n');
    record = owner.recoveryRecord;
    const compute = record.resources.find((resource) => resource.role === 'compute');
    assert(compute);
    const before = await observeResource(suite.endpoint, compute, 'before-false-close');
    observations.push(before);
    assert.equal(before.httpStatus, 200);
    const brokenOwner = { close: async () => Promise.resolve() };
    await brokenOwner.close();
    const after = await observeResource(suite.endpoint, compute, 'after-false-close-before-original-sdk-cleanup');
    observations.push(after);
    assert.equal(after.httpStatus, 200);
    const evidence: CleanupEvidenceReport = { format: 'agenai.sandbox-cleanup-evidence.v1', rows: [{ label: 'false-success',
      expected: [{ role: 'compute', id: resourceId(record, 'compute') }], events: [
        { sequence: 1, kind: 'sdk-close', result: 'fulfilled' },
        { sequence: 2, kind: 'observation', source: 'independent-engine', role: after.role, id: after.id, httpStatus: after.httpStatus },
      ] }] };
    const rejected = checkCleanupEvidence(evidence);
    assert.equal(rejected.kind, 'rejected');
    if (rejected.kind !== 'rejected') throw new Error('Broken owner was incorrectly accepted.');
    assert.match(rejected.reason, /absence/u);
    facts.push({ checkpoint: 'false-close-rejected-before-original-sdk-cleanup', evidence, verdict: rejected });
    await atomicJson(path.join(suite.directory, 'negative-control-before-cleanup.json'), { evidence, verdict: rejected, observation: after });
    await sandbox.stop();
    const stopped = await observeResource(suite.endpoint, compute, 'original-sdk-stop-after-negative-control');
    observations.push(stopped);
    assert.equal(stopped.httpStatus, 404);
    assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
  } catch (error) { primaryFailure = error; }
  finally {
    try { await originalOwner.destroy(); }
    catch (error) { cleanupFailures.push(error); }
    for (const resource of owner.recoveryRecord.resources) {
      try {
        const observation = await observeResource(suite.endpoint, resource, 'original-sdk-destroy');
        observations.push(observation);
        assert.equal(observation.httpStatus, 404);
      } catch (error) { cleanupFailures.push(error); }
    }
    await atomicJson(path.join(suite.directory, 'report.json'), { format: 'agenai.sandbox-docker-false-close-evidence.v1',
      namespace: suite.namespace, endpoint: suite.endpoint, imageDigest: suite.imageDigest, node: process.version,
      record: owner.recoveryRecord, observations, facts, primaryFailure: failureSummary(primaryFailure),
      cleanupFailures: cleanupFailures.map((error) => failureSummary(error)), modelCalls: 0, credentialReads: 0 });
  }
  if (primaryFailure || cleanupFailures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures], 'False-close negative control failed; original and cleanup evidence retained.');
});
