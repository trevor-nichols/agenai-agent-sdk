import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedCommand } from '../../../command.mjs';
import { until } from '../../../engine.mjs';
import { PublicationGate } from '../../../capabilities/live/publicationGate.mjs';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { startController } from './controller-process.mjs';
import { census, failure, jsonWriter } from './evidence.mjs';
import { sha } from './operations.mjs';

const script = fileURLToPath(new URL('./recovery-child.mjs', import.meta.url));
const destructive = (method, target) => method === 'DELETE' || method === 'POST' && /\/(?:kill|stop|restart)(?:\?|$)/u.test(target);

function attachmentWitness() {
  const gate = new PublicationGate(() => { throw new Error('The lease witness cannot withhold a publication.'); });
  const inputHash = createHash('sha256'); const responseHash = createHash('sha256');
  let attachment; let inputBytes = 0; let responseBytes = 0; let lastInputAt = null; let lastResponseAt = null;
  return {
    observe({ method, target, status, record, connection }) {
      if (method !== 'POST' || !/^\/v1\.52\/containers\/[a-f0-9]{64}\/attach\?/u.test(target)) return;
      assert.equal(status, 101); assert.equal(attachment, undefined);
      attachment = { target, record, connection, openedAt: new Date().toISOString() };
      return {
        input(chunk) {
          inputBytes += chunk.byteLength; assert(inputBytes <= 256 * 1024);
          lastInputAt = new Date().toISOString(); inputHash.update(chunk); gate.observeInput(chunk);
        },
        async response(chunk, forward) {
          responseBytes += chunk.byteLength; assert(responseBytes <= 256 * 1024);
          lastResponseAt = new Date().toISOString(); responseHash.update(chunk); await forward(chunk);
        },
      };
    },
    snapshot() {
      assert(attachment, 'The exact original filesystem attachment was not observed.');
      return { observedAt: new Date().toISOString(), target: attachment.target, openedAt: attachment.openedAt,
        connection: attachment.connection(), finishedAt: attachment.record.finishedAt ?? null, failure: attachment.record.failure,
        inputBytes, inputSha256: inputHash.copy().digest('hex'), responseBytes, responseSha256: responseHash.copy().digest('hex'),
        lastInputAt, lastResponseAt,
        pendingCommandBytes: gate.commands.length, commandCounts: { ...gate.commandCounts } };
    },
  };
}

function assertOpen(attachment) {
  assert.equal(attachment.finishedAt, null); assert.equal(attachment.failure, null);
  for (const side of ['upstream', 'downstream']) {
    assert.deepEqual(attachment.connection[side], { destroyed: false, readableEnded: false, writableEnded: false });
  }
}

