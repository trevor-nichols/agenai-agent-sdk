// ------------------------------------------------------------------------------------------------
//                datasets.test.ts - Real immutable image attachments and independent quota admission
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { SandboxOperationError, SandboxStartError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { SandboxReservation } from '@agen-ai/sandbox';
import { exportFixtures } from '../fixtures/trees.js';
import { atomicJson, engineGet, failureSummary, fixturePlatform, inspectAbsent, openSuite, reservePersisted, resourceId, sandboxRequest } from './support/common.js';
import type { ResourceObservation } from './support/common.js';
import { checkDatasetSnapshot, datasetBackend, selectedDataset, startDatasetPeer } from './support/dataset.js';
import { createFaultProxy } from './support/fault-proxy.js';
import type { FaultGate } from './support/fault-proxy.js';

function data(value: unknown): Record<string, unknown> {
  const isData = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
  assert(isData(value));
  return value;
}

test('two real sandboxes borrow one immutable image dataset and retain private workspaces through sibling cleanup', { timeout: 300_000 }, async () => {
  const suite = await openSuite('datasets');
  const selected = selectedDataset(suite.fixture);
  const backend = datasetBackend(suite, selected.datasets);
  const owners: SandboxReservation[] = [];
  const peers: Awaited<ReturnType<typeof startDatasetPeer>>[] = [];
  const observations: ResourceObservation[] = [];
  const facts: unknown[] = [];
  const cleanupFailures: unknown[] = [];
  let primaryFailure: Readonly<{ error: unknown }> | undefined;
  try {
    for (const label of ['left', 'right']) owners.push(reservePersisted(backend, sandboxRequest(), suite.directory, label));
    const left = await owners[0]!.start();
    const right = await owners[1]!.start();
    assert.deepEqual(left.effective.workspaceDiskQuota, { kind: 'not_requested' });
    assert.deepEqual(right.effective.workspaceDiskQuota, { kind: 'not_requested' });
    assert.notEqual(resourceId(left.recoveryRecord, 'storage'), resourceId(right.recoveryRecord, 'storage'));
    for (const sandbox of [left, right]) {
      const id = resourceId(sandbox.recoveryRecord, 'compute');
      const inspection = await engineGet(suite.endpoint, `/containers/${id}/json`);
      assert.equal(inspection.status, 200);
      const hostConfig = data(data(inspection.body).HostConfig);
      assert(Array.isArray(hostConfig.Mounts));
      const mounts = hostConfig.Mounts.map(data).filter((mount) => mount.Type === 'image').map((mount) => ({
        Type: mount.Type, Source: mount.Source, Target: mount.Target, ReadOnly: mount.ReadOnly, ImageOptions: mount.ImageOptions,
      }));
      assert.deepEqual(mounts, [{ Type: 'image', Source: suite.imageDigest, Target: '/datasets/reference', ReadOnly: true,
        ImageOptions: { Subpath: selected.fixture.subpath } }]);
      facts.push({ checkpoint: 'independent-image-mount-identity', computeId: id, mounts, physicalSharing: 'not_measured' });
    }
    peers.push(await startDatasetPeer(left, selected.fixture, 'left'));
    peers.push(await startDatasetPeer(right, selected.fixture, 'right', true));
    checkDatasetSnapshot(await peers[0]!.ready, selected.fixture, 'left', 'before-sibling-cleanup');
    checkDatasetSnapshot(await peers[1]!.ready, selected.fixture, 'right', 'before-sibling-cleanup');
    const [leftSnapshots, leftStderr, leftExit] = await peers[0]!.done;
    assert.equal(leftSnapshots.length, 1); assert.equal(leftStderr.length, 0); assert.deepEqual(leftExit, { kind: 'exited', code: 0 });
    await left.stop();
    await inspectAbsent(suite.endpoint, left.recoveryRecord, 'left-stop-before-private-export', observations, ['compute']);
    const privateFiles = await exportFixtures(left, ['private.txt']);
    assert.equal(privateFiles.length, 1); assert.equal(Buffer.from(privateFiles[0]!.bytes).toString('utf8'), 'left');
    await owners[0]!.destroy();
    await inspectAbsent(suite.endpoint, owners[0]!.recoveryRecord, 'left-destroy-while-right-alive', observations);
    const retainedImage = await engineGet(suite.endpoint, `/images/${encodeURIComponent(suite.imageDigest)}/json`);
    assert.equal(retainedImage.status, 200); assert.equal(data(retainedImage.body).Id, suite.imageDigest);
    await peers[1]!.release();
    const [rightSnapshots, rightStderr, rightExit] = await peers[1]!.done;
    assert.equal(rightSnapshots.length, 2); assert.equal(rightStderr.length, 0); assert.deepEqual(rightExit, { kind: 'exited', code: 0 });
    checkDatasetSnapshot(rightSnapshots[1], selected.fixture, 'right', 'after-sibling-cleanup');
    await right.stop();
    const rightFiles = await exportFixtures(right, ['private.txt']);
    assert.equal(Buffer.from(rightFiles[0]!.bytes).toString('utf8'), 'right');
    facts.push({ checkpoint: 'borrowed-data-survives-sibling-stop-destroy', dataset: selected, left: leftSnapshots, right: rightSnapshots,
      privateStorageDistinct: true, privateExports: { left: 'left', right: 'right' }, noRequestedQuotaAccepted: true });
  } catch (error) { primaryFailure = { error }; }
  finally {
    for (const owner of owners) {
      try { await owner.destroy(); await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'finally-destroy', observations); }
      catch (error) { cleanupFailures.push(error); }
    }
    for (const peer of peers) {
      try { await peer.done; } catch (error) { cleanupFailures.push(error); }
    }
    try {
      const image = await engineGet(suite.endpoint, `/images/${encodeURIComponent(suite.imageDigest)}/json`);
      assert.equal(image.status, 200); assert.equal(data(image.body).Id, suite.imageDigest);
      facts.push({ checkpoint: 'borrowed-image-preserved-after-all-sdk-destroy', imageDigest: suite.imageDigest, httpStatus: image.status });
    } catch (error) { cleanupFailures.push(error); }
    try { await atomicJson(path.join(suite.directory, 'report.json'), { format: 'agenai.sandbox-docker-dataset-evidence.v1',
      namespace: suite.namespace, endpoint: suite.endpoint, dataset: selected, records: owners.map((owner) => owner.recoveryRecord),
      facts, observations, primaryFailure: primaryFailure ? failureSummary(primaryFailure.error) : null,
      cleanupFailures: cleanupFailures.map((error) => failureSummary(error)), modelCalls: 0, credentialReads: 0 }); }
    catch (error) { cleanupFailures.push(error); }
  }
  if (primaryFailure || cleanupFailures.length) throw new AggregateError([
    ...(primaryFailure ? [primaryFailure.error] : []), ...cleanupFailures,
  ], 'Dataset qualification failed; original and exact cleanup evidence remain separate.');
});

