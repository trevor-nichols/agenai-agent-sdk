// ------------------------------------------------------------------------------------------------
//                admission.mjs - Explicit diagnostic scope admission from actual Engine identities
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const sdkRoles = ['compute', 'filesystem', 'export', 'egress_broker', 'egress_relay', 'route_observer'];
const fixtureOwnerLabel = 'org.agenai.sandbox.platform-live.owner';
const fixtureRoleLabel = 'org.agenai.sandbox.platform-live.role';

function images(value) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 8, 'Expected a bounded explicit image allowlist.');
  value.forEach((id) => assert(typeof id === 'string' && digest.test(id), 'Expected an immutable image ID.'));
  return [...value];
}

export function observerPolicy(input) {
  assert(Array.isArray(input.namespacePrefixes) && input.namespacePrefixes.length > 0 && input.namespacePrefixes.length <= 8);
  input.namespacePrefixes.forEach((prefix) => assert(typeof prefix === 'string' && /^[a-z][a-z0-9-]{0,62}$/u.test(prefix)));
  const namespacePrefixes = [...input.namespacePrefixes];
  if (input.roleImages === undefined) {
    assert.equal(input.qualificationFixtures, undefined, 'Fixtures require an explicit role policy.');
    return { allowedImages: images(input.allowedImages), namespacePrefixes };
  }
  assert.equal(input.allowedImages, undefined, 'Legacy and role-specific image policies are mutually exclusive.');
  assert(input.roleImages && typeof input.roleImages === 'object' && !Array.isArray(input.roleImages));
  assert(Object.keys(input.roleImages).every((role) => sdkRoles.includes(role)), 'Unknown observed SDK role.');
  assert(Object.hasOwn(input.roleImages, 'compute'), 'The workload image identity must be explicit.');
  const roleImages = Object.fromEntries(Object.entries(input.roleImages).map(([role, values]) => [role, images(values)]));
  const policy = { roleImages, namespacePrefixes };
  if (input.qualificationFixtures !== undefined) {
    const fixtures = input.qualificationFixtures;
    assert(fixtures && typeof fixtures === 'object' && !Array.isArray(fixtures));
    const roles = Object.keys(fixtures).filter((key) => key !== 'owner');
    assert(roles.length > 0 && roles.every((role) => ['sentinel', 'public_marker', 'vm_marker'].includes(role)),
      'Unknown qualification fixture role.');
    assert(typeof fixtures.owner === 'string' && uuid.test(fixtures.owner), 'Fixture owner must identify this exact run.');
    policy.qualificationFixtures = { owner: fixtures.owner,
      ...Object.fromEntries(roles.map((role) => [role, images(fixtures[role])])) };
  }
  return policy;
}

export function admitObservedContainer(policy, actual, id) {
  const labels = actual.Config?.Labels ?? {};
  let identity;
  if (labels['ai.agen.sandbox.backend'] === 'agenai-docker') {
    const role = labels['ai.agen.sandbox.role'];
    const allowed = policy.roleImages && Object.hasOwn(policy.roleImages, role)
      ? policy.roleImages[role] : role === 'compute' ? policy.allowedImages : undefined;
    if (!allowed) return null;
    const namespace = labels['ai.agen.sandbox.namespace'];
    assert(typeof namespace === 'string' && policy.namespacePrefixes.some((prefix) => namespace.startsWith(prefix)),
      'Started SDK container namespace is outside this qualification run.');
    const workloadImages = policy.roleImages?.compute ?? policy.allowedImages;
    assert(allowed.includes(actual.Image) && workloadImages.includes(labels['ai.agen.sandbox.image']),
      'Started SDK container does not match its admitted role and workload image identities.');
    if (role === 'compute' || role === 'export') assert.equal(actual.Image, labels['ai.agen.sandbox.image']);
    const operationId = labels['ai.agen.sandbox.operation'];
    assert(typeof operationId === 'string' && uuid.test(operationId));
    identity = { namespace, operationId, imageDigest: actual.Image,
      ...(policy.roleImages ? { role, workloadImage: labels['ai.agen.sandbox.image'] } : {}) };
  } else if (policy.qualificationFixtures && (labels[fixtureOwnerLabel] === policy.qualificationFixtures.owner
    || labels['org.agenai.sandbox.platform-network.owner'] === policy.qualificationFixtures.owner)) {
    const role = labels[fixtureOwnerLabel] === policy.qualificationFixtures.owner
      ? labels[fixtureRoleLabel] : labels['org.agenai.sandbox.platform-network.role'];
    assert(labels[fixtureOwnerLabel] === policy.qualificationFixtures.owner ? role === 'sentinel'
      : role === 'public_marker' || role === 'vm_marker', 'Qualification role uses the wrong label namespace.');
    assert(Object.hasOwn(policy.qualificationFixtures, role) && role !== 'owner', 'Unknown qualification fixture role.');
    assert(policy.qualificationFixtures[role].includes(actual.Image), 'Qualification fixture image is not admitted.');
    identity = { namespace: null, operationId: policy.qualificationFixtures.owner,
      imageDigest: actual.Image, role: `qualification_${role}` };
  } else return null;
  assert.equal(actual.Id, id);
  assert.equal(actual.State?.Running, true);
  assert(Number.isSafeInteger(actual.State.Pid) && actual.State.Pid > 0);
  return { computeId: id, ...identity, keeperPid: actual.State.Pid };
}