async function expireWhilePaused(run, context, child, original, wire, prohibited) {
  const limits = context.config.capabilities.limits;
  const control = context.config.capabilities.filesystem.configuration.control;
  const helper = original.resources.find(({ role }) => role === 'filesystem');
  const compute = original.resources.find(({ role }) => role === 'compute');
  const inspect = async (checkpoint) => {
    const helperState = (await context.engine.request('GET', `/containers/${helper.identity.id}/json`)).data;
    const computeState = (await context.engine.request('GET', `/containers/${compute.identity.id}/json`)).data;
    assert.equal(helperState.Id, helper.identity.id); assert.equal(computeState.Id, compute.identity.id);
    return { checkpoint, observedAt: new Date().toISOString(), helperId: helperState.Id, helperState: helperState.State,
      computeId: computeState.Id, computeState: computeState.State, attachment: wire.snapshot() };
  };
  const before = await inspect('before-controller-pause'); assertOpen(before.attachment);
  assert.equal(before.helperState.Running, true); assert.equal(before.computeState.Running, true);
  assert(before.attachment.target.startsWith(`/v1.52/containers/${helper.identity.id}/attach?`));
  run.evidence.fault = { kind: 'SIGSTOP-original-controller-with-native-filesystem-lease', pid: child.pid, control,
    before, expiryClock: 'Native lease is renewed by the last decoded command; SIGSTOP is not that timestamp.' };
  await run.save();
  const paused = await child.pause();
  const initial = await inspect('paused-controller-helper-still-running');
  assert.equal(initial.helperState.Running, true); assert.equal(initial.computeState.Running, true); assertOpen(initial.attachment);
  run.evidence.observations.push({ kind: 'owned-controller-paused-with-open-native-attachment', paused, initial }); await run.save();
  const intermediateDelayMs = Math.floor(control.leaseTimeoutMs / 2);
  await delay(intermediateDelayMs, undefined, { signal: context.signal });
  const intermediate = await inspect('intermediate-paused-controller-helper-running');
  assert.equal(intermediate.helperState.Running, true); assert.equal(intermediate.computeState.Running, true); assertOpen(intermediate.attachment);
  const intermediateGroup = await child.snapshot();
  assert(intermediateGroup.processes.every(({ state }) => state.startsWith('T')));
  run.evidence.observations.push({ kind: 'intermediate-paused-controller-and-open-attachment', intermediateDelayMs,
    intermediate, group: intermediateGroup }); await run.save();
  let polls = 0;
  const expired = await until(async () => {
    context.signal.throwIfAborted(); polls++;
    const actual = await inspect('natural-native-filesystem-exit');
    assert.equal(actual.computeState.Running, true);
    if (!actual.helperState.Running) return actual;
    await delay(1000, undefined, { signal: context.signal }); return false;
  }, control.leaseTimeoutMs + limits.requestMs, 'The native filesystem helper did not expire while its original controller stayed paused.');
  const expiredGroup = await child.snapshot();
  assert(expiredGroup.processes.every(({ state }) => state.startsWith('T')));
  run.evidence.observations.push({ kind: 'native-filesystem-lease-expired-with-controller-paused', expired, polls,
    group: expiredGroup, completedDestructiveRequests: [...prohibited] }); await run.save();
  assert.equal(expired.helperState.ExitCode, 74); assert.equal(expired.helperState.OOMKilled, false);
  assert.equal(expired.helperState.Error, ''); assert.equal(prohibited.length, 0);
  assert.equal(expired.attachment.commandCounts[5], 1); assert.equal(expired.attachment.commandCounts[6], 1);
  assert.equal(expired.attachment.commandCounts[7], 1);
  const resumed = await child.resume();
  run.evidence.observations.push({ kind: 'original-controller-resumed-after-native-expiry', resumed }); await run.save();
  return resumed;
}

