import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { parseCanonicalEnvelope } from '../coordinator-recovery/canonical.mjs';
import { absolute, sha } from './evidence.mjs';

function originalBytes(path, maximum) {
  absolute(path); assert.equal(realpathSync(path), path);
  const before = lstatSync(path, { bigint: true }); assert(before.isFile() && before.size <= BigInt(maximum));
  const bytes = readFileSync(path); assert(bytes.length <= maximum);
  const after = lstatSync(path, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], 'Original cut evidence changed during its bounded read.');
  return { bytes, identity: { path, bytes: bytes.length, sha256: sha(bytes) } };
}

export function validatePendingCut(snapshot, selected, record, receipt) {
  assert.equal(snapshot.generation.kind, 'dirty'); const generation = snapshot.generation;
  assert.equal(generation.state.kind, 'open', 'A precise effect cut requires the original live generation before rollback.');
  const member = generation.members.find(({ memberId }) => memberId === record.operationId); assert(member);
  const entered = generation.entered; assert(entered, 'The selected cut requires its original pending effect.');
  assert.equal(entered.memberId, record.operationId); assert.equal(entered.role, selected.role); assert.equal(entered.action, selected.operation);
  assert.equal(entered.result.kind, 'unobserved', 'The installed SDK already observed the selected effect.');
  const ledger = member.roles.find(({ role }) => role === selected.role); assert(ledger);
  assert.equal(ledger[selected.operation].kind, 'pending'); assert.equal(ledger[selected.operation].effect, entered.effectSequence);
  const resource = record.resources.find(({ role }) => role === selected.role); assert(resource);
  const canonical = member.checkpoint.record.resources.find(({ role }) => role === selected.role); assert(canonical);
  assert.equal(canonical.name, resource.name); assert.equal(member.checkpoint.record.namespace, record.namespace);
  assert.equal(member.checkpoint.record.sandboxId, record.sandboxId);
  assert.equal(receipt.complete, true); assert.equal(receipt.failures.length, 0);
  assert(receipt.selected.status >= 200 && receipt.selected.status < 300);
  const target = new URL(receipt.selected.target, 'http://qualification.invalid');
  if (selected.operation === 'create') {
    assert.equal(receipt.selected.method, 'POST'); assert.equal(target.pathname, '/v1.52/containers/create');
    assert.equal(target.searchParams.get('name'), resource.name); assert.equal(entered.reference, resource.name);
    assert.equal(resource.identity.kind, 'creating'); assert.equal(canonical.identity.kind, 'creating');
    assert.equal(ledger.start.kind, ['network', 'storage', 'egress_socket'].includes(selected.role) ? 'not_applicable' : 'not_entered');
  } else {
    assert.equal(resource.identity.kind, 'identified'); assert.equal(canonical.identity.kind, 'identified');
    assert.equal(canonical.identity.id, resource.identity.id); assert.equal(entered.reference, resource.identity.id);
    assert.equal(ledger.create.kind, 'settled'); assert.equal(ledger.create.outcome, 'present');
    const collection = selected.role === 'network' ? 'networks' : ['storage', 'egress_socket'].includes(selected.role) ? 'volumes' : 'containers';
    const base = `/v1.52/${collection}/${encodeURIComponent(resource.identity.id)}`;
    assert.equal(receipt.selected.method, selected.operation === 'start' ? 'POST' : 'DELETE');
    assert.equal(target.pathname, selected.operation === 'start' ? `${base}/start` : base);
  }
  return { generation: generation.identity.generationId, memberId: member.memberId, role: selected.role, action: selected.operation,
    effectSequence: entered.effectSequence, reference: entered.reference, bindingDigest: entered.bindingDigest,
    checkpointDigest: entered.checkpointDigest, originalRecord: record };
}

export function suspendAtResponse(context, phase, receipt) {
  const { input, evidence, report, scenario } = context;
  assert(scenario.kind === 'handoff' || scenario.kind === 'lost-ack'); context.signal.throwIfAborted();
  assert(phase === 'response-before-delivery' || phase === 'request-error-listeners-returned');
  if (phase === 'response-before-delivery') {
    assert.equal(receipt.transportErrorIssued, false); assert.equal(receipt.selected.requestClosedAt, null);
  } else {
    assert.equal(receipt.transportErrorIssued, true); assert.equal(receipt.errorListenersReturned, true);
    assert.equal(receipt.transportErrorBeforeOriginalClose, true);
  }
  for (const source of report.sources) assert.equal(originalBytes(source.original, 1024 ** 2).identity.sha256, source.sha256);
  for (const asset of report.assets) assert.equal(originalBytes(asset.path, 32 * 1024 ** 2).identity.sha256, asset.sha256);
  assert.equal(originalBytes(report.input.path, 1024 ** 2).identity.sha256, report.input.sha256);
  const canonical = originalBytes(scenario.canonicalPath, 4 * 1024 ** 2); const parsed = parseCanonicalEnvelope(canonical.bytes);
  assert.equal(parsed.value.daemonId, report.engine.id); assert.equal(parsed.value.generation.identity.generationId, context.authority.generation);
  const selected = context.faultMember; assert(selected && selected.label === 'b');
  const pending = validatePendingCut(parsed.value, scenario.fault, selected.owner.recoveryRecord, receipt);
  const members = context.members.map((entry) => ({ label: entry.label, namespace: entry.report.namespace,
    record: evidence.fileSync(`${entry.label}/cut-record.json`, entry.owner.recoveryRecord, 65_536), state: entry.owner.state,
    process: entry.report.process ?? null, session: entry.session?.summary() ?? null }));
  report.handoff = { phase, at: new Date().toISOString(), pid: process.pid, canonical: canonical.identity,
    preservedCanonical: evidence.fileSync('cut-canonical-original.bin', canonical.bytes), members, receipt, pending,
    cut: { kind: 'synchronous-response-self-suspension', candidate: report.candidate, resumeSignal: 'SIGCONT',
      scope: 'Original member records, response and canonical bytes are captured synchronously without yielding to Node callbacks. SIGSTOP is explicit process suspension for crash injection; native close/error/deadline handlers are unchanged. Any original holder continuation is separate evidence, never a replacement for these bytes.' } };
  const preserved = evidence.fileSync('cut-report.json', report);
  writeSync(1, `${JSON.stringify({ status: 'cut_ready', pid: process.pid, phase, generation: pending.generation,
    report: preserved, canonical: canonical.identity, pending, resumeSignal: 'SIGCONT' })}\n`);
  process.kill(process.pid, 'SIGSTOP');
  evidence.fileSync('cut-resumed.json', { pid: process.pid, at: new Date().toISOString(), disposition: 'Original process resumed into exact original cleanup; this crash row remains failed.' });
  throw new Error('Explicit synchronous crash cut resumed into original cleanup.');
}
