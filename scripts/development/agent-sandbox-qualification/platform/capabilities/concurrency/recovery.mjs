import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../../engine.mjs';
import { installedIdentity } from '../../../scalability/identity.mjs';
import { Evidence, failure, sha } from '../../coordinator/evidence.mjs';
import { originalBytes, originalCanonical, originalFile, compareMemberInventory, exactAbsence, engineInventory, compareEngineInventory } from '../../coordinator-recovery/common.mjs';
import { installCleanupTrace } from '../../coordinator-recovery/trace.mjs';
import { retainCleanupOwner } from './ownership.mjs';

// Only a create acknowledgement carries a JSON body (the Engine-returned ID). Start and delete
// acknowledge with an empty 204 body, which is retained as exact original bytes.
export async function acknowledgedBody(receipt, operation) {
  const body = operation === 'create' ? await originalFile(receipt.body.path, 1024 ** 2) : await originalBytes(receipt.body.path, 1024 ** 2);
  assert.deepEqual(body.identity, receipt.body);
  if (operation === 'create') assert.match(body.value.Id, /^[a-f0-9]{64}$/u);
  return body;
}

export async function recoverConcurrency(inputPath, absentOnly = false) {
  const selected = await originalFile(inputPath, 1024 ** 2), input = selected.value;
  assert.equal(input.format, 'agenai.sandbox-concurrency-recovery.v1');
  const workerInput = await originalFile(input.workerInput, 1024 ** 2), config = workerInput.value;
  const original = await originalFile(input.originalReport, 8 * 1024 ** 2), report = original.value;
  assert.equal(report.format, 'agenai.sandbox-platform-concurrency-worker.v1');
  assert.deepEqual(report.input, workerInput.identity);
  const predecessor = await originalFile(input.predecessorQuiescence, 64 * 1024);
  assert.equal(predecessor.value.quiescent, true); assert.equal(predecessor.value.pid, report.handoff.pid);
  assert.equal(predecessor.value.signal, 'SIGKILL'); assert.equal(predecessor.value.intervention, false);
  const canonical = await originalCanonical(report.handoff.preservedCanonical.path);
  assert.equal(canonical.identity.sha256, report.handoff.canonical.sha256);
  assert.equal(canonical.value.generation.kind, 'dirty');
  assert.equal(canonical.value.generation.identity.generationId, report.coordinator.generation);
  const originals = [selected, workerInput, original, predecessor, canonical], members = [];
  for (const member of report.handoff.members) {
    const checkpoint = await originalFile(member.record.path, 65_536); assert.deepEqual(checkpoint.identity, member.record);
    const owner = report.members.find(({ label }) => label === member.label); assert(owner);
    compareMemberInventory(checkpoint.value, owner.originalRecord); originals.push(checkpoint);
    members.push({ label: member.label, original: checkpoint.value, configuration: owner.configuration, owner: null, returned: null });
  }
  assert(members.length >= 1 && members.length <= 3);
  const evidence = new Evidence(input.output); await evidence.initialize(selected.bytes);
  const result = { format: 'agenai.sandbox-concurrency-cleanup.v1', status: 'running', absentOnly, input: selected.identity,
    generation: report.coordinator.generation, originalReport: original.identity, predecessor: predecessor.identity,
    primaryFailure: null, cleanupFailures: [], settledRecords: [], calls: [], trace: null };
  let coordinator, opened, trace;
  const engine = new Engine(config.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs, outputBytes: 4 * 1024 ** 2 });
  const records = members.map((member) => member.original);
  if (report.handoff.receipt?.selected.body) {
    const body = await acknowledgedBody(report.handoff.receipt.selected, report.selected.operation); originals.push(body);
    if (report.selected.operation === 'create') {
      const b = records.find((record) => record.operationId === members.find(({ label }) => label === 'b').original.operationId);
      const resource = b.resources.find(({ role }) => role === report.selected.role);
      const observed = { ...b, resources: b.resources.map((entry) => entry === resource ? { ...entry, identity: { kind: 'identified', id: body.value.Id } } : entry) };
      records.push(observed);
    }
  }
  const finish = async () => {
    const failures = [];
    if (opened?.kind === 'opened') for (const member of members) {
      try {
        if (!member.returned) {
          if (!member.owner) {
            const record = opened.recovery.members.find(({ operationId }) => operationId === member.original.operationId);
            if (!record) { assert.equal(member.original.phase, 'destroyed'); member.returned = member.original; continue; }
            compareMemberInventory(record, member.original);
            const node = await import('@agen-ai/sandbox-docker/node');
            const configuration = { ...member.configuration, egress: { ...member.configuration.egress,
              routeAuthority: node.createDockerDesktopRouteAuthority(member.configuration.egress.routeAuthority) } };
            result.calls.push({ label: member.label, operation: 'cleanup-reconcile-original-canonical', record });
            const reconciliation = await opened.recovery.reconcile({ configuration, record }, { signal: AbortSignal.timeout(config.capabilities.limits.cleanupMs) });
            if (reconciliation.kind === 'absent') member.returned = reconciliation.record;
            else { assert(['matched', 'uncertain'].includes(reconciliation.kind)); member.owner = reconciliation.owner; }
          }
          if (member.owner) {
            for (const key of ['start', 'reserveProcess', 'importTree', 'exportTree', 'files']) assert.equal(typeof member.owner[key], 'undefined');
            result.calls.push({ label: member.label, operation: 'cleanup-destroy' });
            await member.owner.destroy(); member.returned = member.owner.recoveryRecord;
          }
          assert.equal(member.returned.phase, 'destroyed');
          const stored = await evidence.file(`${member.label}-settled-original-returned.json`, member.returned, 65_536);
          result.settledRecords.push({ label: member.label, ...stored });
        }
      } catch (error) { failures.push({ label: member.label, failure: failure(error) }); }
    }
    if (failures.length) throw new AggregateError(failures.map((value) => new Error(JSON.stringify(value))), 'Original cleanup-only recovery remains owned.');
    if (coordinator && coordinator.state.kind !== 'closed') {
      await coordinator.close({ timeoutMs: config.capabilities.limits.cleanupMs });
      assert.equal(coordinator.state.kind, 'closed'); assert.equal(coordinator.state.result, 'clean');
      assert.equal(coordinator.state.generation, report.coordinator.generation);
      result.finalCoordinator = coordinator.state;
    }
  };
  try {
    assert.deepEqual(await installedIdentity(config.consumer), report.candidate, 'Cleanup must execute the exact original installed package tuple.');
    for (const name of ['@agen-ai/sandbox', '@agen-ai/sandbox-docker/node']) assert(fileURLToPath(import.meta.resolve(name)).startsWith(`${config.consumer}/node_modules/`));
    for (const source of report.sources) assert.equal(sha(await readFile(source.original)), source.sha256);
    for (const asset of report.assets) assert.equal(sha(await readFile(asset.path)), asset.sha256);
    trace = installCleanupTrace({ socketPath: config.endpoint.slice(7), path: join(input.output, 'cleanup-http.jsonl'), records,
      consume: (bytes) => evidence.count(bytes) });
    result.before = await engineInventory(engine);
    const node = await import('@agen-ai/sandbox-docker/node');
    coordinator = node.createDockerDesktopCoordinator({ routeAuthority: node.createDockerDesktopRouteAuthority(config.capabilities.network.routeAuthority),
      helper: config.capabilities.concurrency.helper });
    opened = await coordinator.reopenCleanup({ expectedGeneration: report.coordinator.generation }, { timeoutMs: config.capabilities.limits.cleanupMs });
    if (absentOnly) {
      assert.equal(opened.kind, 'absent');
      for (const stored of input.settledRecords) {
        const settled = await originalFile(stored.path, 65_536); originals.push(settled);
        assert.deepEqual(settled.identity, { path: stored.path, bytes: stored.bytes, sha256: stored.sha256 });
        assert.equal(settled.value.phase, 'destroyed'); records.push(settled.value);
      }
      result.suppliedSettledRecords = input.settledRecords; result.reconcilePerformed = false;
    } else { assert.equal(opened.kind, 'opened'); result.reconcilePerformed = true; }
    await finish(); result.absence = await exactAbsence(engine, [...records, ...members.flatMap((member) => member.returned ? [member.returned] : [])]);
    result.after = await engineInventory(engine); compareEngineInventory(result.before, result.after, records);
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.primaryFailure = failure(error); }
  finally {
    try { await finish(); }
    catch (error) {
      result.status = 'failed'; result.cleanupFailures.push(failure(error));
      await retainCleanupOwner({ async operation() {
        try { await finish(); } catch (cause) { result.cleanupFailures.push(failure(cause)); throw cause; }
      }, async onRetained(attempt) {
        if (attempt <= 16) await evidence.file(`retained-report-${String(attempt).padStart(3, '0')}.json`, result, 8 * 1024 ** 2);
        process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', pid: process.pid, retrySignal: 'SIGUSR2', output: input.output })}\n`);
      } });
    }
    result.cleanupComplete = coordinator?.state.kind === 'closed' && coordinator.state.result === 'clean'
      && (absentOnly || members.every((member) => member.returned?.phase === 'destroyed'));
    for (const file of originals) assert.equal(sha(await readFile(file.identity.path)), file.identity.sha256, 'Original checkpoint or canonical bytes changed.');
    result.trace = trace?.summarize() ?? null; trace?.restore();
    if (result.trace?.blocked || result.trace?.forbiddenDispatches) result.status = 'failed';
    await evidence.file('report.json', result, 8 * 1024 ** 2); await evidence.close();
  }
  if (result.status !== 'passed') process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ status: result.status, report: join(input.output, 'report.json') })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { const args = process.argv.slice(2); assert(args.length === 1 || args.length === 2 && args[0] === '--absent'); await recoverConcurrency(args.at(-1), args.length === 2); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
}
