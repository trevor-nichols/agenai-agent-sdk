// ------------------------------------------------------------------------------------------------
//                admission.test.mjs - Diagnostic authority is exact by role, image and run identity
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { admitObservedContainer, observerPolicy } from './admission.mjs';
import { createDaemonObserver } from './index.mjs';

const workload = `sha256:${'a'.repeat(64)}`;
const helper = `sha256:${'b'.repeat(64)}`;
const id = 'c'.repeat(64);
const operationId = '12345678-1234-4123-8123-123456789abc';
const fixtureOwner = '87654321-4321-4321-8321-cba987654321';

function sdkContainer(role, image = role === 'filesystem' ? helper : workload) {
  return { Id: id, Image: image, State: { Running: true, Pid: 42 }, Config: { Labels: {
    'ai.agen.sandbox.backend': 'agenai-docker', 'ai.agen.sandbox.role': role,
    'ai.agen.sandbox.namespace': 'platform-live-abcd0001-case1', 'ai.agen.sandbox.operation': operationId,
    'ai.agen.sandbox.image': workload,
  } } };
}

function rolePolicy() {
  return observerPolicy({ roleImages: { compute: [workload], filesystem: [helper], export: [workload] },
    namespacePrefixes: ['platform-live-abcd0001-'], qualificationFixtures: { owner: fixtureOwner, sentinel: [workload] } });
}

test('legacy observers remain compute-only and retain their original scope shape', () => {
  const legacy = observerPolicy({ allowedImages: [workload, helper], namespacePrefixes: ['platform-live-abcd0001-'] });
  assert.deepEqual(admitObservedContainer(legacy, sdkContainer('compute'), id), {
    computeId: id, namespace: 'platform-live-abcd0001-case1', operationId, imageDigest: workload, keeperPid: 42,
  });
  assert.equal(admitObservedContainer(legacy, sdkContainer('filesystem'), id), null);
  assert.equal(admitObservedContainer(legacy, sdkContainer('export'), id), null);
  assert.throws(() => admitObservedContainer(legacy, sdkContainer('compute', helper), id));
});

test('explicit helper observation accepts its own image with the workload identity, rejecting crossed identities', () => {
  const policy = rolePolicy();
  assert.deepEqual(admitObservedContainer(policy, sdkContainer('filesystem'), id), {
    computeId: id, namespace: 'platform-live-abcd0001-case1', operationId,
    imageDigest: helper, role: 'filesystem', workloadImage: workload, keeperPid: 42,
  });
  assert.equal(admitObservedContainer(policy, sdkContainer('export'), id).role, 'export');
  const changes = [
    (actual) => { actual.Image = workload; },
    (actual) => { actual.Config.Labels['ai.agen.sandbox.image'] = helper; },
    (actual) => { actual.Config.Labels['ai.agen.sandbox.namespace'] = 'another-run-case1'; },
    (actual) => { actual.Config.Labels['ai.agen.sandbox.operation'] = 'not-a-uuid'; },
    (actual) => { actual.State.Pid = 0; },
    (actual) => { actual.State.Running = false; },
    (actual) => { actual.Id = 'd'.repeat(64); },
  ];
  for (const change of changes) {
    const actual = sdkContainer('filesystem'); change(actual);
    assert.throws(() => admitObservedContainer(policy, actual, id));
  }
  assert.equal(admitObservedContainer(policy, sdkContainer('egress'), id), null);
  assert.equal(admitObservedContainer(policy, sdkContainer('constructor'), id), null);
});

test('qualification fixtures have their own exact run and image authority without SDK labels', () => {
  const policy = rolePolicy();
  const actual = { Id: id, Image: workload, State: { Running: true, Pid: 91 }, Config: { Labels: {
    'org.agenai.sandbox.platform-live.owner': fixtureOwner, 'org.agenai.sandbox.platform-live.role': 'sentinel',
  } } };
  assert.deepEqual(admitObservedContainer(policy, actual, id), { computeId: id, namespace: null,
    operationId: fixtureOwner, imageDigest: workload, role: 'qualification_sentinel', keeperPid: 91 });
  actual.Image = helper;
  assert.throws(() => admitObservedContainer(policy, actual, id));
  actual.Image = workload; actual.Config.Labels['org.agenai.sandbox.platform-live.role'] = 'writer';
  assert.throws(() => admitObservedContainer(policy, actual, id));
  actual.Config.Labels['org.agenai.sandbox.platform-live.owner'] = operationId;
  assert.equal(admitObservedContainer(policy, actual, id), null);
});

