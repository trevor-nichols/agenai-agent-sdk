import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, statfs, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { failure } from '../live/evidence.mjs';

const identity = (stat) => ({ device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
  uid: String(stat.uid), gid: String(stat.gid) });

export async function inspectHostRoots(manifest) {
  const roots = [];
  for (const input of manifest.transfers.hostRoots) {
    assert.equal(await realpath(input.parent), input.parent, 'Transfer-root parent must be physical.');
    const stat = await lstat(input.parent, { bigint: true });
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Transfer-root parent must be a no-follow directory.');
    await access(input.parent, constants.R_OK | constants.W_OK | constants.X_OK);
    const fs = await statfs(input.parent, { bigint: true });
    const root = Object.freeze({ role: input.role, parent: input.parent, identity: Object.freeze(identity(stat)),
      filesystem: Object.freeze({ type: String(fs.type), blockBytes: String(fs.bsize), availableBlocks: String(fs.bavail),
        totalBlocks: String(fs.blocks) }) });
    if (manifest.profile !== 'linux-x64') assert(roots.every((prior) => prior.identity.device !== root.identity.device),
      'Desktop transfer-root parents must have distinct filesystem devices.');
    roots.push(root);
  }
  return Object.freeze(roots);
}

export async function assertHostRootCurrent(root) {
  assert.equal(await realpath(root.parent), root.parent, 'Transfer-root parent stopped being physical.');
  const stat = await lstat(root.parent, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.deepEqual(identity(stat), root.identity, 'Transfer-root parent identity or permissions changed.');
  const fs = await statfs(root.parent, { bigint: true });
  assert.equal(String(fs.type), root.filesystem.type, 'Transfer-root filesystem type changed.');
  assert.equal(String(fs.bsize), root.filesystem.blockBytes, 'Transfer-root filesystem block size changed.');
}

export async function acquireHostRoots(context, report, save) {
  const roots = [];
  for (const receipt of context.config.hostRoots) {
    await assertHostRootCurrent(receipt);
    const directory = join(receipt.parent, `platform-preserve-${context.config.fixtureOwner}`);
    const bytes = randomBytes(32);
    const owned = { ...receipt, directory, created: false, identityOwned: null,
      sentinel: { path: join(directory, 'caller-sentinel'), bytesBase64: bytes.toString('base64'), identity: null, removed: false }, removed: false };
    report.hostRoots.push(owned); await save();
    await mkdir(directory, { mode: 0o700 }); owned.created = true;
    owned.identityOwned = identity(await lstat(directory, { bigint: true })); await save();
    await writeFile(owned.sentinel.path, bytes, { flag: 'wx', mode: 0o600 });
    owned.sentinel.identity = identity(await lstat(owned.sentinel.path, { bigint: true })); await save();
    roots.push(owned);
  }
  return roots;
}

export async function verifyHostRoot(root) {
  await assertHostRootCurrent(root);
  assert.deepEqual(identity(await lstat(root.directory, { bigint: true })), root.identityOwned, 'Owned transfer-root identity changed.');
  assert.deepEqual(identity(await lstat(root.sentinel.path, { bigint: true })), root.sentinel.identity, 'Caller sentinel identity changed.');
  assert.deepEqual(await readFile(root.sentinel.path), Buffer.from(root.sentinel.bytesBase64, 'base64'), 'Caller sentinel bytes changed.');
}

export async function acquireCaseHost(run, variant) {
  await verifyHostRoot(variant.hostRoot);
  run.hostRoot = variant.hostRoot;
  run.hostDirectory = join(variant.hostRoot.directory, run.caseId);
  run.evidence.host = { role: variant.hostRoot.role, layout: variant.layout, directory: run.hostDirectory,
    parent: variant.hostRoot.parent, parentIdentity: variant.hostRoot.identity, created: false, identity: null, removed: false };
  await run.save();
  await mkdir(run.hostDirectory, { mode: 0o700 }); run.evidence.host.created = true;
  run.evidence.host.identity = identity(await lstat(run.hostDirectory, { bigint: true })); await run.save();
}

export async function cleanupCaseHost(run) {
  if (!run.evidence.host?.created) return;
  await verifyHostRoot(run.hostRoot);
  assert.deepEqual(identity(await lstat(run.hostDirectory, { bigint: true })), run.evidence.host.identity,
    'Case host directory identity changed; preserve it for its original owner.');
  await rm(run.hostDirectory, { recursive: true });
  await assert.rejects(lstat(run.hostDirectory), { code: 'ENOENT' });
  run.evidence.host.removed = true;
}

export async function cleanupHostRoots(report, save, casesClosed) {
  const failures = [];
  for (const root of [...report.hostRoots].reverse()) {
    if (!root.created || root.removed) continue;
    try {
      assert(casesClosed, 'Retain host roots until every entered case owner has settled.');
      await assertHostRootCurrent(root);
      assert.deepEqual(identity(await lstat(root.directory, { bigint: true })), root.identityOwned, 'Owned transfer-root identity changed.');
      if (root.sentinel.identity === null) {
        // Acquisition never admitted a caller sentinel or case; only this fresh private namespace is owned.
        await rm(root.directory, { recursive: true });
      } else {
        if (!root.sentinel.removed) {
          await verifyHostRoot(root);
          assert.deepEqual(await readdir(root.directory), ['caller-sentinel'], 'Unsettled host effects remain owned.');
          await unlink(root.sentinel.path); root.sentinel.removed = true; await save();
        }
        assert.deepEqual(await readdir(root.directory), [], 'Unexpected host effects remain owned.');
        await rmdir(root.directory);
      }
      await assert.rejects(lstat(root.directory), { code: 'ENOENT' }); root.removed = true;
      await assertHostRootCurrent(root);
    } catch (error) { failures.push({ directory: root.directory, ...failure(error) }); }
    await save();
  }
  return { complete: failures.length === 0 && report.hostRoots.every(({ created, removed }) => !created || removed), failures };
}
