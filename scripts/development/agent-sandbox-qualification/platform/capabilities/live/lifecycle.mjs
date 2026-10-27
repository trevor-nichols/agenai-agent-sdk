import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxCleanupError, SandboxStateError } from '@agen-ai/sandbox';
import { until } from '../../../engine.mjs';
import { entered, failure } from './evidence.mjs';
import { guest, send } from './installed.mjs';
import { readObserved, sha } from './operations.mjs';
import { sentinel } from './sentinel.mjs';

async function exportFile(sandbox, path) {
  const chunks = []; const paths = [];
  const summary = await sandbox.exportTree({ kind: 'files', paths: [path] }, async (entry) => {
    paths.push(entry.path); assert.equal(entry.kind, 'file');
    for await (const chunk of entry.bytes) { chunks.push(Buffer.from(chunk)); assert(chunks.length <= 32); }
  });
  return { paths, summary, bytes: Buffer.concat(chunks) };
}

export function lifecycleCases(context) {
  const cases = [];
  for (const operation of ['list', 'read', 'write']) cases.push([`stop-joins-entered-${operation}`, async (run) => {
    const stopObservationMs = Math.min(2000, context.config.capabilities.limits.cleanupMs);
    const { owner, sandbox, files, session, entry } = await guest(run, context, { cleanupMs: stopObservationMs });
    const outside = await sentinel(run, context, owner);
    await send(session, { kind: 'write', path: 'existing.bin', base64: 'AQID' });
    const ready = Promise.withResolvers(); const release = Promise.withResolvers(); let callbacksJoined = 0;
    let active;
    if (operation === 'list') {
      await send(session, { kind: 'listing', path: 'held-list', entries: 2 });
      active = files.list('held-list', async () => { try { ready.resolve(); await release.promise; } finally { callbacksJoined++; } });
    } else if (operation === 'read') active = files.readFile('existing.bin', async ({ chunks }) => {
      const iterator = chunks[Symbol.asyncIterator](); assert.equal((await iterator.next()).done, false);
      try { ready.resolve(); await release.promise; } finally { callbacksJoined++; }
    });
    else active = files.writeFile('unpublished.bin', { async *[Symbol.asyncIterator]() {
      try { yield Uint8Array.of(7); ready.resolve(); await release.promise; yield Uint8Array.of(8); }
      finally { callbacksJoined++; }
    } }, { mode: 'create' });
    void active.catch(() => {});
    let expectedFailure; let initialStopStartedAt; let timeoutObservedAt;
    try {
      await entered(ready, active, context.config.capabilities.limits.requestMs);
      if (operation === 'write') assert.equal((await outside.inspect()).stage.length, 1);
      initialStopStartedAt = new Date().toISOString();
      const stopping = owner.stop(); assert.throws(() => files.stat('.'), SandboxStateError);
      try { await stopping; } catch (error) { expectedFailure = error; timeoutObservedAt = new Date().toISOString(); }
      assert(expectedFailure instanceof SandboxCleanupError); assert.equal(expectedFailure.owner, owner);
      assert.equal(expectedFailure.operation, 'stop'); assert.equal(expectedFailure.cause?.code, 'deadline_exceeded');
      assert.equal(callbacksJoined, 0);
      assert.throws(() => sandbox.exportTree({ kind: 'workspace' }, async () => {}), SandboxStateError);
      run.evidence.observations.push({ kind: 'cleanup-ownership-retained-until-entered-callback-joins', operation,
        initialStopStartedAt, timeoutObservedAt, stopObservationMs, callbacksJoinedBeforeRelease: callbacksJoined, failure: failure(expectedFailure) });
      await run.save();
      for (const role of ['compute', 'filesystem']) {
        const resource = owner.recoveryRecord.resources.find((entry) => entry.role === role);
        await until(async () => {
          const actual = await context.engine.request('GET', `/containers/${resource.identity.id}/json`, undefined, { allowed: [200, 404] });
          return actual.status === 404 || actual.data.State.Running === false;
        }, context.config.capabilities.limits.cleanupMs, 'Physical shutdown did not settle while its callback remained retained.');
      }
    } finally {
      const releaseRequestedAt = new Date().toISOString(); release.resolve();
      run.evidence.observations.push({ kind: 'held-file-callback-release-requested', operation, releaseRequestedAt,
        callbacksJoinedAtReleaseRequest: callbacksJoined });
      await run.save();
    }
    const receipt = await active;
    run.evidence.observations.push({ kind: 'entered-file-settlement-after-release', operation,
      observedAt: new Date().toISOString(), receipt }); await run.save();
    assert.equal(receipt.kind, 'cancelled');
    if (operation === 'write') { assert.equal(receipt.effect, 'unknown'); assert.equal(receipt.bytes, null); }
    await run.settleCleanup(entry, 'stop');
    const joinedObservedAt = new Date().toISOString();
    assert.equal(owner.state.kind, 'stopped'); assert.equal(callbacksJoined, 1);
    run.evidence.observations.push({ kind: 'released-file-callback-and-stop-joined', operation, joinedObservedAt,
      callbacksJoined, ownerState: owner.state }); await run.save();
    assert.deepEqual((await outside.inspect()).stage, []);
    const exported = await exportFile(sandbox, 'existing.bin');
    assert.deepEqual(exported.paths, ['existing.bin']); assert.deepEqual(exported.bytes, Buffer.from([1, 2, 3]));
    const names = [];
    await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
      names.push(entry.path); if (entry.kind === 'file') for await (const _chunk of entry.bytes) { /* Drain the owned export. */ }
    });
    assert(!names.includes('unpublished.bin')); assert(!names.includes('sentinel')); assert(!names.includes('stage'));
    run.evidence.observations.push({ kind: 'stop-retry-joins-writers-before-final-export', operation, receipt, callbacksJoined, joinedObservedAt,
      paths: exported.paths, sha256: sha(exported.bytes), names });
  }]);
  cases.push(['caller-aborts-entered-read', async (run) => {
    const { owner, files, session } = await guest(run, context);
    await send(session, { kind: 'write', path: 'read.bin', length: 131085, fill: 7 });
    const abort = new AbortController(); let delivered = 0;
    const result = await files.readFile('read.bin', async ({ chunks }) => {
      for await (const chunk of chunks) { delivered += chunk.byteLength; abort.abort(); break; }
    }, { signal: abort.signal });
    assert.deepEqual(result, { kind: 'cancelled', reason: 'signal', bytes: 65536n }); assert.equal(delivered, 65536);
    assert.throws(() => files.stat('.'), SandboxStateError);
    await owner.stop(); run.evidence.observations.push({ kind: 'native-read-aborted-after-byte-delivery', result, delivered });
  }]);
  cases.push(['caller-aborts-entered-write-source', async (run) => {
    const { owner, sandbox, files } = await guest(run, context);
    const ready = Promise.withResolvers(); const release = Promise.withResolvers(); const abort = new AbortController(); let sourceJoined = 0;
    const writing = files.writeFile('interrupted.bin', { async *[Symbol.asyncIterator]() {
      try { yield Uint8Array.of(1); ready.resolve(); await release.promise; yield Uint8Array.of(2); }
      finally { sourceJoined++; }
    } }, { mode: 'create', signal: abort.signal });
    void writing.catch(() => {});
    let result;
    try {
      await entered(ready, writing, context.config.capabilities.limits.requestMs); abort.abort();
      result = await writing; assert.deepEqual(result, { kind: 'cancelled', reason: 'signal', effect: 'unknown', bytes: null });
      assert.equal(sourceJoined, 0); assert.throws(() => files.writeFile('retry.bin', [], { mode: 'create' }), SandboxStateError);
      assert.throws(() => sandbox.exportTree({ kind: 'workspace' }, async () => {}), SandboxStateError);
    } finally { release.resolve(); }
    await owner.stop(); assert.equal(sourceJoined, 1);
    const paths = [];
    await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
      paths.push(entry.path); if (entry.kind === 'file') for await (const _chunk of entry.bytes) { /* Drain the owned export. */ }
    });
    assert(!paths.includes('interrupted.bin')); assert(!paths.includes('retry.bin'));
    run.evidence.observations.push({ kind: 'native-write-abort-has-unknown-byte-ack-and-joined-source', result, sourceJoined, paths });
  }]);
  cases.push(['actual-filesystem-control-connection-loss', async (run) => {
    const { owner, files, session } = await guest(run, context);
    await send(session, { kind: 'write', path: 'before-loss.bin', base64: 'AQ==' });
    const helper = owner.recoveryRecord.resources.find(({ role }) => role === 'filesystem');
    assert.equal(helper.identity.kind, 'identified');
    run.evidence.fault = { kind: 'kill-owned-filesystem-helper', id: helper.identity.id, signal: 'KILL', record: owner.recoveryRecord };
    await run.save();
    await context.engine.request('POST', `/containers/${helper.identity.id}/kill?signal=KILL`);
    await until(() => owner.state.kind !== 'ready', context.config.capabilities.limits.requestMs, 'Actual helper loss did not fence the owner.');
    assert.throws(() => files.stat('.'), SandboxStateError);
    const actual = await context.engine.request('GET', `/containers/${helper.identity.id}/json`, undefined, { allowed: [200, 404] });
    if (actual.status === 200) assert.equal(actual.data.State.Running, false);
    await owner.stop(); run.evidence.observations.push({ kind: 'actual-helper-control-loss-fences-live-admission',
      id: helper.identity.id, httpStatus: actual.status, state: actual.data?.State });
  }]);
  cases.push(['healthy-read-and-write-backpressure-survives-control-lease', async (run) => {
    const { owner, files, session } = await guest(run, context);
    const control = context.config.capabilities.filesystem.configuration.control;
    const holdMs = control.leaseTimeoutMs + 2 * control.heartbeatMs;
    const helper = owner.recoveryRecord.resources.find(({ role }) => role === 'filesystem');
    assert.equal(helper.identity.kind, 'identified');
    let originalHelper;
    const inspectHelper = async (checkpoint) => {
      const actual = await context.engine.request('GET', `/containers/${helper.identity.id}/json`);
      const observation = { checkpoint, observedAt: new Date().toISOString(), id: actual.data.Id,
        image: actual.data.Image, state: actual.data.State, ownerState: owner.state };
      run.evidence.observations.push({ kind: 'healthy-control-same-helper', ...observation }); await run.save();
      assert.equal(actual.data.Id, helper.identity.id); assert.equal(actual.data.State.Running, true);
      assert.equal(actual.data.Image, context.config.capabilities.filesystem.configuration.imageDigest);
      assert.equal(actual.data.State.Restarting, false); assert.equal(actual.data.RestartCount, 0);
      const identity = { id: actual.data.Id, pid: actual.data.State.Pid, startedAt: actual.data.State.StartedAt };
      if (originalHelper) assert.deepEqual(identity, originalHelper);
      else { assert(identity.pid > 0); originalHelper = identity; }
      assert.deepEqual(owner.recoveryRecord.resources.find(({ role }) => role === 'filesystem'), helper);
      assert.equal(owner.state.kind, 'ready');
      return observation;
    };
    await inspectHelper('before-held-read');
    const expected = await send(session, { kind: 'write', path: 'lease-read.bin', length: 131085, fill: 47, permissions: 0o751 });
    const hold = async (operation, joined) => {
      const observation = { kind: 'healthy-backpressure-hold', operation, control, holdMs,
        enteredAt: new Date().toISOString(), startedMonotonicMs: performance.now(), status: 'entered' };
      run.evidence.observations.push(observation); await run.save();
      const holdDeadline = observation.startedMonotonicMs + holdMs;
      while (performance.now() < holdDeadline) {
        await delay(Math.ceil(holdDeadline - performance.now()), undefined, { signal: context.signal });
      }
      observation.holdCompletedAt = new Date().toISOString();
      observation.heldMs = performance.now() - observation.startedMonotonicMs;
      observation.joinedBeforeRelease = joined(); observation.status = 'release-ready'; await run.save();
      assert(observation.heldMs >= holdMs); assert.equal(observation.joinedBeforeRelease, 0);
      await inspectHelper(`after-held-${operation}`);
    };
    let readJoined = 0;
    const read = await readObserved(files, 'lease-read.bin', async ({ chunks }) => {
      if (chunks === 1) await hold('read', () => readJoined);
    }).finally(() => { readJoined++; });
    assert.deepEqual(read.result, { kind: 'completed', bytes: 131085n });
    assert.equal(read.sha256, expected.sha256); assert.equal(readJoined, 1); assert(read.chunks > 1);
    const readStat = await files.stat('lease-read.bin');
    assert.equal(readStat.kind, 'completed'); assert.equal(readStat.entry.permissions, 0o751);
    const payload = Uint8Array.of(0, 255, 17, 9); let sourceJoined = 0;
    const write = await files.writeFile('lease-write.bin', { async *[Symbol.asyncIterator]() {
      try {
        yield payload.subarray(0, 2);
        await hold('write-source', () => sourceJoined);
        yield payload.subarray(2);
      } finally { sourceJoined++; }
    } }, { mode: 'create' });
    assert.deepEqual(write, { kind: 'completed', effect: 'published', bytes: 4n, permissions: 0o644 });
    assert.equal(sourceJoined, 1);
    const written = await readObserved(files, 'lease-write.bin');
    assert.deepEqual(written.result, { kind: 'completed', bytes: 4n }); assert.equal(written.sha256, sha(payload));
    const writeStat = await files.stat('lease-write.bin');
    assert.equal(writeStat.kind, 'completed'); assert.equal(writeStat.entry.permissions, 0o644);
    const later = await files.writeFile('lease-write.bin', [Uint8Array.of(8, 7)], { mode: 'replace' });
    assert.deepEqual(later, { kind: 'completed', effect: 'published', bytes: 2n, permissions: 0o644 });
    const laterRead = await readObserved(files, 'lease-write.bin');
    assert.deepEqual(laterRead.result, { kind: 'completed', bytes: 2n }); assert.equal(laterRead.sha256, sha(Uint8Array.of(8, 7)));
    await inspectHelper('after-confirmed-later-mutation');
    run.evidence.observations.push({ kind: 'healthy-native-control-survives-output-and-input-backpressure', helperId: helper.identity.id,
      originalHelper, control, holdMs, read, readStat, readJoined, write, written, writeStat, sourceJoined, later, laterRead });
    await run.save();
  }]);
  return cases;
}
