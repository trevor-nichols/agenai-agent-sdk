import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { compareMemberInventory, originalBytes, originalCanonical, originalFile } from './common.mjs';

export async function loadOriginalMembers(input) {
  const originalInput = await originalFile(input.originalInput, 1024 ** 2);
  const retained = await originalFile(input.originalReport, 4 * 1024 ** 2);
  const canonical = await originalCanonical(input.canonical);
  const config = originalInput.value; const report = retained.value; const handoff = report.handoff;
  assert.equal(report.format, 'agenai.desktop-coordinator-ms005-exploratory.v1');
  assert(handoff && (report.scenario.kind === 'handoff' || report.scenario.kind === 'lost-ack'));
  if (report.scenario.kind === 'lost-ack') {
    if (handoff.cut?.kind === 'synchronous-response-self-suspension') {
      assert.equal(handoff.phase, 'request-error-listeners-returned'); assert.equal(handoff.receipt.errorListenersReturned, true);
    } else assert.equal(handoff.phase, 'lost-ack-delivered');
    assert.equal(handoff.receipt.transportErrorIssued, true);
    assert.equal(handoff.receipt.transportErrorBeforeOriginalClose, true);
  }
  assert.deepEqual(report.input, originalInput.identity); assert.equal(dirname(input.originalReport), config.output);
  assert.equal(canonical.identity.path, handoff.preservedCanonical.path); assert.equal(canonical.identity.sha256, handoff.canonical.sha256);
  assert.equal(canonical.identity.bytes, handoff.canonical.bytes);
  assert.equal(canonical.value.generation.kind, 'dirty');
  const generation = canonical.value.generation.identity.generationId;
  assert.equal(generation, report.coordinator.generation); assert.equal(canonical.value.daemonId, report.engine.id);
  assert.equal(config.platform.engine, report.socket.endpoint); assert.equal(config.capabilities.network.routeAuthority.engine.id, report.engine.id);
  assert.equal(config.platform.profile, 'desktop-apple-virtualization-native-arm64');
  assert(handoff.members.length >= 1 && handoff.members.length <= 3);
  assert.equal(new Set(handoff.members.map(({ label }) => label)).size, handoff.members.length);
  const members = []; const originals = [originalInput, retained, canonical];
  for (const selected of handoff.members) {
    assert(['a', 'b', 'c'].includes(selected.label));
    const member = report.members.find(({ label }) => label === selected.label); assert(member);
    const checkpoint = await originalFile(selected.record.path, 65_536); originals.push(checkpoint);
    assert.deepEqual(checkpoint.identity, selected.record); const record = checkpoint.value;
    assert.equal(record.namespace, selected.namespace); assert.equal(record.namespace, member.namespace);
    compareMemberInventory(record, member.originalRecord);
    const canonicalMember = canonical.value.generation.members.find(({ memberId }) => memberId === record.operationId);
    if (canonicalMember) compareMemberInventory(canonicalMember.checkpoint.record, record);
    else {
      assert.equal(record.phase, 'destroyed', 'A missing original member requires its SDK-returned destroyed record.');
      assert(canonical.value.generation.retired.some((entry) => (Array.isArray(entry) ? entry[0] : entry.memberId) === record.operationId),
        'A missing original member requires its exact canonical retirement.');
    }
    members.push({ member, checkpoint, record, canonicalMember });
  }
  assert.equal(canonical.value.generation.members.length, members.filter(({ canonicalMember }) => canonicalMember).length);
  const observed = [];
  for (const selected of members) {
    const resources = selected.record.resources.map((resource) => {
      const copy = { ...resource, identity: { ...resource.identity } };
      const presence = selected.canonicalMember?.roles.find(({ role }) => role === resource.role).presence;
      if (!presence) return copy;
      const id = presence.kind === 'present' ? presence.id : presence.kind === 'possibly_present' ? presence.returnedId : null;
      return id && resource.identity.kind !== 'identified' ? { ...copy, identity: { kind: 'identified', id } } : copy;
    });
    observed.push({ ...selected.record, resources });
  }
  if (handoff.receipt) {
    if (report.scenario.kind === 'handoff') assert.equal(report.scenario.at, 'effect-response');
    const receipt = handoff.receipt;
    assert.equal(receipt.complete, true); assert.equal(receipt.failures.length, 0);
    assert(receipt.selected.status >= 200 && receipt.selected.status < 300);
    const bytes = await originalBytes(receipt.selected.body.path, 1024 ** 2); originals.push(bytes);
    assert.deepEqual(bytes.identity, receipt.selected.body);
    if (report.scenario.fault.operation === 'create') {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.bytes));
      assert.match(value.Id, /^[a-f0-9]{64}$/u);
      const member = observed.find(({ operationId }) => operationId === members.find(({ member: item }) => item.label === 'b').record.operationId);
      const role = report.scenario.fault.role; const resource = member.resources.find((item) => item.role === role);
      assert.equal(new URL(receipt.selected.target, 'http://qualification.invalid').searchParams.get('name'), resource.name);
      if (resource.identity.kind === 'identified') assert.equal(resource.identity.id, value.Id);
      else { assert.equal(resource.identity.kind, 'creating'); resource.identity = { kind: 'identified', id: value.Id }; }
    }
  }
  return { originalInput, retained, canonical, config, report, generation, members, originals, observed };
}