async function controllerCase(run, context, mode) {
  const limits = context.config.capabilities.limits;
  const tracePath = join(run.directory, 'trace.jsonl'); const wire = mode === 'lease' ? attachmentWitness() : null;
  const prohibited = [];
  const proxy = await createTraceProxy({ socketPath: join(run.directory, 'e.sock'), upstreamEndpoint: context.config.endpoint, tracePath,
    observeUpgrade: wire ? (observation) => wire.observe(observation) : undefined,
    observeResponse({ method, target, status }) {
      if (destructive(method, target)) {
        prohibited.push({ method, target, status, observedAt: new Date().toISOString() }); assert(prohibited.length <= 32);
      }
    } });
  run.proxies.push(proxy); proxy.setRow('live-files');
  const originalPath = join(run.directory, 'original-checkpoint.json');
  const recoveryPath = join(run.directory, 'recovery.json'); const readyPath = join(run.directory, 'ready.json');
  const config = { config: { ...context.config, endpoint: proxy.endpoint }, directory: run.directory,
    namespace: `${context.config.namespacePrefix}${randomUUID()}`, challenge: randomUUID(), originalPath, recoveryPath, readyPath,
    expectRetry: false, resultPath: join(run.directory, 'start-result.json') };
  const startPath = join(run.directory, 'start.json'); await jsonWriter(startPath)(config);
  run.evidence.crashOwner = { namespace: config.namespace, originalPath, recoveryPath, startPath, mode,
    challenge: config.challenge, controllerQuiescent: true, recovered: false, cleanupKind: null };
  await run.save();
  let child; let primary; let original; let checkpointBytes; let resumedAt;
  let recovered = false; let quiescent = true;
  const recover = async (expectRetry) => {
    const path = join(run.directory, `recover-${expectRetry ? 'fault' : 'fallback'}.json`);
    const resultPath = join(run.directory, `recover-${expectRetry ? 'fault' : 'fallback'}-result.json`);
    await jsonWriter(path)({ ...config, expectRetry, resultPath });
    const execution = await runOwnedCommand({ command: process.execPath, args: [script, 'recover', path],
      cwd: context.config.consumer, env: process.env, timeoutMs: limits.cleanupMs * 4 + limits.requestMs,
      maxOutputBytes: limits.maxOutputBytes, terminationGraceMs: limits.cleanupMs });
    const result = JSON.parse((await readFile(resultPath)).toString('utf8'));
    assert.equal(result.status, 'passed'); assert.deepEqual(result.cleanupErrors, []);
    if (expectRetry) assert.equal(result.reconciliation, 'matched');
    else assert(['matched', 'absent'].includes(result.reconciliation));
    if (expectRetry) assert(result.retainedFailure, 'The exact lost cleanup acknowledgement must exercise a real retry owner.');
    run.evidence.observations.push({ kind: 'fresh-process-original-record-cleanup-only', execution, result });
    run.evidence.finalRecord = result.finalRecord;
    run.evidence.crashOwner.recovered = true;
    run.evidence.crashOwner.cleanupKind = mode === 'lease' ? 'fresh-process-fallback' : 'fresh-process-recovery'; recovered = true;
    await run.save(); return result;
  };
  try {
    quiescent = false; run.evidence.crashOwner.controllerQuiescent = false; await run.save();
    child = startController({ script, configuration: startPath, mode, cwd: context.config.consumer, env: process.env,
      timeoutMs: limits.scenarioMs, maxOutputBytes: limits.maxOutputBytes, signal: context.signal, onControl: () => run.save() });
    run.evidence.controllerSignals = child.controls; run.evidence.controllerPid = child.pid; await run.save();
    const readyMessage = await child.ready(limits.startupMs + limits.requestMs * 2);
    assert.equal(readyMessage.challenge, config.challenge);
    const ready = JSON.parse((await readFile(readyPath)).toString('utf8')); assert.equal(ready.pid, child.pid);
    assert.equal(ready.challenge, config.challenge); assert.equal(ready.ownerState.kind, 'ready');
    checkpointBytes = await readFile(originalPath); original = JSON.parse(checkpointBytes.toString('utf8'));
    assert.deepEqual(ready.record, original);
    const before = await census(context.engine, original, 'before-controller-cut');
    assert(before.every(({ httpStatus }) => httpStatus === 200));
    for (const role of ['compute', 'filesystem']) assert.equal(before.find((entry) => entry.role === role).state.Running, true);
    run.evidence.crashOwner.originalSha256 = sha(checkpointBytes);
    run.evidence.observations.push({ kind: 'durable-original-controller-readiness', ready, before }); await run.save();
    if (mode === 'start') {
      run.evidence.fault = { kind: 'SIGKILL-original-owned-controller-group', pid: child.pid, ready, before }; await run.save();
      const killed = await child.kill(); quiescent = true; run.evidence.crashOwner.controllerQuiescent = true;
      assert.equal(killed.code, null); assert.equal(killed.signal, 'SIGKILL'); assert.equal(killed.groupQuiescent, true);
      run.evidence.observations.push({ kind: 'actual-controller-sigkill-and-group-join', killed }); await run.save();
      const compute = original.resources.find(({ role }) => role === 'compute');
      const faultEntered = proxy.arm({ kind: 'drop-response', method: 'DELETE',
        target: `/v1.52/containers/${compute.identity.id}?force=true&v=false` });
      await recover(true); await faultEntered;
      assert.deepEqual(await readFile(originalPath), checkpointBytes, 'Original trusted checkpoint must remain byte-for-byte intact.');
      run.evidence.observations.push({ kind: 'independent-original-resource-absence', census: await census(context.engine, original, 'fresh-cleanup-final', true) });
      const absentPath = join(run.directory, 'absent.json'); const absentResult = join(run.directory, 'absent-result.json');
      await jsonWriter(absentPath)({ ...config, resultPath: absentResult });
      const execution = await runOwnedCommand({ command: process.execPath, args: [script, 'absent', absentPath], env: process.env,
        cwd: context.config.consumer, timeoutMs: limits.cleanupMs + limits.requestMs, maxOutputBytes: limits.maxOutputBytes,
        terminationGraceMs: limits.cleanupMs });
      const result = JSON.parse((await readFile(absentResult)).toString('utf8'));
      assert.equal(result.status, 'passed'); assert.equal(result.reconciliation, 'absent');
      assert.deepEqual(await readFile(originalPath), checkpointBytes);
      run.evidence.observations.push({ kind: 'another-fresh-process-reuses-original-checkpoint-as-absent', execution, result });
    } else {
      assert.equal(typeof ready.resumeListenerInstalledAt, 'string');
      const resumed = await expireWhilePaused(run, context, child, original, wire, prohibited); resumedAt = resumed.enteredAt;
      const execution = await child.join(); quiescent = true; run.evidence.crashOwner.controllerQuiescent = true;
      const result = JSON.parse((await readFile(config.resultPath)).toString('utf8'));
      run.evidence.observations.push({ kind: 'same-original-controller-fenced-exported-and-destroyed', execution, result,
        attachment: wire.snapshot() }); await run.save();
      assert.equal(execution.code, 0); assert.equal(execution.signal, null); assert.equal(execution.groupQuiescent, true);
      assert.equal(result.status, 'passed'); assert.equal(result.mode, 'lease'); assert.equal(result.pid, child.pid);
      assert.equal(result.challenge, config.challenge); assert.equal(result.cleanupKind, 'original-controller');
      assert.deepEqual(result.cleanupErrors, []); assert.equal(result.fence.sourceEntered, 0);
      assert.equal(result.fence.mutationFailure.name, 'SandboxStateError');
      assert.equal(result.export.bytesBase64, 'AP8h'); assert.equal(result.export.sha256, sha(Uint8Array.of(0, 255, 33)));
      assert.equal(result.finalRecord.phase, 'destroyed');
      assert(result.cleanupObservations.some(({ operation, status }) => operation === 'stop' && status === 'fulfilled'));
      assert(result.cleanupObservations.some(({ operation, status }) => operation === 'destroy' && status === 'fulfilled'));
      run.evidence.finalRecord = result.finalRecord; recovered = true;
      run.evidence.crashOwner.recovered = true; run.evidence.crashOwner.cleanupKind = 'original-controller';
      assert.deepEqual(await readFile(originalPath), checkpointBytes);
      run.evidence.observations.push({ kind: 'independent-original-resource-absence', census: await census(context.engine, original, 'same-controller-final', true) });
      await run.save();
    }
  } catch (error) { primary = error; }
  finally {
    if (!quiescent && child) {
      try { run.evidence.observations.push({ kind: 'controller-final-group-join', result: await child.kill() }); quiescent = true; }
      catch (error) { quiescent = error.quiescent === true; run.evidence.cleanupErrors.push(failure(error)); }
    }
    run.evidence.crashOwner.controllerQuiescent = quiescent;
    if (quiescent && !recovered) {
      try { await readFile(originalPath); await recover(false); }
      catch (error) { run.evidence.cleanupErrors.push({ originalPath, recoveryPath, ...failure(error) }); }
    }
    await run.save();
  }
  run.afterCleanup.push(async () => {
    const entries = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.filter(({ method, target }) => method === 'POST' && /^\/v1\.52\/containers\/create\?/u.test(target)).length, 3,
      'Only original compute/filesystem/export acquisition may create containers; reconciliation cannot recreate a helper.');
    if (mode === 'start') assert.equal(entries.filter(({ fault }) => fault === 'drop-response').length, 1);
    else if (!primary) {
      assert.equal(run.evidence.crashOwner.cleanupKind, 'original-controller');
      assert.deepEqual(child.controls.map(({ signal }) => signal), ['SIGSTOP', 'SIGCONT']);
      assert.equal(entries.filter(({ method, target, startedAt }) => destructive(method, target) && startedAt < resumedAt).length, 0);
      const attachment = wire.snapshot();
      for (const operation of [5, 6, 7]) assert.equal(attachment.commandCounts[operation], 1);
      assert.equal(attachment.pendingCommandBytes, 0);
      run.evidence.observations.push({ kind: 'lease-expiry-has-no-native-mutation-replay-or-premature-cleanup', resumedAt,
        commandCounts: attachment.commandCounts, destructiveRequests: prohibited }); await run.save();
    }
  });
  if (primary) throw primary;
}

export function crashCases(context) {
  return [
    ['controller-death-original-checkpoint-fresh-cleanup-retry', (run) => controllerCase(run, context, 'start')],
    ['paused-controller-native-filesystem-lease-expiry', (run) => controllerCase(run, context, 'lease')],
  ];
}
