import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { openAcpInstallationStore } from '../src/node/install/index.js';
import { AcpInstallationError } from '../src/node/install/errors.js';
import { fixturePlan, installedIdentity, readRetainedReceipt, storeFixture } from './fixtures/install-store/index.js';
import { tarFixture } from './fixtures/install-binary/index.js';

const installationError = (code: AcpInstallationError['code']) => (error: unknown) => error instanceof AcpInstallationError && error.code === code;

test('a real binary install publishes immutable complete evidence, resolves offline under a persisted reference, and removes only after exact release', async () => {
  const fixture = await storeFixture();
  try {
    const store = await openAcpInstallationStore({ root: fixture.root });
    const receipt = await store.install(fixture.installInput);
    const identity = installedIdentity(fixture.plan, receipt.installationId);
    assert.equal(receipt.prepared.artifacts[0]?.expectedSha256, fixture.plan.expectedIntegrity.sha256);
    assert.equal(receipt.prepared.artifacts[0]?.measuredSha256, fixture.plan.expectedIntegrity.sha256);
    assert.equal(receipt.payload.some((entry) => entry.path === 'lib/dependencies/config.json' && entry.kind === 'file'), true);
    assert.equal(receipt.publication, process.platform === 'win32' ? 'atomic-rename' : 'synced-rename');
    assert.equal(Object.isFrozen(receipt.prepared.launch), true);
    const retainedBytes = await readRetainedReceipt(fixture.root, fixture.plan);
    const repeated = await store.install({ plan: fixture.plan, expectedPlanDigest: fixture.plan.digest });
    assert.equal(repeated.installationId, receipt.installationId);
    assert.equal(await readRetainedReceipt(fixture.root, fixture.plan), retainedBytes);
    const reference = await store.acquire({ ...identity, ownerId: 'consumer:session-1' });
    const reopened = await openAcpInstallationStore({ root: fixture.root });
    const launch = await reopened.resolveLaunch(reference);
    assert.equal(launch.shell, false);
    assert.deepEqual(launch.env, {});
    assert.deepEqual(launch.args, ['literal;$(never-execute)']);
    if (process.platform !== 'win32') {
      const result = await promisify(execFile)(launch.executable, [...launch.args], { env: launch.env });
      assert.equal(result.stdout, 'store-fixture:literal;$(never-execute)\n');
    }
    await assert.rejects(reopened.remove(identity), installationError('reference_active'));
    await assert.rejects(reopened.release({ ...reference, ownerId: 'consumer:other' }), installationError('reference_mismatch'));
    await reopened.release(reference);
    await assert.rejects(store.resolveLaunch(reference), installationError('reference_mismatch'));
    await reopened.remove(identity);
    await assert.rejects(store.read(identity), installationError('installation_not_found'));
    assert.deepEqual(await readdir(path.join(fixture.root, 'stages')), []);
    assert.deepEqual(await readdir(path.join(fixture.root, 'locks')), []);
  } finally { await fixture.cleanup(); }
});

test('an update uses a distinct plan installation and leaves the previous referenced generation usable', async () => {
  const fixture = await storeFixture();
  try {
    const store = await openAcpInstallationStore({ root: fixture.root });
    const first = await store.install(fixture.installInput);
    const firstIdentity = installedIdentity(fixture.plan, first.installationId);
    const reference = await store.acquire({ ...firstIdentity, ownerId: 'old-generation' });
    const nextPlan = fixturePlan(fixture.archive, { args: ['next-generation'] });
    const next = await store.install({ plan: nextPlan, expectedPlanDigest: nextPlan.digest, localArtifacts: fixture.installInput.localArtifacts });
    assert.notEqual(next.installationId, first.installationId);
    assert.deepEqual((await store.resolveLaunch(reference)).args, ['literal;$(never-execute)']);
    await store.remove(installedIdentity(nextPlan, next.installationId));
    assert.equal((await store.read(firstIdentity)).installationId, first.installationId);
    await store.release(reference);
    await store.remove(firstIdentity);
  } finally { await fixture.cleanup(); }
});

for (const mutation of ['nested dependency', 'unrecorded file', 'permission bits', 'hardlink alias', 'escaping symlink'] as const) {
  test(`offline verification rejects a changed ${mutation} before resolving a launch`, async () => {
    const fixture = await storeFixture();
    try {
      const store = await openAcpInstallationStore({ root: fixture.root });
      const receipt = await store.install(fixture.installInput);
      const identity = installedIdentity(fixture.plan, receipt.installationId);
      const reference = await store.acquire({ ...identity, ownerId: 'tamper-proof' });
      const payload = path.join(fixture.root, 'installations', fixture.plan.digest.slice(7), 'payload');
      if (mutation === 'nested dependency') await writeFile(path.join(payload, 'lib/dependencies/config.json'), '{"nested":"changed"}');
      if (mutation === 'unrecorded file') await writeFile(path.join(payload, 'extra'), 'unrecorded');
      if (mutation === 'permission bits') await chmod(path.join(payload, 'bin/agent'), 0o644);
      if (mutation === 'hardlink alias') await link(path.join(payload, 'bin/agent'), path.join(fixture.directory, 'alias'));
      if (mutation === 'escaping symlink') await symlink('../../../outside', path.join(payload, 'escape'));
      await assert.rejects(store.resolveLaunch(reference), installationError('payload_changed'));
      await store.release(reference);
      await store.remove(identity);
    } finally { await fixture.cleanup(); }
  });
}

