import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fileFromBytes, SandboxStateError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { until } from '../../../engine.mjs';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { startController } from '../live/controller-process.mjs';
import { failure, jsonWriter } from '../live/evidence.mjs';
import { restricted } from './connectivity.mjs';
import { reserve } from './installed.mjs';
import { census, identified } from './resources.mjs';
import { sha } from './fixtures.mjs';

const script = fileURLToPath(new URL('./controller-child.mjs', import.meta.url));
const destructive = (method, target) => method === 'DELETE' || method === 'POST' && /\/(kill|stop|restart)(\?|$)/u.test(target);
function controlFrames(state, chunk) {
  state.multiplex = Buffer.concat([state.multiplex ?? Buffer.alloc(0), chunk]);
  assert(state.multiplex.length <= 4 * 1024 ** 2); const units = [];
  while (state.multiplex.length >= 8) {
    const length = state.multiplex.readUInt32BE(4); assert(length <= 4 * 1024 ** 2);
    if (state.multiplex.length < length + 8) break;
    const bytes = state.multiplex.subarray(0, length + 8); state.multiplex = state.multiplex.subarray(length + 8);
    const messages = [];
    if (bytes[0] === 1) {
      state.line = Buffer.concat([state.line ?? Buffer.alloc(0), bytes.subarray(8)]); assert(state.line.length <= 4 * 1024 ** 2);
      for (;;) {
        const end = state.line.indexOf(10); if (end < 0) break;
        const line = state.line.subarray(0, end); state.line = state.line.subarray(end + 1); const value = JSON.parse(line.toString());
        messages.push({ observedAt: new Date().toISOString(), kind: value.kind, protocol: value.protocol,
          ...(value.sequence === undefined ? {} : { sequence: value.sequence }), ...(value.reason === undefined ? {} : { reason: value.reason }),
          bytes: line.length, sha256: sha(line) });
      }
    }
    units.push({ bytes, messages });
  }
  return units;
}
async function hold(run, context, opened) {
  const response = await opened.session.request({ kind: 'hold', ...context.config.capabilities.network.positive, key: 'fault' });
  await run.observe({ kind: 'verified-active-tunnel-before-fault', response });
  assert.equal(response.ok, true); assert.equal(response.result.authorized, true); assert.equal(response.result.closed, false);
}
async function kill(run, context, entry, role) {
  const resource = identified(entry.owner.recoveryRecord, role);
  await run.observe({ kind: 'exact-helper-kill-entered', role, resource });
  await context.engine.request('POST', `/containers/${resource.identity.id}/kill?signal=KILL`, undefined, { allowed: [204] });
}
async function stopped(run, context, opened) {
  await until(() => opened.owner.state.kind !== 'ready', context.config.capabilities.limits.startupMs,
    'Native infrastructure failure did not fence its original public owner.');
  assert.throws(() => opened.sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: [], env: {}, cwd: opened.sandbox.workspace }), SandboxStateError);
  let sourceEntered = 0;
  const source = { async *[Symbol.asyncIterator]() { sourceEntered++; yield fileFromBytes('must-not-replay', Uint8Array.of(1)); } };
  assert.throws(() => opened.sandbox.importTree(source), SandboxStateError); assert.equal(sourceEntered, 0);
  await run.settleCleanup(opened.entry, 'stop');
  const observed = await census(context.engine, opened.owner.recoveryRecord, 'infrastructure-failure-stopped');
  for (const role of ['compute', 'egress_broker', 'egress_relay', 'route_observer']) assert.equal(observed.find((entry) => entry.role === role).status, 404);
  await run.observe({ kind: 'native-tunnel-producers-absent-and-public-mutation-fenced', sourceEntered, census: observed,
    closureEvidence: 'The verified entered tunnel has no remaining compute, broker or relay process; kernel absence is independently checked before delete acknowledgements.' });
}

