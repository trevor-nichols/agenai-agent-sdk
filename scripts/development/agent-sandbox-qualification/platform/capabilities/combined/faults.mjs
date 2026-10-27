import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { PublicationGate } from '../../../capabilities/live/publicationGate.mjs';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { startController } from '../live/controller-process.mjs';
import { entered, failure, json, jsonWriter } from '../live/evidence.mjs';
import { census, identified } from '../network/resources.mjs';
import { sha } from '../network/fixtures.mjs';
import { acquireCaseHost } from '../preserve/host-roots.mjs';
import { combinedFaults } from './budget.mjs';
import { workflow } from './installed.mjs';
import { observeWorkflow } from './scenarios.mjs';

const childScript = fileURLToPath(new URL('./controller-child.mjs', import.meta.url));
const replay = ({ method, target }) => method === 'PUT' || method === 'POST'
  && (/\/containers\/create\?/u.test(target) || /\/(?:start|exec)(?:\?|$)/u.test(target)
    || /\/(?:volumes|networks)\/create$/u.test(target));

async function crash(run, context, cut) {
  await acquireCaseHost(run, { hostRoot: context.hostRoots[0], layout: 'private' });
  const originalPath = join(run.directory, 'original-checkpoint.json');
  const ownerDirectory = join(run.directory, 'child-owner');
  const scratchDirectory = join(run.hostDirectory, 'child-workspace');
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  let wireCut = false, original, originalBytes, child, latestTrustedCheckpoint, complete = false, recovering = false;
  const wireWitness = async (witness) => {
    assert.equal(wireCut, false); wireCut = true;
    await run.observe({ kind: 'combined-native-wire-cut-entered', cut, witness }); reached.resolve(witness);
    await release.promise;
  };
  const gate = new PublicationGate(() => { throw new Error('Filesystem-init witness cannot withhold a publication.'); },
    async (witness) => { await wireWitness(witness); });
  const proxy = await createTraceProxy({ socketPath: join(run.directory, 'e.sock'), upstreamEndpoint: context.config.endpoint,
    tracePath: join(run.directory, 'trace.jsonl'),
    async observeResponse({ method, target, status }) {
      if (cut === 'resource-create-acknowledgement' && method === 'POST' && target === '/v1.52/volumes/create' && status === 201 && !wireCut) {
        await wireWitness({ method, target, status, nativeEffect: 'Original storage creation returned success before acknowledgement forwarding.' });
      }
      if (cut === 'cleanup-entered' && method === 'DELETE' && status === 204 && !wireCut) {
        const record = JSON.parse(await readFile(join(ownerDirectory, 'recovery.json'), 'utf8'));
        const exported = record.resources.find(({ role }) => role === 'export');
        if (exported?.identity.kind === 'identified' && target === `/v1.52/containers/${exported.identity.id}?force=true&v=false`) {
          await wireWitness({ method, target, status, record,
            nativeEffect: 'Original export deletion succeeded with its acknowledgement held before storage/socket/network cleanup.' });
        }
      }
    },
    observeUpgrade({ target, status }) {
      if (cut !== 'filesystem-initialization') return;
      assert.equal(status, 101);
      const selected = async () => {
        const record = JSON.parse(await readFile(join(ownerDirectory, 'recovery.json'), 'utf8'));
        const filesystem = record.resources.find(({ role }) => role === 'filesystem');
        return filesystem?.identity.kind === 'identified' && target.startsWith(`/v1.52/containers/${filesystem.identity.id}/attach?`);
      };
      return { async input(chunk) { if (await selected()) gate.observeInput(chunk); },
        async response(chunk, forward) { return await selected() ? gate.observe(chunk, forward) : forward(chunk); } };
    } });
  proxy.setRow('combined'); run.proxies.push(proxy);
  const namespace = `${context.config.namespacePrefix}${randomUUID()}`;
  const configuration = { ...context.config, endpoint: proxy.endpoint, output: join(run.directory, 'child'),
    child: { mode: 'crash', cut, namespace, challenge: randomUUID(), originalPath, ownerDirectory, scratchDirectory,
      target: context.fixtures.targets().host, resultPath: join(run.directory, 'child-result.json') } };
  const path = join(run.directory, 'child-config.json'); await jsonWriter(path)(configuration);
  run.evidence.childOwner = { namespace, challenge: configuration.child.challenge, originalPath, ownerDirectory, scratchDirectory,
    quiescent: false, cleanupKind: null, originalReservationConfirmed: false };
  await run.save();
  const recover = async (name, checkpoint = { path: originalPath, bytes: originalBytes, record: original,
    provenance: { kind: 'original-controller-durable-checkpoint' } }) => {
    recovering = true;
    const recoveryConfig = { ...configuration, child: { ...configuration.child, mode: 'cleanup',
      originalPath: checkpoint.path,
      resultPath: join(run.directory, `${name}-result.json`) } };
    const recoveryPath = join(run.directory, `${name}.json`); await jsonWriter(recoveryPath)(recoveryConfig);
    await run.observe({ kind: 'combined-fresh-process-recovery-entered', name,
      originalSha256: sha(originalBytes), checkpoint: { path: checkpoint.path, sha256: sha(checkpoint.bytes),
        phase: checkpoint.record.phase, provenance: checkpoint.provenance }, namespace });
    const controller = startController({ script: childScript, configuration: recoveryPath, cwd: context.config.consumer,
      env: process.env, timeoutMs: context.config.capabilities.limits.cleanupMs * 3 + context.config.capabilities.limits.requestMs,
      maxOutputBytes: context.config.capabilities.limits.maxOutputBytes, signal: context.signal,
      onControl: (observation) => run.observe({ kind: 'combined-fresh-recovery-process-control', name, observation }) });
    const exit = await controller.join(); const result = JSON.parse(await readFile(recoveryConfig.child.resultPath, 'utf8'));
    await run.observe({ kind: 'combined-fresh-process-recovery-settled', name, exit, result });
    assert.equal(exit.code, 0); assert.equal(result.status, 'passed'); assert.equal(result.pid, controller.pid);
    assert.equal(result.challenge, configuration.child.challenge);
    assert.equal(result.cleanupKind, 'fresh-process-cleanup-only');
    assert.deepEqual(await readFile(originalPath), originalBytes, 'Original trusted record bytes changed during recovery.');
    assert.deepEqual(await readFile(checkpoint.path), checkpoint.bytes, 'Selected trusted checkpoint bytes changed during recovery.');
    return result;
  };
  try {
    child = startController({ script: childScript, configuration: path, cwd: context.config.consumer, env: process.env,
      timeoutMs: context.config.capabilities.limits.scenarioMs, maxOutputBytes: context.config.capabilities.limits.maxOutputBytes,
      signal: context.signal, onControl: (observation) => run.observe({ kind: 'original-combined-child-process-control', observation }) });
    if (['resource-create-acknowledgement', 'filesystem-initialization', 'cleanup-entered'].includes(cut)) {
      await entered(reached, child.join(), context.config.capabilities.limits.startupMs + 2 * context.config.capabilities.limits.requestMs);
      originalBytes = await readFile(join(ownerDirectory, 'recovery.json'));
      await writeFile(originalPath, originalBytes, { flag: 'wx', mode: 0o600 });
    } else {
      const ready = await child.ready(context.config.capabilities.limits.scenarioMs);
      assert.equal(ready.challenge, configuration.child.challenge); assert.equal(ready.cut, cut);
      originalBytes = await readFile(originalPath);
    }
    original = parseSandboxRecoveryRecord(JSON.parse(originalBytes.toString('utf8')));
    assert.equal(original.namespace, namespace); assert.equal(original.authority.kind, 'verified');
    run.evidence.childOwner.originalReservationConfirmed = true;
    await run.observe({ kind: 'combined-original-controller-before-kill', cut, group: await child.snapshot(), original,
      originalSha256: sha(originalBytes), census: await census(context.engine, original, 'combined-crash-cut') });
    const killed = await child.kill(); run.evidence.childOwner.quiescent = killed.groupQuiescent;
    assert.equal(killed.signal, 'SIGKILL'); await run.observe({ kind: 'combined-original-controller-killed-and-joined', killed });
    release.resolve(); await proxy.idle();
    const first = await recover('fresh-cleanup'); assert(['matched', 'uncertain'].includes(first.reconciliation));
    assert.equal(first.finalRecord.phase, 'destroyed');
    const settled = { path: join(run.directory, 'settled-checkpoint.json'),
      bytes: Buffer.from(json(first.finalRecord)), record: parseSandboxRecoveryRecord(first.finalRecord),
      provenance: { kind: 'exact-sdk-returned-fresh-cleanup-record', sourceResultPath: join(run.directory, 'fresh-cleanup-result.json'),
        sourceResultSha256: sha(await readFile(join(run.directory, 'fresh-cleanup-result.json'))),
        pid: first.pid, challenge: first.challenge, originalSha256: sha(originalBytes) } };
    await jsonWriter(settled.path)(first.finalRecord);
    latestTrustedCheckpoint = settled;
    run.evidence.childOwner.settledCheckpoint = { path: settled.path, sha256: sha(settled.bytes), provenance: settled.provenance };
    await run.observe({ kind: 'combined-trusted-settled-checkpoint-retained', path: settled.path,
      bytes: settled.bytes.length, sha256: sha(settled.bytes), record: settled.record, provenance: settled.provenance,
      originalCreatingIdentity: original.resources.some(({ identity }) => identity.kind === 'creating'),
      semantics: 'A stale creating checkpoint remains uncertain after its named effect disappears. Duplicate fresh cleanup uses this exact SDK-returned settled record; the original is immutable.' });
    const repeated = await recover('repeat-settled-cleanup', settled); assert.equal(repeated.reconciliation, 'absent');
    run.evidence.childOwner.cleanupKind = 'fresh-process-cleanup-only'; complete = true;
    await run.observe({ kind: 'combined-independent-original-record-exact-absence',
      census: await census(context.engine, original, 'combined-crash-final', true) });
  } finally {
    if (child && !run.evidence.childOwner.quiescent) {
      try { const killed = await child.kill(); run.evidence.childOwner.quiescent = killed.groupQuiescent; }
      catch (error) { run.evidence.childOwner.quiescent = error.quiescent === true; await run.observe({ kind: 'failed-original-child-join', failure: failure(error) }); }
    }
    release.resolve();
    if (!complete && run.evidence.childOwner.quiescent) {
      try {
        if (!originalBytes) {
          originalBytes = await readFile(join(ownerDirectory, 'recovery.json'));
          original = parseSandboxRecoveryRecord(JSON.parse(originalBytes.toString('utf8')));
          try { await writeFile(originalPath, originalBytes, { flag: 'wx', mode: 0o600 }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        await proxy.idle(); await recover('failed-case-latest-trusted-cleanup', latestTrustedCheckpoint);
        run.evidence.childOwner.cleanupKind = 'failed-case-fresh-process-cleanup-only';
      } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
    }
    if (recovering) run.afterCleanup.push(async () => {
      const bytes = await readFile(proxy.tracePath); assert(bytes.length <= 8 * 1024 ** 2);
      const events = bytes.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const recoveryEntered = run.evidence.observations.find(({ kind }) => kind === 'combined-fresh-process-recovery-entered')?.observedAt;
      assert(recoveryEntered);
      const replayed = events.filter((event) => event.startedAt >= recoveryEntered && replay(event));
      assert.deepEqual(replayed, [], 'Fresh cleanup replayed creation, start, import or process dispatch.');
      await run.observe({ kind: 'combined-recovery-no-replay-trace', bytes: bytes.length, sha256: sha(bytes),
        recoveryEntered, replayed, originalSha256: originalBytes ? sha(originalBytes) : null });
    });
  }
}

export function faultCases(context) {
  return [...combinedFaults.map((cut) => [`crash-${cut}`, (run) => crash(run, context, cut)]),
    ['cleanup-acknowledgement-retry', async (run) => {
      await acquireCaseHost(run, { hostRoot: context.hostRoots[0], layout: 'private' });
      const proxy = await createTraceProxy({ socketPath: join(run.directory, 'e.sock'), upstreamEndpoint: context.config.endpoint,
        tracePath: join(run.directory, 'trace.jsonl') });
      proxy.setRow('combined'); run.proxies.push(proxy); let armed;
      let caught;
      try {
        await workflow(run, context, { endpoint: proxy.endpoint,
          async onObservation(observation, entry) {
            await observeWorkflow(run, context, observation, entry);
            if (observation.phase === 'exported') {
              const volume = identified(entry.owner.recoveryRecord, 'storage');
              armed = proxy.arm({ kind: 'drop-response', method: 'DELETE', target: `/v1.52/volumes/${encodeURIComponent(volume.identity.id)}` });
            }
          } });
      } catch (error) { caught = error; }
      assert(caught, 'The withheld original DELETE acknowledgement unexpectedly passed.');
      assert(armed); await armed; const entry = run.owners[0];
      assert.equal(caught.owner.id, entry.owner.id);
      await run.observe({ kind: 'combined-original-cleanup-acknowledgement-loss', failure: failure(caught),
        retainedState: entry.owner.state, record: entry.owner.recoveryRecord });
      await run.settleCleanup(entry, 'destroy'); await run.settleCleanup(entry, 'destroy');
      assert.equal(entry.owner.state.kind, 'destroyed');
      run.afterCleanup.push(async () => {
        const bytes = await readFile(proxy.tracePath); const events = bytes.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(events.filter(({ fault }) => fault === 'drop-response').length, 1);
        const lost = events.find(({ fault }) => fault === 'drop-response');
        assert.deepEqual(events.filter((event) => event.startedAt > lost.startedAt && replay(event)), []);
        await run.observe({ kind: 'combined-same-cleanup-owner-retry-no-replay', traceSha256: sha(bytes),
          traceBytes: bytes.length, namespace: entry.namespace, finalRecord: entry.owner.recoveryRecord });
      });
    }],
  ];
}
