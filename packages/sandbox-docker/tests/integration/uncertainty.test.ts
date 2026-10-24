// ------------------------------------------------------------------------------------------------
//                uncertainty.test.ts - Real Engine lost replies and retained cleanup ownership
// ------------------------------------------------------------------------------------------------

import { importFixtures, exportFixtures } from '../fixtures/trees.js';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SandboxCleanupError, SandboxOperationError, SandboxStartError, SandboxStateError } from '@agen-ai/sandbox';
import type { Sandbox, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { atomicJson, engineGet, failureSummary, fixturePlatform, inspectAbsent, openSuite, reservePersisted, resourceId, sandboxRequest } from './support/common.js';
import type { ResourceObservation } from './support/common.js';
import { checkCleanupEvidence } from './support/evidence.js';
import type { CleanupEvidenceReport } from './support/evidence.js';
import { createFaultProxy } from './support/fault-proxy.js';
import type { FaultGate, ProxyObservation } from './support/fault-proxy.js';

interface Receipt {
  readonly operation: string;
  readonly status: 'failed' | 'succeeded';
  readonly error?: unknown;
}

interface ScenarioEvidence {
  readonly name: string;
  readonly receipts: Receipt[];
  readonly observations: ResourceObservation[];
  readonly facts: unknown[];
  readonly cleanupFailures: unknown[];
  record?: SandboxRecoveryRecord;
  proxyObservations?: readonly ProxyObservation[];
  primaryFailure?: unknown;
  cleanupEvidence?: CleanupEvidenceReport;
}

function exactResource(record: SandboxRecoveryRecord, role: 'compute' | 'export') {
  const resource = record.resources.find((entry) => entry.role === role);
  assert(resource);
  return resource;
}

function returnedId(observation: ProxyObservation): string {
  // Engine can use either fixed-length or chunked HTTP framing; the bounded prefix retains
  // the complete tiny JSON response while the proxy forwards the original bytes untouched.
  const match = /"Id"\s*:\s*"([a-f0-9]{64})"/u.exec(observation.responsePrefix);
  assert(match, 'Real Engine mutation must return one exact native ID.');
  return match[1]!;
}

async function failed<Value>(promise: Promise<Value>, operation: string, evidence: ScenarioEvidence): Promise<unknown> {
  try { await promise; }
  catch (error) {
    evidence.receipts.push({ operation, status: 'failed', error: failureSummary(error) });
    return error;
  }
  evidence.receipts.push({ operation, status: 'succeeded' });
  assert.fail(`${operation} unexpectedly succeeded after the selected real transport fault.`);
}

async function inspectContainer(endpoint: string, id: string, checkpoint: string, evidence: ScenarioEvidence): Promise<{ Id: string; State: { Running: boolean } }> {
  const result = await engineGet(endpoint, `/containers/${encodeURIComponent(id)}/json`);
  evidence.observations.push({ role: 'compute', id, httpStatus: result.status, checkpoint,
    controllerPid: process.pid, observedAt: new Date().toISOString() });
  assert.equal(result.status, 200, 'The independent observer must see the real effect before SDK cleanup.');
  const value = result.body;
  assert(value !== null && typeof value === 'object' && 'Id' in value && value.Id === id && 'State' in value);
  const state = value.State;
  assert(state !== null && typeof state === 'object' && 'Running' in state && typeof state.Running === 'boolean');
  return { Id: id, State: { Running: state.Running } };
}

async function waitForExit(endpoint: string, execId: string): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await engineGet(endpoint, `/exec/${execId}/json`);
    assert.equal(result.status, 200);
    assert(result.body !== null && typeof result.body === 'object' && 'Running' in result.body && 'ExitCode' in result.body);
    if (result.body.Running === false) {
      assert.equal(result.body.ExitCode, 23);
      return result.body;
    }
    await delay(50);
  }
  assert.fail('The independently observed marker command did not settle within five seconds.');
}

