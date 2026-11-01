import assert from 'node:assert/strict';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupMember, continuity, networkProof } from './member.mjs';
import { failure, observe } from './evidence.mjs';
import { resourcePath } from '../capabilities/network/resources.mjs';

export function installControlLoss({ socketPath, member, role, evidence }) {
  const originalRequest = http.request; const originalGet = http.get;
  const report = { format: 'agenai.desktop-coordinator-original-control-loss.v1', role, captured: null, injected: null, closedAt: null,
    failures: [], scope: 'Passive capture of one original member HTTP-upgrade attachment and its original socket. No new reader, attachment, helper or success callback is introduced; fault destroys only that captured original socket.' };
  const writes = []; let originalSocket = null; let restored = false;
  http.request = function capturedControlRequest(options, ...args) {
    const request = Reflect.apply(originalRequest, this, [options, ...args]);
    const entry = member(); const resource = entry?.owner?.recoveryRecord.resources.find((item) => item.role === role);
    if (report.captured || !resource || resource.identity.kind !== 'identified' || options.socketPath !== socketPath || options.method !== 'POST') return request;
    const target = new URL(options.path, 'http://qualification.invalid');
    if (target.pathname !== `/v1.52/containers/${encodeURIComponent(resource.identity.id)}/attach`) return request;
    const originalEmit = request.emit;
    request.emit = function originalControlUpgrade(event, ...values) {
      if (event === 'upgrade') {
        const [response, socket, head] = values;
        try {
          assert.equal(originalSocket, null); assert.equal(response.statusCode, 101); assert(head.length <= 65_536);
          originalSocket = socket;
          report.captured = { at: new Date().toISOString(), pid: process.pid, label: entry.label, resource,
            record: entry.owner.recoveryRecord, method: options.method, target: options.path, status: response.statusCode,
            originalHeadBytes: head.length, destroyed: socket.destroyed, readable: socket.readable, writable: socket.writable,
            identity: { localAddress: socket.localAddress ?? null, localPort: socket.localPort ?? null,
              remoteAddress: socket.remoteAddress ?? null, remotePort: socket.remotePort ?? null } };
          writes.push(evidence.file('control-original-upgrade-head.bin', Buffer.from(head), 65_536)
            .then((stored) => { report.captured.head = stored; }).catch((error) => { report.failures.push(failure(error)); }));
          socket.once('error', (error) => { report.socketError = { at: new Date().toISOString(), failure: failure(error) }; });
          socket.once('close', (hadError) => { report.closedAt = new Date().toISOString(); report.closeHadError = hadError; });
        } catch (error) { report.failures.push(failure(error)); }
      }
      return Reflect.apply(originalEmit, this, [event, ...values]);
    };
    return request;
  };
  http.get = function capturedControlGet(...args) { const request = http.request(...args); request.end(); return request; };
  syncBuiltinESMExports();
  return {
    report,
    async inject() {
      await Promise.all(writes); assert.equal(report.failures.length, 0); assert(report.captured && originalSocket);
      assert.equal(report.injected, null); assert.equal(originalSocket.destroyed, false, 'The exact original attachment already closed before fault injection.');
      const entry = member(); assert.equal(entry.label, report.captured.label);
      assert.deepEqual(entry.owner.recoveryRecord.resources.find((item) => item.role === role), report.captured.resource);
      report.injected = { at: new Date().toISOString(), label: entry.label, resource: report.captured.resource,
        operation: 'destroy-exact-original-upgraded-socket' };
      await evidence.file('control-loss-intent.json', report);
      originalSocket.destroy(new Error('Explicit MS005 qualification loss of the exact original member control socket.'));
    },
    async close() {
      if (!restored) { restored = true; http.request = originalRequest; http.get = originalGet; syncBuiltinESMExports(); }
      await Promise.all(writes); return report;
    },
  };
}

export async function captureRetainedFence(coordinator, evidence) {
  const state = coordinator.state;
  assert.equal(state.kind, 'fenced', 'Retained-error observation requires an already fenced original public owner.');
  const report = { requestedAt: new Date().toISOString(), state, method: 'activate-on-already-fenced-original-owner',
    retainedError: null, captureFailure: null,
    scope: 'The already-activated fenced public owner rejects activate with its retained first error before effects. This observes that original error; it grants no execution restoration or causal classification.' };
  try {
    await observe(coordinator.activate({ timeoutMs: 1000 }), 1500, 'Original fenced-owner retained error observation');
    report.captureFailure = { name: 'UnexpectedAdmission', message: 'An already fenced original owner unexpectedly accepted activation.' };
  } catch (error) {
    if (error?.owner === coordinator && error.failure) {
      report.retainedError = failure(error);
      try { assert.deepEqual(error.failure, state.failure, 'Retained public error differs from the original fenced state.'); }
      catch (cause) { report.captureFailure = failure(cause); }
    } else report.captureFailure = failure(error);
  }
  report.observedAt = new Date().toISOString(); report.stateAfter = coordinator.state;
  return { ...report, evidence: await evidence.file('control-retained-fence-error.json', report) };
}

