// ------------------------------------------------------------------------------------------------
//                acp-failures.ts - Public consumer setup failures retain exact cleanup ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AcpInstallationError, type AcpInstallationStore } from '@agen-ai/acp-registry/node';
import { installFixture, type prepareArtifacts } from '../registry-provider/installation.js';
import { createManagedHost, createRetainedPeer, parentScope } from './acp-host.js';
import { FixtureCleanupError, FixtureOwnership, ownCoordinator, withCleanup } from './acp-ownership.js';

async function proveOrphanReferenceRecovery(store: AcpInstallationStore, root: string,
  artifacts: Awaited<ReturnType<typeof prepareArtifacts>>, parentOwnership: FixtureOwnership) {
  const caseRoot = join(root, 'orphan-child-recovery');
  await mkdir(caseRoot);
  const ownership = new FixtureOwnership(caseRoot);
  const caseOwner = parentOwnership.hold('orphan child-reference recovery fixture', () => ownership.retire());
  const fixture = await installFixture({ store, root: caseRoot, ...artifacts, kind: 'binary', mode: 'permission' });
  const peer = await createRetainedPeer(store, caseRoot, fixture, ownership);
  const obstruction = join(caseRoot, 'blocked-directory');
  await writeFile(obstruction, 'Child setup fails before native execution.');
  let firstRelease = true;
  let childAcquires = 0;
  let childReleases = 0;
  const childStore: AcpInstallationStore = { ...store,
    async acquire(input) { const ref = await store.acquire(input); childAcquires += 1; return ref; },
    async release(ref) {
      if (firstRelease) { firstRelease = false; throw new Error('Injected first child-reference release failure.'); }
      await store.release(ref); childReleases += 1;
    },
  };
  const managed = await createManagedHost(peer, childStore, obstruction);
  const client = await managed.coordinator.bindParent({ scope: parentScope('A') });
  const admitted = await client.spawn({ operationId: randomUUID(), expectedPolicyRevision: 1,
    target: managed.catalog.targets[0]!.reference, input: { parts: [{ type: 'text', text: 'Setup fails and retains its reference.' }] } });
  assert.equal((await client.wait({ taskId: admitted.taskId, timeoutMs: 5_000 })).task.runs.items[0]?.outcome?.kind, 'failed');
  assert.deepEqual({ childAcquires, childReleases }, { childAcquires: 1, childReleases: 0 });
  await managed.close();
  await assert.rejects(peer.close(), (error: unknown) => error instanceof AcpInstallationError && error.code === 'reference_active');
  let retained: FixtureCleanupError | undefined;
  await assert.rejects(ownership.retire(), (error: unknown) => {
    assert.ok(error instanceof FixtureCleanupError);
    retained = error;
    return true;
  });
  assert.ok(retained);
  let retryError: unknown;
  try { await retained.retryCleanup(); } catch (error) { retryError = error; }
  assert.equal(childReleases, 1, 'A blocked earlier owner must not starve a later retained child reference.');
  assert.ok(retryError instanceof FixtureCleanupError);
  assert.ok(retryError.errors.some((error: unknown) => error instanceof AcpInstallationError && error.code === 'reference_active'));
  assert.equal(ownership.responsibilities.length, 1);
  await access(obstruction);
  await retryError.retryCleanup();
  assert.deepEqual(ownership.responsibilities, []);
  await assert.rejects(access(caseRoot), { code: 'ENOENT' });
  await caseOwner.release();
}