function attachmentTap(run, role, cut) {
  let attachment; let armed = false; let entered = false; const decoding = {};
  const frames = []; let inputBytes = 0; let responseBytes = 0;
  return {
    arm() { armed = true; },
    get entered() { return entered; },
    observe({ target, status, connection, record }) {
      const owner = run.owners[0]?.owner; const resource = owner?.recoveryRecord.resources.find((entry) => entry.role === role);
      if (resource?.identity.kind !== 'identified' || !target.startsWith(`/v1.52/containers/${resource.identity.id}/attach?`)) return;
      assert.equal(status, 101); assert.equal(attachment, undefined);
      attachment = { target, openedAt: new Date().toISOString(), connection, record };
      return {
        input(chunk) { inputBytes += chunk.length; assert(inputBytes <= 512 * 1024); },
        async response(chunk, forward) {
          responseBytes += chunk.length; assert(responseBytes <= 4 * 1024 ** 2);
          for (const { bytes: frame, messages } of controlFrames(decoding, chunk)) {
            for (const message of messages) {
              assert(frames.length < 256); frames.push(message);
              if (armed && !entered && message.kind === 'heartbeat') {
                entered = true; await run.observe({ kind: 'actual-native-control-frame-cut', role, cut, witness: frames.at(-1), connection: connection() });
                if (cut === 'withhold') await delay(run.limits.requestMs + 2 * run.control.heartbeatMs);
                record.fault = cut === 'withhold' ? 'withheld-native-heartbeat-acknowledgement' : 'exact-owned-control-eof';
                return 'close';
              }
            }
            await forward(frame);
          }
        },
      };
    },
    snapshot() { assert(attachment); return { target: attachment.target, openedAt: attachment.openedAt,
      connection: attachment.connection(), finishedAt: attachment.record.finishedAt ?? null,
      inputBytes, responseBytes, frames, entered, cut }; },
  };
}
async function proxyFor(run, context, observeUpgrade, observeResponse) {
  const proxy = await createTraceProxy({ socketPath: join(run.directory, 'e.sock'), upstreamEndpoint: context.config.endpoint,
    tracePath: join(run.directory, 'trace.jsonl'), observeUpgrade, observeResponse });
  proxy.setRow('restricted-https'); run.proxies.push(proxy); return proxy;
}
async function controlLoss(run, context, role, cut = 'eof') {
  const tap = attachmentTap(run, role, cut); const proxy = await proxyFor(run, context, (value) => tap.observe(value));
  const opened = await restricted(run, context, { endpoint: proxy.endpoint }); await hold(run, context, opened); tap.arm();
  await until(() => tap.entered, context.config.capabilities.limits.requestMs + 2 * run.control.heartbeatMs,
    'The selected native helper did not enter the control cut.');
  await stopped(run, context, opened); await run.observe({ kind: 'native-control-loss-settlement', attachment: tap.snapshot() });
}