export async function runControlLoss(context, a, b) {
  const report = { role: context.scenario.role, before: context.coordinator.state, outcome: null };
  context.report.controlLoss = report;
  const resource = b.owner.recoveryRecord.resources.find(({ role }) => role === context.scenario.role); assert.equal(resource.identity.kind, 'identified');
  report.originalHelper = await context.engine.request('GET', resourcePath(resource));
  assert.equal(report.originalHelper.data.Id, resource.identity.id); assert.equal(report.originalHelper.data.State.Running, true);
  const previous = a.session.lastTick.counter; await context.controlFault.inject();
  const deadline = performance.now() + context.input.capabilities.limits.requestMs;
  while (context.coordinator.state.kind === 'active' && b.owner.state.kind === 'ready') {
    context.signal.throwIfAborted(); assert(performance.now() < deadline, 'Original control loss did not close unsafe member admission.'); await delay(25);
  }
  report.afterLossAt = new Date().toISOString(); report.afterLoss = context.coordinator.state; report.memberState = b.owner.state;
  report.helperInspection = { startedAt: new Date().toISOString(), coordinator: context.coordinator.state,
    attribution: 'Inspection follows observed admission closure. A later exited or absent helper does not establish that helper exit caused a group fence.' };
  report.failedHelper = await context.engine.request('GET', resourcePath(resource), undefined, { allowed: [200, 404] });
  report.helperInspection.finishedAt = new Date().toISOString(); report.helperInspection.coordinatorAfter = context.coordinator.state;
  if (context.coordinator.state.kind === 'active') {
    try {
      assert.notEqual(b.owner.state.kind, 'ready');
      await continuity(context, a, 'a-after-b-original-control-loss', previous);
      await networkProof(context, a, 'github.com', 'example.com', 'a-after-b-original-control-loss');
      assert.equal(context.coordinator.state.kind, 'active');
      await cleanupMember(context, b);
      await continuity(context, a, 'a-after-failed-b-exact-cleanup');
      await networkProof(context, a, 'github.com', 'example.com', 'a-after-failed-b-exact-cleanup');
      assert.equal(context.coordinator.state.kind, 'active'); report.outcome = 'member-local-loss-with-proven-original-peer-continuation';
    } catch (error) {
      report.continuationFailure = { at: new Date().toISOString(), failure: failure(error), coordinator: context.coordinator.state };
      if (context.coordinator.state.kind !== 'fenced') {
        report.outcome = 'finding-original-peer-continuation-not-proven';
        await context.evidence.file('control-loss-final.json', report); throw error;
      }
    }
  }
  if (report.outcome === null) {
    assert.equal(context.coordinator.state.kind, 'fenced');
    report.retainedFence = await captureRetainedFence(context.coordinator, context.evidence);
    report.fenceObservation = { at: new Date().toISOString(), state: context.coordinator.state,
      cause: 'Unproven. Preserve original admission error chains and passive Engine response bytes for independent attribution; post-fence helper state is not a causal witness.' };
    report.admissionFailures = [];
    for (const entry of [a, b]) {
      let rejected; const requestedAt = new Date().toISOString();
      try { await entry.sandbox.files.stat('.'); } catch (error) { rejected = error; }
      assert(rejected instanceof context.sdk.SandboxStateError, 'A group fence must close both existing live-file admissions.');
      report.admissionFailures.push({ label: entry.label, requestedAt, rejectedAt: new Date().toISOString(),
        failure: failure(rejected), state: entry.owner.state, originalSession: entry.session.summary() });
    }
    report.outcome = 'finding-group-fence-cause-unproven';
    report.safetyCleanup = { bothLiveAdmissionsClosed: true, exactOriginalCleanupSettled: false };
    await context.evidence.file('control-loss-outcome.json', report);
    for (const entry of [b, a]) if (entry.report.finalState?.kind !== 'destroyed') await cleanupMember(context, entry);
    report.safetyCleanup.exactOriginalCleanupSettled = true;
    report.safetyCleanup.settledAt = new Date().toISOString(); report.finalCoordinator = context.coordinator.state;
    await context.evidence.file('control-loss-final.json', report);
    assert.fail('Group fence cause remains unproven. Closed admissions and exact original cleanup are recorded separately; post-fence helper absence cannot qualify shared-authority failure.');
  }
  report.finalCoordinator = context.coordinator.state;
  await context.evidence.file('control-loss-final.json', report);
}