test('contained symlink launch paths retain link evidence and remain verifiable without following links during inventory', async () => {
  const fixture = await storeFixture();
  try {
    const archive = await tarFixture([{ name: 'actual/agent', content: '#!/bin/sh\nprintf linked\n', mode: 0o755 },
      { name: 'bin/agent', type: 'symlink', linkname: '../actual/agent' }]);
    await writeFile(fixture.artifactPath, archive);
    const plan = fixturePlan(archive);
    const store = await openAcpInstallationStore({ root: fixture.root });
    const receipt = await store.install({ plan, expectedPlanDigest: plan.digest, localArtifacts: [{ path: fixture.artifactPath, sha256: plan.expectedIntegrity.sha256 }] });
    assert.equal(receipt.payload.some((entry) => entry.kind === 'symlink' && entry.path === 'bin/agent' && entry.target === '../actual/agent'), true);
    const reference = await store.acquire({ ...installedIdentity(plan, receipt.installationId), ownerId: 'contained-link' });
    assert.equal((await store.resolveLaunch(reference)).executable.endsWith(path.join('payload', 'bin', 'agent')), true);
    await store.release(reference);
  } finally { await fixture.cleanup(); }
});

test('actual retained link chains exceeding the configured traversal depth fail within that bound', async () => {
  const fixture = await storeFixture();
  try {
    const store = await openAcpInstallationStore({ root: fixture.root, limits: { maxPathDepth: 8 } });
    const receipt = await store.install(fixture.installInput);
    const identity = installedIdentity(fixture.plan, receipt.installationId);
    const reference = await store.acquire({ ...identity, ownerId: 'bounded-links' });
    const payload = path.join(fixture.root, 'installations', fixture.plan.digest.slice(7), 'payload');
    for (let index = 0; index < 64; index++) await symlink(index === 63 ? 'bin/agent' : `link-${index + 1}`, path.join(payload, `link-${index}`));
    await assert.rejects(store.resolveLaunch(reference), installationError('limit_exceeded'));
    await store.release(reference);
    await store.remove(identity);
  } finally { await fixture.cleanup(); }
});

test('unknown and corrupted retained receipts fail closed instead of granting launch or deletion authority', async () => {
  const fixture = await storeFixture();
  try {
    const store = await openAcpInstallationStore({ root: fixture.root });
    const receipt = await store.install(fixture.installInput);
    const identity = installedIdentity(fixture.plan, receipt.installationId);
    const file = path.join(fixture.root, 'installations', fixture.plan.digest.slice(7), 'receipt.json');
    const original = await readFile(file, 'utf8');
    await assert.rejects(store.read({ ...identity, installationId: `sha256:${'0'.repeat(64)}` }), installationError('installation_mismatch'));
    for (const corrupted of [
      original.replace('"installedAt":"', '"installedAt":"2000-01-01T00:00:00.000Z","unknown":"'),
      original.replace('"format":"acp-registry-installation-v1"', '"format":"acp-registry-installation-v1","format":"acp-registry-installation-v1"'),
      original.slice(0, -1),
    ]) {
      await writeFile(file, corrupted);
      await assert.rejects(store.read(identity), installationError('installation_mismatch'));
      await assert.rejects(store.remove(identity), installationError('installation_mismatch'));
    }
    await writeFile(file, original);
    assert.equal((await store.read(identity)).installationId, receipt.installationId);
  } finally { await fixture.cleanup(); }
});

test('foreign roots, root links, and replacement ancestors never gain owned-store mutation authority', async () => {
  const fixture = await storeFixture();
  try {
    const foreign = path.join(fixture.directory, 'foreign');
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(path.join(foreign, 'sentinel'), 'preserve');
    await assert.rejects(openAcpInstallationStore({ root: foreign }), installationError('store_invalid'));
    await symlink(foreign, fixture.root, 'dir');
    await assert.rejects(openAcpInstallationStore({ root: fixture.root }), installationError('store_invalid'));
    const parent = path.join(fixture.directory, 'parent');
    await mkdir(parent);
    const root = path.join(parent, 'owned');
    const store = await openAcpInstallationStore({ root });
    const receipt = await store.install(fixture.installInput);
    if (process.platform !== 'win32') {
      await chmod(root, 0o755);
      await assert.rejects(store.read(installedIdentity(fixture.plan, receipt.installationId)), installationError('store_invalid'));
      await chmod(root, 0o700);
    }
    await rename(parent, path.join(fixture.directory, 'retired-parent'));
    await symlink(foreign, parent, 'dir');
    await assert.rejects(store.remove(installedIdentity(fixture.plan, receipt.installationId)), installationError('store_invalid'));
    assert.equal(await readFile(path.join(foreign, 'sentinel'), 'utf8'), 'preserve');
    assert.deepEqual(await readdir(foreign), ['sentinel']);
  } finally { await fixture.cleanup(); }
});