async function childCase(run, context, mode) {
  const limits = context.config.capabilities.limits; const requests = []; const attachments = [];
  const proxy = await proxyFor(run, context, ({ target, connection }) => {
    if (!/\/containers\/[a-f0-9]{64}\/attach\?/u.test(target)) return;
    const attachment = { target, connection, openedAt: new Date().toISOString(), inputBytes: 0, responseBytes: 0, frames: [] };
    attachments.push(attachment); assert(attachments.length <= 3); const decoding = {};
    return { input(chunk) { attachment.inputBytes += chunk.length; assert(attachment.inputBytes <= 512 * 1024); },
      async response(chunk, forward) {
        attachment.responseBytes += chunk.length; assert(attachment.responseBytes <= 4 * 1024 ** 2);
        for (const unit of controlFrames(decoding, chunk)) { attachment.frames.push(...unit.messages); assert(attachment.frames.length <= 256); }
        await forward(chunk);
      } };
  }, (request) => { if (destructive(request.method, request.target)) requests.push({ ...request, observedAt: new Date().toISOString() }); });
  const directory = join(run.directory, 'child');
  const childConfig = { ...context.config, endpoint: proxy.endpoint, output: directory,
    child: { mode, namespace: `${context.config.namespacePrefix}${randomUUID()}`, challenge: randomUUID(),
      originalPath: join(run.directory, 'original-checkpoint.json'), resultPath: join(run.directory, 'child-result.json') } };
  const path = join(run.directory, 'child-config.json'); await jsonWriter(path)(childConfig);
  run.evidence.childOwner = { configuration: path, directory, originalPath: childConfig.child.originalPath,
    namespace: childConfig.child.namespace, challenge: childConfig.child.challenge, cleanupKind: null, quiescent: false,
    originalReservationConfirmed: false };
  await run.save(); let child; let original; let bytes; let completed = false;
  let resumedAt;
  run.afterCleanup.push(async () => {
    const bytes = await readFile(join(run.directory, 'trace.jsonl')); assert(bytes.length <= 4 * 1024 ** 2);
    const entries = bytes.toString().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const creates = entries.filter(({ method, target }) => method === 'POST' && target.startsWith('/v1.52/containers/create?'));
    if (original) assert.equal(creates.length, 5, 'Only original observer/broker/compute/export/relay acquisition may create containers.');
    if (resumedAt) assert.equal(entries.filter(({ method, target, startedAt }) => destructive(method, target) && startedAt < resumedAt).length, 0);
    await run.observe({ kind: 'original-controller-no-create-replay', containerCreates: creates.length, resumedAt: resumedAt ?? null,
      traceBytes: bytes.length, traceSha256: sha(bytes) });
  });
  const recover = async (kind) => {
    const recoveryConfig = { ...childConfig, child: { ...childConfig.child, mode: 'cleanup',
      resultPath: join(run.directory, `${kind}-result.json`) } };
    const recoveryPath = join(run.directory, `${kind}.json`); await jsonWriter(recoveryPath)(recoveryConfig);
    const cleanup = startController({ script, configuration: recoveryPath, cwd: context.config.consumer, env: process.env,
      timeoutMs: limits.cleanupMs * 2 + limits.requestMs, maxOutputBytes: limits.maxOutputBytes, signal: context.signal });
    const exit = await cleanup.join(); const result = JSON.parse(await readFile(recoveryConfig.child.resultPath, 'utf8'));
    await run.observe({ kind: 'fresh-process-original-checkpoint-cleanup-only', exit, result });
    assert.equal(exit.code, 0); assert.equal(result.status, 'passed'); assert.equal(result.finalRecord.phase, 'destroyed');
    run.evidence.childOwner.cleanupKind = kind; run.evidence.childOwner.recovered = true; completed = true;
  };
  try {
    child = startController({ script, configuration: path, cwd: context.config.consumer, env: process.env,
      mode: mode === 'lease' ? 'lease' : 'start', timeoutMs: limits.scenarioMs, maxOutputBytes: limits.maxOutputBytes,
      signal: context.signal, onControl: () => run.save() });
    run.evidence.childOwner.pid = child.pid; run.evidence.controllerSignals = child.controls; await run.save();
    const initialized = await child.ready(limits.startupMs + 2 * limits.requestMs);
    assert.equal(initialized.challenge, childConfig.child.challenge);
    bytes = await readFile(childConfig.child.originalPath); assert(bytes.length <= 256 * 1024);
    original = parseSandboxRecoveryRecord(JSON.parse(bytes.toString())); assert.equal(original.phase, 'running');
    assert.equal(original.namespace, childConfig.child.namespace); assert.equal(original.imageDigest, context.config.imageDigest);
    assert.equal(original.backendRevision, `engine-1.52-v6-${context.config.profile}`);
    run.evidence.childOwner.originalReservationConfirmed = true;
    run.evidence.childOwner.originalSha256 = sha(bytes);
    await run.observe({ kind: 'original-controller-durable-ready', initialized, original,
      census: await census(context.engine, original, 'controller-ready') });
    if (mode === 'crash') {
      const exit = await child.kill(); assert.equal(exit.signal, 'SIGKILL'); assert.equal(exit.groupQuiescent, true);
      await run.observe({ kind: 'original-controller-killed-and-joined', exit }); run.evidence.childOwner.quiescent = true;
      await recover('fresh-process-cleanup');
    } else {
      const open = () => attachments.map((entry) => ({ target: entry.target, openedAt: entry.openedAt, connection: entry.connection(),
        inputBytes: entry.inputBytes, responseBytes: entry.responseBytes, frames: structuredClone(entry.frames) }));
      const inspect = async () => {
        const roles = {};
        for (const role of ['compute', 'egress_broker', 'egress_relay', 'route_observer']) {
          const resource = identified(original, role); const actual = (await context.engine.request('GET', `/containers/${resource.identity.id}/json`)).data;
          roles[role] = { id: resource.identity.id, state: actual.State };
        }
        return { observedAt: new Date().toISOString(), roles, attachments: open() };
      };
      const initial = await inspect(); assert(initial.attachments.length === 3);
      for (const role of ['egress_broker', 'egress_relay', 'route_observer']) {
        const id = identified(original, role).identity.id;
        assert.equal(initial.attachments.filter(({ target }) => target.startsWith(`/v1.52/containers/${id}/attach?`)).length, 1);
      }
      for (const attachment of initial.attachments) for (const side of Object.values(attachment.connection)) assert.deepEqual(side, { destroyed: false, readableEnded: false, writableEnded: false });
      const paused = await child.pause(); await run.observe({ kind: 'original-controller-paused', paused, initial });
      const leases = { egress: run.control.leaseTimeoutMs,
        route_observer: context.config.capabilities.network.routeAuthority.vmObserver.control.leaseTimeoutMs };
      const lease = Math.max(...Object.values(leases)); const intermediateDelayMs = Math.floor(Math.min(...Object.values(leases)) / 2);
      await delay(intermediateDelayMs, undefined, { signal: context.signal });
      const intermediate = await inspect(); const group = await child.snapshot();
      assert(group.processes.every(({ state }) => state.startsWith('T')));
      assert(Object.values(intermediate.roles).every(({ state }) => state.Running));
      for (const attachment of intermediate.attachments) for (const side of Object.values(attachment.connection)) assert.equal(side.destroyed, false);
      await run.observe({ kind: 'paused-intermediate-helpers-running-and-attachments-open', intermediate, group, leases, intermediateDelayMs });
      const expired = await until(async () => {
        const actual = await inspect(); assert.equal(actual.roles.compute.state.Running, true);
        return ['egress_broker', 'egress_relay', 'route_observer'].every((role) => !actual.roles[role].state.Running) ? actual : false;
      }, lease + limits.requestMs, 'Prepared native helper leases did not expire with their original controller paused.');
      const expiredGroup = await child.snapshot(); assert(expiredGroup.processes.every(({ state }) => state.startsWith('T')));
      expired.attachments = await until(() => {
        const observed = open(); return observed.length === 3 && observed.every(({ frames }) => frames.some(({ kind, reason }) => kind === 'closed' && reason === 'lease_expired')) ? observed : false;
      }, limits.requestMs, 'Native helpers exited without their retained lease-expired control receipts.');
      assert.equal(requests.length, 0);
      for (const role of ['egress_broker', 'egress_relay', 'route_observer']) {
        assert.equal(expired.roles[role].state.OOMKilled, false); assert.equal(expired.roles[role].state.ExitCode, 0);
        assert.equal(expired.roles[role].state.Error, '');
        const id = identified(original, role).identity.id;
        const attachment = expired.attachments.find(({ target }) => target.startsWith(`/v1.52/containers/${id}/attach?`));
        assert(attachment.frames.some(({ kind, reason }) => kind === 'closed' && reason === 'lease_expired'), 'Native helper omitted its lease-expired wire receipt.');
      }
      await run.observe({ kind: 'natural-native-control-lease-expiry', expired, expiredGroup, requests, leases,
        clockScope: 'Lease begins at each last decoded native command; SIGSTOP is not an exact lease-start timestamp.' });
      const resumed = await child.resume(); resumedAt = resumed.enteredAt;
      const exit = await child.join(); run.evidence.childOwner.quiescent = true;
      const result = JSON.parse(await readFile(childConfig.child.resultPath, 'utf8'));
      await run.observe({ kind: 'same-original-controller-resumed-fenced-and-cleaned', resumed, exit, result });
      assert.equal(exit.code, 0); assert.equal(result.status, 'passed'); assert.equal(result.pid, child.pid);
      assert.equal(result.challenge, childConfig.child.challenge); assert.equal(result.continueCount, 1);
      assert.equal(result.cleanupKind, 'original-controller'); assert.equal(result.finalRecord.phase, 'destroyed');
      run.evidence.childOwner.cleanupKind = 'original-controller'; completed = true;
    }
    assert.deepEqual(await readFile(childConfig.child.originalPath), bytes);
    await run.observe({ kind: 'independent-original-controller-resource-absence', census: await census(context.engine, original, 'child-final', true) });
  } finally {
    if (child && !run.evidence.childOwner.quiescent) {
      try { const exit = await child.kill(); run.evidence.childOwner.quiescent = exit.groupQuiescent; await run.observe({ kind: 'failed-case-controller-join', exit }); }
      catch (error) { run.evidence.childOwner.quiescent = error.quiescent === true; await run.observe({ kind: 'failed-case-controller-join-error', failure: failure(error) }); }
    }
    if (!completed && run.evidence.childOwner.quiescent) {
      try {
        const result = JSON.parse(await readFile(childConfig.child.resultPath, 'utf8'));
        assert.equal(result.pid, child.pid); assert.equal(result.challenge, childConfig.child.challenge);
        if (result.finalRecord?.phase === 'destroyed') {
          await run.observe({ kind: 'failed-child-original-owner-already-cleaned', result,
            census: await census(context.engine, result.finalRecord, 'failed-child-final', true) });
          run.evidence.childOwner.cleanupKind = 'failed-child-original-owner-cleanup'; completed = true;
        }
      } catch (error) { if (error.code !== 'ENOENT') await run.observe({ kind: 'failed-child-result-read', failure: failure(error) }); }
      try { if (!completed) { await readFile(childConfig.child.originalPath); await recover('failed-test-fresh-cleanup-only'); } }
      catch (error) { run.evidence.cleanupErrors.push(failure(error)); await run.save(); }
    }
  }
}

