import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guest, send } from './installed.mjs';
import { readObserved, sha } from './operations.mjs';
import { sentinel } from './sentinel.mjs';

export function confinementCases(context) {
  return [
    ['nofollow-private-stage-sibling-host-and-other-workspace', async (run) => {
      const other = await guest(run, context);
      const foreign = Buffer.from('separate-workspace-sentinel');
      await send(other.session, { kind: 'write', path: 'foreign.bin', base64: foreign.toString('base64') });
      const current = await guest(run, context);
      const outside = await sentinel(run, context, current.owner);
      const ownStorage = current.owner.recoveryRecord.resources.find(({ role }) => role === 'storage');
      const otherStorage = other.owner.recoveryRecord.resources.find(({ role }) => role === 'storage');
      assert.notEqual(ownStorage.identity.id, otherStorage.identity.id);
      const hostPath = join(run.directory, 'host-sentinel.bin'); const hostBytes = Buffer.from('caller-host-sentinel-preserved');
      await writeFile(hostPath, hostBytes, { flag: 'wx', mode: 0o600 });
      const attempts = [
        ['outside-file', '/store/sentinel', 'outside-file'],
        ['stage-link', '/store/stage', 'stage-link/forbidden'],
        ['sibling-link', '/store/sibling', 'sibling-link/sentinel'],
        ['host-link', hostPath, 'host-link'],
        ['foreign-link', `${other.sandbox.workspace}/foreign.bin`, 'foreign-link'],
        ['magic-link', '/proc/self/fd/0', 'magic-link'],
      ];
      const observations = [];
      for (const [link, target, path] of attempts) {
        await send(current.session, { kind: 'symlink', path: link, target });
        const nativeStat = await send(current.session, { kind: 'stat', path: link }); assert.equal(nativeStat.kind, 'symlink');
        const stat = await current.files.stat(link); assert.equal(stat.kind, 'completed'); assert.equal(stat.entry.kind, 'symlink');
        let delivered = 0;
        const read = await current.files.readFile(path, async ({ chunks }) => { for await (const chunk of chunks) delivered += chunk.byteLength; });
        assert.equal(read.kind, 'rejected'); assert.equal(read.bytes, 0n); assert.equal(delivered, 0);
        const write = await current.files.writeFile(path, [Uint8Array.of(99)], { mode: 'replace' });
        assert.equal(write.kind, 'rejected'); assert.equal(write.effect, 'none'); assert.equal(write.bytes, 0n);
        observations.push({ target, path, nativeStat, stat, read, write, delivered });
      }
      const listed = [];
      const stage = await current.files.list('stage-link', async (entry) => { listed.push(entry); });
      assert.equal(stage.kind, 'rejected'); assert.equal(stage.entries, 0n); assert.deepEqual(listed, []);
      assert.deepEqual(await readFile(hostPath), hostBytes);
      const after = await outside.inspect(); assert.equal(after.marker, outside.marker); assert.deepEqual(after.stage, []);
      const foreignAfter = await readObserved(other.files, 'foreign.bin'); assert.equal(foreignAfter.result.kind, 'completed'); assert.equal(foreignAfter.sha256, sha(foreign));
      run.evidence.observations.push({ kind: 'native-nofollow-attempts-with-independent-sentinels', observations, stage, after,
        host: { path: hostPath, beforeSha256: sha(hostBytes), afterSha256: sha(await readFile(hostPath)), hostBindGranted: false },
        distinctStorage: [ownStorage.identity, otherStorage.identity], foreignAfter });
    }],
    ['running-ancestor-symlink-name-races', async (run) => {
      const { owner, files, session } = await guest(run, context);
      const outside = await sentinel(run, context, owner);
      const insideBytes = Buffer.from('inside-workspace-marker');
      await send(session, { kind: 'write', path: 'pivot/sentinel', base64: insideBytes.toString('base64') });
      const baseline = await readObserved(files, 'pivot/sentinel'); assert.equal(baseline.result.kind, 'completed'); assert.equal(baseline.sha256, sha(insideBytes));
      const started = await send(session, { kind: 'swap-start', path: 'pivot', target: '/store' });
      assert(started.iterations >= 64); assert.deepEqual(started.failures, []);
      const counts = {}; const reads = []; const writes = []; let stopped; let during; let sourceEntered = false;
      try {
        for (let index = 0; index < 64; index++) {
          const read = await readObserved(files, 'pivot/sentinel');
          assert(['completed', 'changed', 'missing', 'rejected'].includes(read.result.kind));
          if (read.bytes > 0n) assert.equal(read.sha256, sha(insideBytes));
          counts[read.result.kind] = (counts[read.result.kind] ?? 0) + 1; reads.push(read);
        }
        for (let index = 0; index < 64 && !sourceEntered; index++) {
          const write = await files.writeFile('pivot/new.bin', { async *[Symbol.asyncIterator]() {
            sourceEntered = true; yield Uint8Array.of(41, 42);
            during = await send(session, { kind: 'swap-state' });
            stopped = await send(session, { kind: 'swap-stop' });
            yield Uint8Array.of(43);
          } }, { mode: 'create' });
          writes.push(write); assert(['completed', 'changed', 'missing', 'rejected'].includes(write.kind));
          if (sourceEntered) { assert.equal(write.effect, 'published'); assert.equal(write.bytes, 3n); }
          else assert.equal(write.effect, 'none');
        }
        assert(sourceEntered, 'The race must admit an actual native staged mutation as well as denials.');
      } finally {
        if (!stopped && owner.state.kind === 'ready') stopped = await send(session, { kind: 'swap-stop' });
      }
      assert(stopped, 'The owned swap loop must be joined.');
      assert(stopped.iterations > started.iterations); assert.deepEqual(stopped.failures, []);
      assert(Object.keys(counts).some((kind) => kind !== 'completed'), 'The requests never observed an adversarial name state.');
      assert.equal((await outside.inspect()).marker, outside.marker);
      run.evidence.observations.push({ kind: 'actual-concurrent-ancestor-and-name-races', started, during, stopped, counts, reads, writes, sourceEntered });
    }],
    ['mount-crossing-fixture-admission-is-disclosed', async (run) => {
      const { owner, session } = await guest(run, context);
      await send(session, { kind: 'mkdir', path: 'mount-source' }); await send(session, { kind: 'mkdir', path: 'mount-target' });
      const attempt = await send(session, { kind: 'mount-bind', timeoutMs: Math.min(5000, context.config.capabilities.limits.requestMs - 250) });
      run.evidence.observations.push({ kind: 'entered-native-mount-bind', attempt }); await run.save();
      assert.equal(attempt.childJoined, true); assert.equal(attempt.timedOut, false); assert.equal(attempt.outputLimit, false);
      if (attempt.spawnError) assert.equal(attempt.spawnError.code, 'ENOENT', 'Unexpected native fixture launch failure cannot qualify mount denial.');
      else {
        assert.equal(attempt.signal, null); assert(Number.isInteger(attempt.code) && attempt.code > 0,
          'A successful mount requires a qualified crossing scenario.');
      }
      const compute = owner.recoveryRecord.resources.find(({ role }) => role === 'compute');
      const actual = (await context.engine.request('GET', `/containers/${compute.identity.id}/json`)).data;
      assert.deepEqual(actual.HostConfig.CapDrop, ['ALL']); assert.equal(actual.HostConfig.Privileged, false);
      run.evidence.observations.push({ kind: 'mount-crossing', status: 'unsupported_fixture',
        reason: attempt.spawnError
          ? 'The fixed mount executable is absent from this workload image; no crossing mechanism is claimed.'
          : 'The unprivileged native bind-mount attempt failed under the admitted workload policy; no crossing mechanism is claimed.',
        attempt, capDrop: actual.HostConfig.CapDrop, privileged: actual.HostConfig.Privileged });
    }],
  ];
}
