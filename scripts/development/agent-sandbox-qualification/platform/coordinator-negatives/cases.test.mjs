import assert from 'node:assert/strict';
import test from 'node:test';
import { memberNegatives, wrongGeneration } from './cases.mjs';

test('qualification retains unexpectedly returned public recovery authority before refusing the negative', async () => {
  const retained = [], recovery = { members: [{ operationId: 'original', phase: 'stopping' }],
    async reconcile() { return { kind: 'uncertain', owner: cleanupOwner }; } };
  const cleanupOwner = { recoveryRecord: recovery.members[0], destroy() {} };
  await assert.rejects(memberNegatives({ recovery, configuration: { profile: 'desktop-apple-virtualization-native-arm64',
    user: { uid: 1000, gid: 1000 }, egress: {} }, routeDescriptor: {},
  node: { createDockerDesktopRouteAuthority: (value) => value }, canonical: async () => Buffer.from('original'),
  observe: async () => {}, retain: (owner) => retained.push(owner) }), /uncertain/u);
  assert.deepEqual(retained, [cleanupOwner]);
  let original;
  const owner = { async reopenCleanup() { return { kind: 'opened', recovery }; } };
  await assert.rejects(wrongGeneration({ owner, generation: 'original', canonical: async () => Buffer.from('original'),
    observe: async () => {}, retain: (value) => { original = value; } }), /original public owner/u);
  assert.equal(original, recovery);
});