test('restricted observers capture each native helper and separate network fixture authority', () => {
  const vmImage = `sha256:${'d'.repeat(64)}`;
  const policy = observerPolicy({ roleImages: { compute: [workload], export: [workload],
    egress_broker: [helper], egress_relay: [helper], route_observer: [vmImage] },
  namespacePrefixes: ['platform-live-abcd0001-'],
  qualificationFixtures: { owner: fixtureOwner, public_marker: [vmImage], vm_marker: [vmImage] } });
  for (const role of ['egress_broker', 'egress_relay', 'route_observer']) {
    const actual = sdkContainer(role, role === 'route_observer' ? vmImage : helper);
    const admitted = admitObservedContainer(policy, actual, id);
    assert.equal(admitted.role, role); assert.equal(admitted.workloadImage, workload);
    assert.equal(admitted.imageDigest, actual.Image);
    actual.Image = workload;
    assert.throws(() => admitObservedContainer(policy, actual, id));
  }
  for (const role of ['public_marker', 'vm_marker']) {
    const actual = { Id: id, Image: vmImage, State: { Running: true, Pid: 19 }, Config: { Labels: {
      'org.agenai.sandbox.platform-network.owner': fixtureOwner,
      'org.agenai.sandbox.platform-network.role': role,
    } } };
    assert.equal(admitObservedContainer(policy, actual, id).role, `qualification_${role}`);
    actual.Config.Labels['org.agenai.sandbox.platform-network.owner'] = operationId;
    assert.equal(admitObservedContainer(policy, actual, id), null);
  }
  const outside = sdkContainer('filesystem', helper);
  assert.equal(admitObservedContainer(policy, outside, id), null);
});

test('observer policy captures caller-owned arrays before later changes can widen authority', () => {
  const input = { roleImages: { compute: [workload], filesystem: [helper] }, namespacePrefixes: ['platform-live-abcd0001-'],
    qualificationFixtures: { owner: fixtureOwner, sentinel: [workload] } };
  const policy = observerPolicy(input);
  input.roleImages.filesystem.push(workload); input.namespacePrefixes.push('another-run-');
  input.qualificationFixtures.sentinel.push(helper);
  assert.throws(() => admitObservedContainer(policy, sdkContainer('filesystem', workload), id));
  const outside = sdkContainer('compute'); outside.Config.Labels['ai.agen.sandbox.namespace'] = 'another-run-case1';
  assert.throws(() => admitObservedContainer(policy, outside, id));
  assert.deepEqual(policy.qualificationFixtures.sentinel, [workload]);
});

test('invalid observer authority rejects before filesystem or Engine effects', async (t) => {
  const root = await mkdtemp('/var/tmp/agenai-observer-admission-');
  t.after(() => rm(root, { recursive: true }));
  const invalid = [
    { roleImages: { compute: [workload], network: [helper] } },
    { roleImages: { filesystem: [helper] } },
    { roleImages: { compute: [workload] }, allowedImages: [workload] },
    { allowedImages: [workload], qualificationFixtures: { owner: fixtureOwner, sentinel: [workload] } },
    { roleImages: { compute: [workload] }, qualificationFixtures: { owner: fixtureOwner, sentinel: [workload], extra: true } },
    { roleImages: { compute: ['node:latest'] } },
    { roleImages: { compute: [workload] }, namespacePrefixes: [''] },
    ...[null, 0, 1, 129, 255, 257, 256.5, Infinity, NaN, '256'].map((maxScopes) => ({ allowedImages: [workload], maxScopes })),
  ];
  for (const [index, input] of invalid.entries()) {
    const output = join(root, String(index));
    await assert.rejects(createDaemonObserver({ endpoint: 'unix:///nonexistent-observer-engine.sock', output,
      imageDigest: workload, architecture: 'arm64', namespacePrefixes: ['platform-live-abcd0001-'], ...input }),
    { name: 'AssertionError' });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});