export async function proveSetupFailureOwnership(store: AcpInstallationStore, root: string,
  artifacts: Awaited<ReturnType<typeof prepareArtifacts>>, ownership: FixtureOwnership) {
  const resolveRoot = join(root, 'resolve-failure');
  await mkdir(resolveRoot);
  const fixture = await installFixture({ store, root: resolveRoot, ...artifacts, kind: 'binary', mode: 'permission' });
  const failure = new Error('Injected pre-native launch resolution failure.');
  let acquired = 0;
  let released = 0;
  const failingStore: AcpInstallationStore = { ...store,
    async acquire(input) { const ref = await store.acquire(input); acquired += 1; return ref; },
    async resolveLaunch() { throw failure; },
    async release(ref) { await store.release(ref); released += 1; },
  };
  await assert.rejects(createRetainedPeer(failingStore, resolveRoot, fixture, ownership), (error: unknown) => error === failure);
  assert.deepEqual({ acquired, released }, { acquired: 1, released: 1 });
  const cleanupFailure = new Error('Injected reference cleanup failure.');
  let rejectRelease = true;
  const retainedStore: AcpInstallationStore = { ...failingStore, async release(ref) {
    if (rejectRelease) { rejectRelease = false; throw cleanupFailure; }
    await failingStore.release(ref);
  } };
  let retained: FixtureCleanupError | undefined;
  await assert.rejects(createRetainedPeer(retainedStore, resolveRoot, fixture, ownership), (error: unknown) => {
    assert.ok(error instanceof FixtureCleanupError);
    assert.ok(error.errors.includes(failure) && error.errors.includes(cleanupFailure));
    retained = error;
    return true;
  });
  assert.ok(retained);
  assert.equal(retained.root, root);
  assert.equal(ownership.responsibilities.length, 1);
  await retained.retryCleanup();
  await retained.retryCleanup();
  assert.deepEqual({ acquired, released }, { acquired: 2, released: 2 });
  assert.deepEqual(ownership.responsibilities, []);
  await store.remove(fixture.identity);

  const directoryRoot = join(root, 'directory-failure');
  await mkdir(directoryRoot);
  const directoryFixture = await installFixture({ store, root: directoryRoot, ...artifacts, kind: 'binary', mode: 'permission' });
  const peer = await createRetainedPeer(store, directoryRoot, directoryFixture, ownership);
  const obstruction = join(directoryRoot, 'blocked-directory');
  await writeFile(obstruction, 'An ordinary file prevents child-directory setup.');
  acquired = 0; released = 0;
  const childStore: AcpInstallationStore = { ...store,
    async acquire(input) { const ref = await store.acquire(input); acquired += 1; return ref; },
    async release(ref) { await store.release(ref); released += 1; },
  };
  const managed = await createManagedHost(peer, childStore, obstruction);
  await withCleanup(async () => {
    const client = await managed.coordinator.bindParent({ scope: parentScope('A') });
    const admitted = await client.spawn({ operationId: randomUUID(), expectedPolicyRevision: 1,
      target: managed.catalog.targets[0]!.reference, input: { parts: [{ type: 'text', text: 'No native child can start.' }] } });
    const settled = await client.wait({ taskId: admitted.taskId, timeoutMs: 5_000 });
    assert.equal(settled.status, 'settled');
    assert.equal(settled.task.runs.items[0]?.outcome?.kind, 'failed');
    assert.deepEqual({ acquired, released }, { acquired: 1, released: 1 });
  }, async () => {
    await managed.close();
    await peer.close();
  });

  await proveOrphanReferenceRecovery(store, root, artifacts, ownership);

  const uncertainRoot = join(root, 'uncertain-cleanup');
  await mkdir(uncertainRoot);
  const evidence = join(uncertainRoot, 'retained-reference-evidence.json');
  await writeFile(evidence, JSON.stringify({ fixture: 'uncertain coordinator teardown', nativeReferencesRemaining: 0 }));
  const uncertainOwnership = new FixtureOwnership(uncertainRoot);
  let firstClose = true;
  const coordinator = ownCoordinator(uncertainOwnership, { ...managed.coordinator, async dispose(input) {
    const receipt = await managed.coordinator.dispose(input);
    if (firstClose) { firstClose = false; return { status: 'recovery_required', retainedTaskIds: [] }; }
    return receipt;
  } });
  await assert.rejects(coordinator.release(), /still owns nonquiescent cleanup/u);
  await assert.rejects(uncertainOwnership.retire(), (error: unknown) => error instanceof FixtureCleanupError
    && error.root === uncertainRoot && error.responsibilities.includes('delegation coordinator and its child producers'));
  await access(evidence);
  await coordinator.release();
  await uncertainOwnership.retire();
  await assert.rejects(access(uncertainRoot), { code: 'ENOENT' });
}