test('real Docker transport uncertainty never replays effects and retains exact cleanup ownership', { timeout: 600_000 }, async (t) => {
  const suite = await openSuite('uncertainty');
  const reports: ScenarioEvidence[] = [];
  const cases = ['lost-create', 'lost-start', 'lost-exec-create', 'lost-exec-start',
    'abort-pending-start', 'late-exec-create', 'late-exec-start', 'cleanup-observation-timeout'] as const;

  for (const name of cases) await t.test(name, { timeout: 65_000 }, async () => {
    const directory = path.join(suite.directory, name);
    await mkdir(directory, { mode: 0o700 });
    const proxy = await createFaultProxy({ upstreamEndpoint: suite.endpoint, directory });
    const backend = createDockerSandboxBackend({ endpoint: proxy.endpoint, profile: suite.profile, namespace: suite.namespace,
      imageDigest: suite.imageDigest, spillDirectory: directory, user: suite.user });
    const owner = reservePersisted(backend, sandboxRequest({ cleanupMs: name === 'cleanup-observation-timeout' ? 750 : 15_000 }), directory, 'owner');
    const evidence: ScenarioEvidence = { name, receipts: [], observations: [], facts: [], cleanupFailures: [] };
    reports.push(evidence);
    const gates: FaultGate[] = [];
    const arm = (method: string, route: string, mode: 'hold_request' | 'hold_reply' | 'drop_reply') => {
      const gate = proxy.arm({ method, path: route, mode });
      gates.push(gate);
      return gate;
    };
    let original: unknown;
    let sandbox: Sandbox | undefined;
    try {
      if (name === 'lost-create') {
        const computeName = exactResource(owner.recoveryRecord, 'compute').name;
        const route = `/v1.52/containers/create?name=${encodeURIComponent(computeName)}&platform=${encodeURIComponent(fixturePlatform(suite.profile))}`;
        const gate = arm('POST', route, 'drop_reply');
        const startup = failed(owner.start(), 'sandbox-start', evidence);
        const response = await gate.responded;
        assert.equal(response.status, 201);
        const id = returnedId(response);
        assert.equal((await inspectContainer(suite.endpoint, id, 'create-effect-before-cleanup', evidence)).State.Running, false);
        gate.release();
        original = await startup;
        assert(original instanceof SandboxStartError);
        await assert.rejects(owner.start(), SandboxStateError);
        await original.owner.stop();
        evidence.receipts.push({ operation: 'retained-start-owner-stop', status: 'succeeded' });
        assert.equal(resourceId(owner.recoveryRecord, 'compute'), id);
        await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'retained-owner-stop', evidence.observations, ['compute']);
        assert.equal(proxy.observations.filter((entry) => entry.method === 'POST' && entry.path === route).length, 1);
        evidence.facts.push({ lostReply: 'container-create', observedId: id, createRequests: 1, replayRejected: true });
      } else if (name === 'lost-start' || name === 'abort-pending-start') {
        // The compute ID is durable before the create reply is released, so the fault applies
        // only to that exact container's later start request.
        const createRoute = `/v1.52/containers/create?name=${encodeURIComponent(exactResource(owner.recoveryRecord, 'compute').name)}&platform=${encodeURIComponent(fixturePlatform(suite.profile))}`;
        const createGate = arm('POST', createRoute, 'hold_reply');
        const controller = new AbortController();
        const startup = failed(owner.start({ signal: controller.signal }), 'sandbox-start', evidence);
        const created = await createGate.responded;
        assert.equal(created.status, 201);
        const computeId = returnedId(created);
        const startRoute = `/v1.52/containers/${computeId}/start`;
        const startGate = arm('POST', startRoute, name === 'lost-start' ? 'drop_reply' : 'hold_request');
        createGate.release();
        if (name === 'lost-start') {
          assert.equal((await startGate.responded).status, 204);
          assert.equal((await inspectContainer(suite.endpoint, computeId, 'start-effect-before-cleanup', evidence)).State.Running, true);
          startGate.release();
          original = await startup;
          assert(original instanceof SandboxStartError);
          await original.owner.stop();
          evidence.receipts.push({ operation: 'retained-start-owner-stop', status: 'succeeded' });
        } else {
          await startGate.entered;
          assert.equal((await inspectContainer(suite.endpoint, computeId, 'pending-start-before-abort', evidence)).State.Running, false);
          controller.abort(new Error('Owned startup cancellation while the real start request is pending.'));
          original = await startup;
          assert(original instanceof SandboxStartError);
          await owner.stop();
          evidence.receipts.push({ operation: 'abort-owner-stop-before-dispatch-release', status: 'succeeded' });
          await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'abort-stop-before-late-start', evidence.observations, ['compute']);
          startGate.release();
          assert.equal((await startGate.responded).status, 404, 'A late real start dispatch must hit the removed exact ID.');
          await startGate.settled;
        }
        await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'start-failure-stop', evidence.observations, ['compute']);
        assert.equal(resourceId(owner.recoveryRecord, 'compute'), computeId);
        await assert.rejects(owner.start(), SandboxStateError);
        assert.equal(proxy.observations.filter((entry) => entry.method === 'POST' && entry.path === createRoute).length, 1);
        assert.equal(proxy.observations.filter((entry) => entry.method === 'POST' && entry.path === startRoute).length, 1);
        evidence.facts.push({ lostReply: name === 'lost-start' ? 'container-start' : null, abortedBeforeDispatch: name === 'abort-pending-start',
          computeId, startRequests: 1, lateStartHttpStatus: name === 'abort-pending-start' ? 404 : null });
      } else {
        sandbox = await owner.start();
        const computeId = resourceId(sandbox.recoveryRecord, 'compute');
        if (name === 'cleanup-observation-timeout') {
          const gate = arm('GET', `/v1.52/containers/${computeId}/json`, 'hold_request');
          const deleteRoute = `/v1.52/containers/${computeId}?force=true&v=false`;
          const deletion = arm('DELETE', deleteRoute, 'hold_reply');
          const stopping = failed(sandbox.stop(), 'original-sdk-stop', evidence);
          await gate.entered;
          original = await stopping;
          assert(original instanceof SandboxCleanupError);
          const originalSummary = failureSummary(original);
          assert(original.cause instanceof SandboxOperationError);
          assert.equal(original.cause.code, 'deadline_exceeded');
          assert.equal((await inspectContainer(suite.endpoint, computeId, 'cleanup-timeout-still-live', evidence)).State.Running, true);
          assert.throws(() => sandbox!.reserveProcess({ executable: '/usr/local/bin/node', args: ['-e', 'process.exit(0)'],
            cwd: sandbox!.workspace, env: {} }), SandboxStateError, 'Timed-out cleanup must keep process admission closed.');
          gate.release();
          assert.equal((await gate.responded).status, 200);
          await gate.settled;
          assert.equal((await deletion.responded).status, 204, 'The actual removal and independent kernel acknowledgement must settle before the retry observation starts.');
          const retry = original.retryCleanup();
          void retry.catch(() => {});
          deletion.release();
          await Promise.all([deletion.settled, retry]);
          evidence.receipts.push({ operation: 'retained-cleanup-owner-retry', status: 'succeeded' });
          assert.deepEqual(failureSummary(original), originalSummary, 'Later recovery must not rewrite the original failed receipt.');
          await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'retained-cleanup-retry', evidence.observations, ['compute']);
          const deleteRequests = proxy.observations.filter((entry) => entry.method === 'DELETE' && entry.path === deleteRoute).length;
          assert.equal(deleteRequests, 1, 'A cleanup observation retry must join the original removal rather than replay it.');
          evidence.facts.push({ computeId, observationStalled: true, originalCleanupCode: original.cause.code,
            retryThroughOriginalError: true, originalFailurePreserved: true, deleteRequests, actualRemovalObservedBeforeRetry: true });
        } else {
          const marker = `marker-${name}`;
          await importFixtures(sandbox, [{ path: 'command-marker', bytes: Buffer.alloc(0), executable: false }]);
          const command = sandbox.reserveProcess({ executable: '/usr/local/bin/node', cwd: sandbox.workspace, env: {}, args: ['-e',
            'require("node:fs").appendFileSync("command-marker",process.argv[1]+"\\n");process.exit(23)', marker] });
          const execCreateRoute = `/v1.52/containers/${computeId}/exec`;
          const createGate = arm('POST', execCreateRoute, name === 'lost-exec-create' ? 'drop_reply'
            : name === 'late-exec-create' ? 'hold_request' : 'hold_reply');
          const controller = new AbortController();
          const starting = failed(command.start({ signal: controller.signal }), 'process-start', evidence);
          let execId: string | undefined;
          let startRoute: string | undefined;
          if (name === 'late-exec-create') {
            await createGate.entered;
            controller.abort(new Error('Owned process cancellation before real exec-create dispatch.'));
            original = await starting;
            assert(original instanceof SandboxOperationError);
            await sandbox.stop();
            evidence.receipts.push({ operation: 'process-abort-stop-before-late-create', status: 'succeeded' });
            await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'before-late-exec-create', evidence.observations, ['compute']);
            createGate.release();
            assert.equal((await createGate.responded).status, 404);
            await createGate.settled;
          } else {
            const created = await createGate.responded;
            assert.equal(created.status, 201);
            execId = returnedId(created);
            if (name === 'lost-exec-create') {
              const inspection = await engineGet(suite.endpoint, `/exec/${execId}/json`);
              assert.equal(inspection.status, 200);
              assert(inspection.body !== null && typeof inspection.body === 'object' && 'Running' in inspection.body);
              assert.equal(inspection.body.Running, false);
              evidence.facts.push({ execCreateObserved: inspection.body });
              createGate.release();
              original = await starting;
              assert(original instanceof SandboxOperationError);
              await sandbox.stop();
            } else {
              startRoute = `/v1.52/exec/${execId}/start`;
              const startGate = arm('POST', startRoute, name === 'lost-exec-start' ? 'drop_reply' : 'hold_request');
              createGate.release();
              if (name === 'lost-exec-start') {
                const response = await startGate.responded;
                assert.equal(response.status, 101);
                const nativeExit = await waitForExit(suite.endpoint, execId);
                evidence.facts.push({ nativeExit });
                startGate.release();
                original = await starting;
                assert(original instanceof SandboxOperationError);
                await sandbox.stop();
              } else {
                await startGate.entered;
                controller.abort(new Error('Owned process cancellation before real exec-start dispatch.'));
                original = await starting;
                assert(original instanceof SandboxOperationError);
                await sandbox.stop();
                evidence.receipts.push({ operation: 'process-abort-stop-before-late-upgrade', status: 'succeeded' });
                await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'before-late-exec-start', evidence.observations, ['compute']);
                startGate.release();
                assert.equal((await startGate.responded).status, 404);
                await startGate.settled;
              }
            }
          }
          await assert.rejects(command.start(), SandboxStateError);
          await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'uncertain-exec-stop-before-export', evidence.observations, ['compute']);
          const files = await exportFixtures(sandbox, ['command-marker']);
          assert.equal(files.length, 1);
          const expectedMarker = name === 'lost-exec-start' ? `${marker}\n` : '';
          assert.equal(Buffer.from(files[0]!.bytes).toString('utf8'), expectedMarker);
          assert.equal(proxy.observations.filter((entry) => entry.method === 'POST' && entry.path === execCreateRoute).length, 1);
          if (startRoute) assert.equal(proxy.observations.filter((entry) => entry.method === 'POST' && entry.path === startRoute).length, 1);
          const startRequests = proxy.observations.filter((entry) => entry.method === 'POST' && /^\/v1\.52\/exec\/[a-f0-9]{64}\/start$/u.test(entry.path)).length;
          assert.equal(startRequests, name === 'lost-exec-start' || name === 'late-exec-start' ? 1 : 0);
          evidence.facts.push({ computeId, execId: execId ?? null, createRequests: 1,
            startRequests, markerLines: name === 'lost-exec-start' ? 1 : 0,
            marker: expectedMarker, replayRejected: true });
        }
      }
      assert(original instanceof Error, 'Every scenario must retain the original selected failure.');
    } catch (error) {
      evidence.primaryFailure = failureSummary(error);
      throw error;
    } finally {
      for (const gate of gates) gate.release();
      let destroyed = false;
      try { await owner.destroy(); destroyed = true; evidence.receipts.push({ operation: 'finally-destroy', status: 'succeeded' }); }
      catch (error) { evidence.cleanupFailures.push({ operation: 'sdk-destroy', error: failureSummary(error) }); }
      try { await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'finally-destroy', evidence.observations); }
      catch (error) { evidence.cleanupFailures.push({ operation: 'independent-final-inspection', error: failureSummary(error) }); }
      const expected = owner.recoveryRecord.resources.flatMap((resource) => resource.identity.kind === 'identified'
        ? [{ role: resource.role, id: resource.identity.id }] : []);
      const finalObservations = evidence.observations.filter((observation) => observation.checkpoint === 'finally-destroy'
        && expected.some((resource) => resource.role === observation.role && resource.id === observation.id));
      if (expected.length) {
        evidence.cleanupEvidence = { format: 'agenai.sandbox-cleanup-evidence.v1', rows: [{ label: name, expected,
          events: [{ sequence: 1, kind: 'sdk-close', result: destroyed ? 'fulfilled' : 'rejected' },
            ...finalObservations.map((observation, index) => ({ sequence: index + 2, kind: 'observation' as const,
              source: 'independent-engine' as const, role: observation.role, id: observation.id, httpStatus: observation.httpStatus }))],
        }] };
        const verdict = checkCleanupEvidence(evidence.cleanupEvidence);
        if (verdict.kind !== 'accepted') evidence.cleanupFailures.push({ operation: 'cleanup-evidence-check', verdict });
      }
      try { await proxy.close(); }
      catch (error) { evidence.cleanupFailures.push({ operation: 'proxy-close', error: failureSummary(error) }); }
      evidence.record = owner.recoveryRecord;
      evidence.proxyObservations = proxy.observations;
      await atomicJson(path.join(directory, 'report.json'), evidence);
      await atomicJson(path.join(suite.directory, 'report.json'), {
        format: 'agenai.sandbox-docker-uncertainty-evidence.v1', endpoint: suite.endpoint, imageDigest: suite.imageDigest,
        node: process.version, controllerPid: process.pid, scenarios: reports, modelCalls: 0, credentialReads: 0,
      });
      assert.deepEqual(evidence.cleanupFailures, [], 'Original failures and later SDK/proxy cleanup outcomes are retained separately.');
    }
  });
});