export function faultCases(context) {
  return [
    ...[['broker', 'egress_broker'], ['relay', 'egress_relay'], ['route-observer', 'route_observer']].map(([name, role]) =>
      [`${name}-loss-active-tunnel`, async (run) => { const opened = await restricted(run, context); await hold(run, context, opened);
        await kill(run, context, opened.entry, role); await stopped(run, context, opened); }]),
    ...[['broker', 'egress_broker'], ['relay', 'egress_relay']].map(([name, role]) =>
      [`${name}-control-eof-active-tunnel`, (run) => controlLoss(run, context, role)]),
    ['route-observer-control-eof-active-tunnel', async (run) => {
      let armed = false; let entered = false; let inputBytes = 0; let responseBytes = 0;
      const proxy = await proxyFor(run, context, ({ target, record, connection }) => {
        const resource = run.owners[0]?.owner.recoveryRecord.resources.find(({ role }) => role === 'route_observer');
        if (resource?.identity.kind !== 'identified' || !target.startsWith(`/v1.52/containers/${resource.identity.id}/attach?`)) return;
        return { input(chunk) { inputBytes += chunk.length; assert(inputBytes <= 512 * 1024); }, async response(chunk, forward) {
          responseBytes += chunk.length; assert(responseBytes <= 4 * 1024 ** 2);
          if (armed && !entered) {
            entered = true; record.fault = 'exact-route-observer-control-eof';
            const actual = (await context.engine.request('GET', `/containers/${resource.identity.id}/json`)).data;
            await run.observe({ kind: 'actual-route-observer-attachment-wire-cut', id: resource.identity.id, target,
              inputBytes, responseBytes, cutBytes: chunk.length, cutSha256: sha(chunk),
              boundedWirePrefixBase64: chunk.subarray(0, 1024).toString('base64'), state: actual.State, connection: connection() });
            assert.equal(actual.State.Running, true); return 'close';
          }
          await forward(chunk);
        } };
      });
      const opened = await restricted(run, context, { endpoint: proxy.endpoint }); await hold(run, context, opened); armed = true;
      await until(() => entered, context.config.capabilities.limits.requestMs, 'Original observer never entered its EOF cut.');
      await stopped(run, context, opened); await run.observe({ kind: 'route-observer-actual-control-eof', entered });
    }],
    ['host-observer-unavailable', async (run) => {
      const original = context.config.capabilities.network.routeAuthority.hostObserver.executable;
      const path = join(run.directory, 'host-observer'); await copyFile(original.path, path); await chmod(path, 0o500);
      assert.equal(sha(await readFile(path)), original.sha256);
      const opened = await restricted(run, context, { hostExecutable: { path, sha256: original.sha256 } }); await hold(run, context, opened);
      run.beforeCleanup.push(() => chmod(path, 0o500)); await run.observe({ kind: 'owned-host-observer-permission-loss-entered', path });
      await chmod(path, 0); await stopped(run, context, opened);
    }],
    ['authority-loss-during-resource-create', async (run) => {
      let entered = false;
      const proxy = await proxyFor(run, context, undefined, async ({ method, target, status }) => {
        if (method === 'POST' && target === '/v1.52/networks/create' && status === 201 && !entered) {
          entered = true; await kill(run, context, run.owners[0], 'route_observer');
        }
      });
      const opened = await reserve(run, context, { endpoint: proxy.endpoint });
      const outcome = await opened.owner.start({ signal: context.signal }).then(() => ({ kind: 'started' }), (error) => ({ kind: 'rejected', failure: failure(error) }));
      await run.observe({ kind: 'native-observer-loss-before-network-create-ack', entered, outcome });
      assert.equal(entered, true); assert.equal(outcome.kind, 'rejected');
    }],
    ['authority-loss-before-process-admission', async (run) => {
      const opened = await reserve(run, context); const sandbox = await opened.owner.start({ signal: context.signal });
      await kill(run, context, opened.entry, 'route_observer');
      await until(() => opened.owner.state.kind !== 'ready', run.limits.startupMs, 'Observer loss did not fence process admission.');
      assert.throws(() => sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: [], cwd: sandbox.workspace, env: {} }), SandboxStateError);
      await run.observe({ kind: 'public-process-grant-refused-after-observed-authority-loss', state: opened.owner.state });
    }],
    ['observed-owned-route-addition', async (run) => {
      const opened = await restricted(run, context); await hold(run, context, opened);
      const bridge = await context.fixtures.createBridge('route_drift');
      run.afterCleanup.push(() => context.fixtures.remove(bridge));
      await run.observe({ kind: 'owned-public-route-created-after-original-seal', bridge }); await stopped(run, context, opened);
    }],
    ['foreign-member-authority-fence', async (run) => {
      const foreign = await context.fixtures.prepareForeign(run);
      await context.fixtures.awaitQuiescence();
      const opened = await restricted(run, context); await hold(run, context, opened);
      await context.fixtures.foreignMember(run, opened.entry, foreign); await stopped(run, context, opened);
    }],
    ['authority-loss-during-stop', async (run) => {
      let entered = false; let pending = Buffer.alloc(0);
      const proxy = await proxyFor(run, context, ({ target, connection }) => {
        const resource = run.owners[0]?.owner.recoveryRecord.resources.find(({ role }) => role === 'route_observer');
        if (resource?.identity.kind !== 'identified' || !target.startsWith(`/v1.52/containers/${resource.identity.id}/attach?`)) return;
        return { async input(chunk) {
          pending = Buffer.concat([pending, chunk]); assert(pending.length <= 4096);
          for (;;) {
            const end = pending.indexOf(10); if (end < 0) break;
            const bytes = pending.subarray(0, end + 1); pending = pending.subarray(end + 1); const command = JSON.parse(bytes.toString());
            if (command.kind === 'stop' && !entered) {
              entered = true; assert.equal(run.owners[0].owner.state.kind, 'stopping');
              const actual = (await context.engine.request('GET', `/containers/${resource.identity.id}/json`)).data;
              await run.observe({ kind: 'original-observer-stop-command-held-before-forwarding', resource, target,
                command, bytes: bytes.length, sha256: sha(bytes), state: actual.State, connection: connection() });
              assert.equal(actual.State.Running, true); await kill(run, context, run.owners[0], 'route_observer');
            }
          }
        }, async response(chunk, forward) { await forward(chunk); } };
      });
      const opened = await restricted(run, context, { endpoint: proxy.endpoint });
      await hold(run, context, opened); await run.settleCleanup(opened.entry, 'stop');
      assert.equal(entered, true); await run.observe({ kind: 'observer-loss-after-original-stop-entered', entered, state: opened.owner.state });
    }],
    ['paused-controller-native-lease', (run) => childCase(run, context, 'lease')],
    ['original-checkpoint-fresh-cleanup-only', (run) => childCase(run, context, 'crash')],
    ['withheld-native-control-acknowledgement', (run) => controlLoss(run, context, 'egress_broker', 'withhold')],
  ];
}
