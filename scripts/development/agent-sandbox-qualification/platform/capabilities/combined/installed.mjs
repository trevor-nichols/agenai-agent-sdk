import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backend, request } from '../network/installed.mjs';
import { jsonWriter } from '../live/evidence.mjs';

export async function loadExample(config) {
  assert.equal(config.entrypoint.path, join(config.consumer, 'platform-dist/examples/sandbox/combined/index.js'));
  assert.deepEqual(config.entrypoint.modules.map(({ path }) => path), ['index', 'workflow', 'program', 'session']
    .map((name) => join(config.consumer, 'platform-dist/examples/sandbox/combined', `${name}.js`)));
  for (const module of config.entrypoint.modules) {
    const bytes = await readFile(module.path);
    assert.equal(bytes.byteLength, module.byteLength);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), module.sha256,
      'The installed public combined program/workflow/session changed after launcher capture.');
  }
  return import(pathToFileURL(config.entrypoint.path).href);
}

export async function workflow(run, context, options = {}) {
  const namespace = options.namespace ?? `${context.config.namespacePrefix}${randomUUID()}`;
  const ownerName = `owner-${run.owners.length}`;
  const directory = options.directory ?? join(run.directory, ownerName);
  const scratchDirectory = options.scratchDirectory ?? join(run.hostDirectory, ownerName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
  const selected = await backend(context.config, { namespace, directory: scratchDirectory, filesystem: true,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  const entry = { namespace, directory, scratchDirectory, record: null, checkpoints: [], proxyIdentity: selected.proxyIdentity };
  run.owners.push(entry);
  run.evidence.owners.push({ namespace, directory, scratchDirectory, recoveryPath: join(directory, 'recovery.json'),
    effectiveAuthority: selected.effectiveAuthority, effectiveAuthorityInput: selected.effectiveAuthorityInput,
    proxyIdentity: selected.proxyIdentity, endpointProjection: context.config.endpointProjection });
  const persistCurrent = jsonWriter(join(directory, 'recovery.json')); let sequence = 0;
  const recovery = { kind: 'persisted', async persist(record) {
    assert(sequence < 256, 'Combined checkpoint count exceeds its captured bound.');
    await jsonWriter(join(directory, `checkpoint-${String(++sequence).padStart(4, '0')}.json`))(record);
    await persistCurrent(record); entry.record = record;
    entry.checkpoints.push({ sequence, phase: record.phase, record: structuredClone(record) });
    await run.save(); await options.onPersist?.(record, entry);
  } };
  const instrumented = { support: selected.backend.support, reconcile: (...args) => selected.backend.reconcile(...args),
    reserve(...args) {
      assert.equal(entry.owner, undefined, 'The public combined example must reserve exactly once.');
      const owner = selected.backend.reserve(...args); entry.owner = owner; entry.record = owner.recoveryRecord;
      // The facade only records the original public owner and acquired ports; every operation remains with that same owner.
      return { get id() { return owner.id; }, get state() { return owner.state; },
        get recoveryRecord() { return owner.recoveryRecord; },
        async start(...input) { entry.sandbox = await owner.start(...input); return entry.sandbox; },
        stop: () => owner.stop(), destroy: () => owner.destroy() };
    } };
  const target = context.fixtures.targets().host;
  const input = request(context.config, { access: 'read_write', destinations: options.destinations });
  const example = await loadExample(context.config);
  let result;
  try { result = await example.runCombinedSandboxWorkflow({ backend: instrumented, request: input, recovery,
    operationTimeoutMs: context.config.capabilities.limits.requestMs, mode: options.mode ?? 'normal',
    positive: context.config.capabilities.network.positive,
    forbidden: { hostname: target.host, address: target.host, port: target.port, probe: target.probe, marker: target.marker },
    destination: join(scratchDirectory, 'published'),
    async onObservation(observation) {
      await run.observe({ kind: 'public-combined-workflow', namespace, observation });
      await options.onObservation?.(observation, entry);
    } }); }
  catch (error) {
    if (error instanceof example.CombinedSandboxWorkflowError) run.localCleanupOwners?.push(error);
    throw error;
  }
  assert.equal(entry.owner.state.kind, 'destroyed');
  run.evidence.owners.find((value) => value.namespace === namespace).finalRecord = entry.owner.recoveryRecord;
  await run.observe({ kind: 'public-combined-result', namespace, result });
  return { entry, result, selected };
}