test('a dataset subpath symlink outside the image is rejected by the real Engine before usable execution', { timeout: 180_000 }, async () => {
  const suite = await openSuite('dataset-escape');
  const selected = selectedDataset(suite.fixture);
  const proxy = await createFaultProxy({ upstreamEndpoint: suite.endpoint, directory: suite.directory });
  let owner: SandboxReservation | undefined;
  let createRoute: string | undefined;
  let startRoute: string | undefined;
  let archiveRoute: string | undefined;
  let startup: Promise<Readonly<{ kind: 'ready' }> | Readonly<{ kind: 'rejected'; error: unknown }>> | undefined;
  const gates: FaultGate[] = [];
  const engineRejections = () => proxy.observations.filter((entry) => entry.status >= 400
    && (entry.method === 'POST' && (entry.path === createRoute || entry.path === startRoute)
      || entry.method === 'PUT' && entry.path === archiveRoute));
  const observations: ResourceObservation[] = [];
  const cleanupFailures: unknown[] = [];
  const facts: unknown[] = [];
  const holdReply = (method: 'POST' | 'PUT', route: string) => {
    const gate = proxy.arm({ method, path: route, mode: 'hold_reply' }); gates.push(gate); return gate;
  };
  const phaseResponse = async (gate: FaultGate, phase: string) => {
    assert(startup);
    const observed = await Promise.race([gate.responded.then((response) => ({ kind: 'response', response } as const)),
      startup.then((outcome) => ({ kind: 'startup', outcome } as const))]);
    assert(observed.kind === 'response', `Startup settled before the complete owned ${phase} response.`);
    facts.push({ checkpoint: 'complete-startup-phase-response-before-release', phase, response: observed.response });
    return observed.response;
  };
  let primaryFailure: Readonly<{ error: unknown }> | undefined;
  try {
    const backend = datasetBackend({ ...suite, endpoint: proxy.endpoint }, [{ name: 'escape', imageDigest: suite.imageDigest,
      subpath: `${selected.fixture.subpath}/escape` }]);
    owner = reservePersisted(backend, sandboxRequest(), suite.directory, 'escape');
    const plannedCompute = owner.recoveryRecord.resources.find((resource) => resource.role === 'compute'); assert(plannedCompute);
    createRoute = `/v1.52/containers/create?name=${encodeURIComponent(plannedCompute.name)}&platform=${encodeURIComponent(fixturePlatform(suite.profile))}`;
    const createGate = holdReply('POST', createRoute);
    startup = owner.start().then(() => {
      facts.push({ checkpoint: 'original-startup-outcome-before-validation', outcome: 'usable-sandbox-returned', engineRejections: engineRejections() });
      return { kind: 'ready' } as const;
    }, (error: unknown) => {
      facts.push({ checkpoint: 'original-startup-outcome-before-validation', outcome: 'rejected', rejection: failureSummary(error), engineRejections: engineRejections() });
      return { kind: 'rejected', error } as const;
    });
    void startup.catch(() => {});
    const created = await phaseResponse(createGate, 'compute create');
    assert([201, 400, 500].includes(created.status));
    if (created.status === 201) {
      assert(Buffer.byteLength(created.responsePrefix) < 1024);
      const body = data(JSON.parse(created.responsePrefix));
      assert(typeof body.Id === 'string' && /^[a-f0-9]{64}$/u.test(body.Id));
      startRoute = `/v1.52/containers/${body.Id}/start`;
      archiveRoute = `/v1.52/containers/${body.Id}/archive?path=%2Fworkspace&noOverwriteDirNonDir=true`;
      const archiveGate = holdReply('PUT', archiveRoute);
      createGate.release(); await createGate.settled;
      const imported = await phaseResponse(archiveGate, 'initial workspace PUT');
      assert([200, 400, 500].includes(imported.status));
      if (imported.status === 200) {
        const startGate = holdReply('POST', startRoute);
        archiveGate.release(); await archiveGate.settled;
        await phaseResponse(startGate, 'compute start');
        startGate.release(); await startGate.settled;
      } else { archiveGate.release(); await archiveGate.settled; }
    } else { createGate.release(); await createGate.settled; }
    const startupOutcome = await startup;
    const compute = owner.recoveryRecord.resources.find((resource) => resource.role === 'compute'); assert(compute);
    const rejectedRequests = engineRejections();
    assert(startupOutcome.kind === 'rejected', 'An image subpath escaping its root unexpectedly returned a usable sandbox.');
    const expectedRejection = startupOutcome.error;
    assert(expectedRejection instanceof SandboxStartError);
    const causes: Error[] = [];
    for (let cause: unknown = expectedRejection; cause instanceof Error && causes.length < 8; cause = cause.cause) causes.push(cause);
    assert(causes.some((error) => error instanceof SandboxOperationError && error.code === 'driver_failure'
      && /Docker (?:resource operation|transfer) returned HTTP (?:400|500)\./u.test(error.message)), 'The real Engine must reject the confined image path after SDK admission.');
    assert.equal(rejectedRequests.length, 1, 'Exactly one original create, initial workspace PUT or start response must carry the confined-path rejection.');
    const rejectedRequest = rejectedRequests[0]; assert(rejectedRequest);
    assert(Buffer.byteLength(rejectedRequest.responsePrefix) < 1024, 'The diagnostic error must fit the complete bounded response capture.');
    const engineError = data(JSON.parse(rejectedRequest.responsePrefix));
    assert(typeof engineError.message === 'string');
    facts.push({ checkpoint: 'actual-engine-rejection-before-specificity-check', response: rejectedRequest, message: engineError.message });
    // Moby safepath.ErrEscapesBase; an unrelated mount or create failure proves no containment.
    assert(engineError.message.includes('path concatenation escapes the base directory'), 'The Engine must report its specific image-path confinement failure.');
    assert(engineError.message.includes(`, subpath: ${selected.fixture.subpath}/escape`), 'The confinement error must identify this exact selected subpath.');
    assert.equal(proxy.observations.filter((entry) => entry.method === 'POST' && entry.path === startRoute && [204, 304].includes(entry.status)).length, 0);
    assert.equal(proxy.observations.filter((entry) => entry.method === 'POST'
      && /^\/v1\.52\/(?:containers\/[a-f0-9]{64}\/exec|exec\/[a-f0-9]{64}\/start)(?:\?|$)/u.test(entry.path)).length, 0);
    const reference = compute.identity.kind === 'identified' ? compute.identity.id : compute.name;
    const inspected = await engineGet(suite.endpoint, `/containers/${encodeURIComponent(reference)}/json`);
    assert([200, 404].includes(inspected.status));
    if (inspected.status === 200) {
      const value = data(inspected.body);
      assert.equal(data(value.State).Running, false); assert.deepEqual(value.ExecIDs ?? [], []);
    }
    facts.push({ checkpoint: 'expected-image-path-confinement-rejection', symlinkTarget: '/etc',
      selectedSubpath: `${selected.fixture.subpath}/escape`, rejection: failureSummary(expectedRejection),
      engineMessage: engineError.message, computeReference: reference, computeHttpStatus: inspected.status,
      usableSandboxReturned: false, successfulComputeStarts: 0, guestCommandsDispatched: 0 });
  } catch (error) { primaryFailure = { error }; }
  finally {
    for (const gate of gates) gate.release();
    if (owner) {
      try { await owner.destroy(); await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'finally-destroy', observations); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await proxy.close(); } catch (error) { cleanupFailures.push(error); }
    if (startup) { try { await startup; } catch (error) { cleanupFailures.push(error); } }
    try {
      const image = await engineGet(suite.endpoint, `/images/${encodeURIComponent(suite.imageDigest)}/json`);
      assert.equal(image.status, 200); assert.equal(data(image.body).Id, suite.imageDigest);
    } catch (error) { cleanupFailures.push(error); }
    try { await atomicJson(path.join(suite.directory, 'report.json'), { format: 'agenai.sandbox-docker-dataset-escape-evidence.v1',
      namespace: suite.namespace, endpoint: suite.endpoint, record: owner?.recoveryRecord, facts, observations,
      engineRejections: engineRejections(),
      primaryFailure: primaryFailure ? failureSummary(primaryFailure.error) : null, cleanupFailures: cleanupFailures.map((error) => failureSummary(error)) }); }
    catch (error) { cleanupFailures.push(error); }
  }
  if (primaryFailure || cleanupFailures.length) throw new AggregateError([
    ...(primaryFailure ? [primaryFailure.error] : []), ...cleanupFailures,
  ], 'Image subpath confinement proof failed; original and cleanup receipts remain separate.');
});

test('unavailable allocated-block disk quota rejects before a real backend reservation can be returned', async () => {
  const suite = await openSuite('dataset-quota');
  assert.equal(suite.backend.support.workspaceDiskQuota, false);
  let persists = 0;
  const request = sandboxRequest();
  assert.deepEqual(request.policy.workspaceDiskQuota, { kind: 'not_requested' });
  assert.throws(() => suite.backend.reserve({ policy: { ...request.policy,
    workspaceDiskQuota: { kind: 'required', bytes: 64 * 1024 * 1024, accounting: 'allocated_blocks' },
  } }, { kind: 'persisted', async persist() { persists += 1; } }), SandboxUnsupportedError);
  assert.equal(persists, 0);
  await atomicJson(path.join(suite.directory, 'report.json'), { format: 'agenai.sandbox-docker-quota-admission-evidence.v1',
    profile: suite.profile, requestedBytes: 64 * 1024 * 1024, accounting: 'allocated_blocks', positiveQuotaSupport: false,
    rejection: 'SandboxUnsupportedError before reservation returned', persistenceEntered: persists, positiveEnforcement: 'deferred_not_qualified' });
});
