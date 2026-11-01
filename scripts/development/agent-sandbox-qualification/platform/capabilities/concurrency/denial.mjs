import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { originalCanonical } from '../../coordinator-recovery/common.mjs';
import { identified } from '../network/resources.mjs';

const ipv4 = (value) => value.split('.').reduce((result, part) => result * 256 + Number(part), 0);
export function coversAllocation(coverage, allocation) {
  const [address, prefix] = allocation.split('/'), start = ipv4(address), end = start + 2 ** (32 - Number(prefix)) - 1;
  return coverage.some((value) => {
    if (value.includes(':')) return false;
    const [network, bits] = value.split('/'), size = 2 ** (32 - Number(bits)), first = Math.floor(ipv4(network) / size) * size;
    return first <= start && first + size - 1 >= end;
  });
}

export function denialBeforeTopology(context) {
  const captured = new Set();
  return async ({ method, target, traceId }) => {
    if (method !== 'POST' || !/^\/v1\.52\/(?:containers|networks|volumes)\/create(?:\?|$)/u.test(target)) return;
    const candidates = Object.values(context.report.members).filter((entry) => !captured.has(entry.record.operationId));
    if (!candidates.length || !context.fixtures) return;
    const id = context.config.platform.expected.daemon.id;
    const key = createHash('sha256').update(`agenai.desktop-coordinator.engine.v1\0${id}`).digest('hex');
    const path = join(userInfo().homedir, 'Library/Application Support/AgenAI/sandbox-docker/desktop-coordination-v1', `${key}.state`);
    const before = await originalCanonical(path), generation = before.value.generation;
    assert.equal(generation.kind, 'dirty');
    const entered = generation.entered;
    if (!entered || entered.action !== 'create') return;
    const selected = candidates.find((entry) => entry.record.operationId === entered.memberId); if (!selected) return;
    const candidate = generation.members.find((entry) => entry.memberId === entered.memberId); assert(candidate);
    assert.equal(candidate.allocation.kind, 'reserved'); assert.equal(entered.result.kind, 'unobserved');
    const policies = [];
    for (const peer of Object.values(context.report.members).filter((entry) => entry.record.operationId !== entered.memberId && entry.record.phase === 'running')) {
      const policy = await context.fixtures.brokerPolicy({ owner: { recoveryRecord: peer.record } });
      assert(coversAllocation(policy.configuration.excludedCidrs, candidate.allocation.subnet),
        'A candidate member allocation is outside an already-running broker immutable denied coverage.');
      policies.push({ label: peer.label, namespace: peer.namespace, policy });
    }
    const after = await originalCanonical(path);
    assert.equal(after.value.generation.kind, 'dirty');
    assert.deepEqual(after.value.generation.entered, entered, 'Entered topology intent changed before original forwarding.');
    const retained = await context.evidence.file(`denial-before-topology-${selected.label}.json`, {
      phase: context.collector.current, traceId, method, target, member: selected.label, operationId: selected.record.operationId,
      allocation: candidate.allocation, entered, brokerPolicies: policies,
      originalCanonicalBefore: await context.evidence.file(`denial-${selected.label}-canonical-before.bin`, before.bytes),
      originalCanonicalAfter: await context.evidence.file(`denial-${selected.label}-canonical-after.bin`, after.bytes),
      effectDisposition: 'Original request has not entered upstream forwarding. These are the original already-installed broker policies; no policy update is performed.',
    });
    context.report.denialBeforeTopology ??= []; context.report.denialBeforeTopology.push(retained);
    captured.add(selected.record.operationId);
  };
}

export async function assertPhysicalWorkspace(context, entry) {
  const storage = identified(entry.record, 'storage'), compute = identified(entry.record, 'compute');
  const actual = (await context.engine.request('GET', `/containers/${compute.identity.id}/json`)).data;
  assert.equal(actual.Id, compute.identity.id);
  const mounts = actual.Mounts.filter((mount) => mount.Type === 'volume' && mount.Name === storage.identity.id);
  assert.equal(mounts.length, 1, 'Original compute must mount its exact independently owned storage volume once.');
  assert.equal(mounts[0].RW, true);
  context.report.physicalWorkspaces ??= [];
  for (const peer of context.report.physicalWorkspaces.filter((value) => value.operationId !== entry.record.operationId)) {
    assert.notEqual(peer.storageId, storage.identity.id, 'Independent members share a physical storage volume.');
    assert.notEqual(peer.mount.Source, mounts[0].Source, 'Independent members share a physical workspace source.');
    assert.notEqual(peer.computeId, compute.identity.id, 'Independent members share compute.');
  }
  const retained = { label: entry.label, operationId: entry.record.operationId, storageId: storage.identity.id,
    computeId: compute.identity.id, mount: mounts[0], inspection: actual };
  context.report.physicalWorkspaces.push(retained);
  return retained;
}
