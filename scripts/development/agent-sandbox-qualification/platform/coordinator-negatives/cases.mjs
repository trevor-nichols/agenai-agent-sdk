import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { failure, sha } from '../coordinator/evidence.mjs';

export async function wrongGeneration({ owner, generation, canonical, observe, retain }) {
  const before = await canonical();
  const wrong = randomUUID(); assert.notEqual(wrong, generation);
  let caught;
  try {
    const opened = await owner.reopenCleanup({ expectedGeneration: wrong }, { timeoutMs: 60_000 });
    if (opened.kind === 'opened') retain(opened.recovery);
  }
  catch (error) { caught = error; }
  await observe({ name: 'wrong-coordinator-generation', expected: wrong, actual: generation, failure: caught ? failure(caught) : null });
  assert(caught && caught.owner === owner, 'Wrong-generation rejection must retain its original public owner.');
  assert.deepEqual(caught.failure, { kind: 'identity_conflict', scope: 'generation' });
  assert.deepEqual(await canonical(), before, 'Wrong-generation rejection changed the original canonical bytes.');
}

export async function memberNegatives({ recovery, configuration, routeDescriptor, node, canonical, observe, retain }) {
  const record = recovery.members[0]; assert(record);
  const otherProfile = configuration.profile.endsWith('native-arm64')
    ? 'desktop-apple-virtualization-rosetta-amd64' : 'desktop-apple-virtualization-native-arm64';
  const changedUser = { ...configuration.user, uid: configuration.user.uid + 1 };
  const cases = [
    { name: 'changed-member-configuration', input: { configuration: { ...configuration, user: changedUser,
      ...(configuration.filesystem ? { filesystem: { ...configuration.filesystem, user: changedUser } } : {}) }, record }, result: 'conflict' },
    { name: 'changed-member-profile', input: { configuration: { ...configuration, profile: otherProfile,
      egress: { ...configuration.egress, routeAuthority: node.createDockerDesktopRouteAuthority({ ...routeDescriptor, profile: otherProfile }) } }, record }, result: 'conflict' },
    { name: 'noncanonical-original-record', input: { configuration, record: { ...record,
      phase: record.phase === 'stopped' ? 'stopping' : 'stopped' } }, result: 'conflict' },
    { name: 'missing-original-checkpoint', input: { configuration }, result: 'missing' },
    { name: 'copied-recovery-capability', input: { configuration, record }, result: 'copied' },
  ];
  for (const selected of cases) {
    const before = await canonical(); const members = JSON.stringify(recovery.members);
    let returned, caught;
    try {
      returned = selected.result === 'copied'
        ? await Reflect.apply(recovery.reconcile, { ...recovery }, [selected.input])
        : await recovery.reconcile(selected.input, { signal: AbortSignal.timeout(60_000) });
      // Preserve unexpected returned authority before asserting anything about its disposition.
      if (returned?.owner) retain(returned.owner, selected.name);
    } catch (error) { caught = error; }
    await observe({ name: selected.name, result: returned ? { kind: returned.kind, reason: returned.reason } : null,
      failure: caught ? failure(caught) : null, canonicalSha256Before: sha(before) });
    if (selected.result === 'conflict') { assert.equal(caught, undefined); assert.equal(returned?.kind, 'conflict'); }
    else {
      assert(caught instanceof TypeError);
      assert.match(caught.message, selected.result === 'missing'
        ? /original member configuration and canonical record/u : /original recovery capability/u);
    }
    assert.equal(JSON.stringify(recovery.members), members, 'A recovery negative changed the public canonical inventory.');
    assert.deepEqual(await canonical(), before, 'A recovery negative changed the original canonical bytes.');
  }
}
