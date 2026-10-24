// ------------------------------------------------------------------------------------------------
//                directoryExport.test.ts - Provisional publication, native aliases and exact cleanup
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import type { Sandbox } from '../src/contracts.js';
import type { SandboxExportConsumer } from '../src/files/types.js';
import { exportSandboxDirectory, SandboxDirectoryCleanupError } from '../src/node/index.js';
import { directoryRoot, directorySandbox, exporting, file } from './fixtures/directoryTransfer.js';

async function privateChild(destination: string, prefix: string): Promise<string> {
  const names = await readdir(destination);
  const name = names.find((candidate) => candidate.startsWith(prefix));
  assert.ok(name, `Expected ${prefix} child`);
  return join(destination, name);
}

test('directory export publishes only complete binary files, executable flags and nested/empty directories', async (t) => {
  const root = await directoryRoot(t);
  const destination = join(root, 'result');
  const { sandbox, physical } = await directorySandbox(t, true);
  const selected = exporting(sandbox, [
    { kind: 'directory', path: 'empty' }, { kind: 'directory', path: 'nested' },
    file('nested/binary', Uint8Array.of(0, 255, 7)), file('zero', new Uint8Array()), file('run', Uint8Array.of(35, 33, 10), true),
  ]);
  const result = await exportSandboxDirectory(selected, { kind: 'workspace' }, destination);
  assert.equal(result.directory, join(destination, 'files'));
  assert.deepEqual(result.summary, { files: 3n, directories: 2n, payloadBytes: 6n, archiveBytes: 6n });
  assert.deepEqual(await readdir(destination), ['files']);
  assert.deepEqual((await readdir(result.directory)).sort(), ['empty', 'nested', 'run', 'zero']);
  assert.deepEqual([...await readFile(join(result.directory, 'nested/binary'))], [0, 255, 7]);
  assert.equal((await stat(join(result.directory, 'zero'))).size, 0);
  assert.deepEqual(await readdir(join(result.directory, 'empty')), []);
  assert.equal((await stat(join(result.directory, 'run'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(result.directory, 'nested/binary'))).mode & 0o777, 0o600);
  assert.deepEqual([...physical.resources], ['storage']);
});

test('existing destinations and simultaneous SDK claims are never overwritten or merged', async (t) => {
  const root = await directoryRoot(t);
  const { sandbox } = await directorySandbox(t, true);
  let exports = 0;
  const selected = exporting(sandbox, [file('artifact', Uint8Array.of(23))]);
  const counted: Sandbox = { ...selected, exportTree(...args) { exports += 1; return selected.exportTree(...args); } };
  const existing = join(root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'caller'), 'keep');
  await assert.rejects(exportSandboxDirectory(counted, { kind: 'workspace' }, existing), { code: 'EEXIST' });
  assert.equal(exports, 0);
  assert.equal(await readFile(join(existing, 'caller'), 'utf8'), 'keep');
  const destination = join(root, 'shared');
  const results = await Promise.allSettled([
    exportSandboxDirectory(counted, { kind: 'workspace' }, destination),
    exportSandboxDirectory(counted, { kind: 'workspace' }, destination),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(exports, 1);
  assert.deepEqual([...await readFile(join(destination, 'files/artifact'))], [23]);
  assert.deepEqual(await readdir(destination), ['files']);
});

for (const primary of [undefined, null, false, 0, new Error('late archive framing failed')]) {
  test(`late failure ${String(primary)} removes local stage and preserves original failure truth`, async (t) => {
    const root = await directoryRoot(t);
    const destination = join(root, 'result');
    const { sandbox, physical } = await directorySandbox(t, true);
    const selected = exporting(sandbox, [file('artifact', Uint8Array.of(17))]);
    const failing: Sandbox = { ...selected, async exportTree(...args) { await selected.exportTree(...args); throw primary; } };
    await assert.rejects(exportSandboxDirectory(failing, { kind: 'workspace' }, destination), (error: unknown) => Object.is(error, primary));
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    assert.deepEqual([...physical.resources], ['storage']);
  });
}

test('an export observation failure joins entered sink work and fences future callbacks before cleanup', { timeout: 3000 }, async (t) => {
  const root = await directoryRoot(t);
  const destination = join(root, 'result');
  const { sandbox } = await directorySandbox(t, true);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = new Error('observation expired');
  let retained: SandboxExportConsumer | undefined;
  const failing: Sandbox = { ...sandbox, async exportTree(_selection, consume) {
    retained = consume;
    const actual = consume({ kind: 'file', path: 'artifact', byteLength: 1, executable: false,
      bytes: { async *[Symbol.asyncIterator]() { entered.resolve(); await release.promise; yield Uint8Array.of(7); } },
    }, { signal: new AbortController().signal });
    void actual.catch(() => {});
    await entered.promise;
    throw original;
  } };
  let settled = false;
  const operation = exportSandboxDirectory(failing, { kind: 'workspace' }, destination);
  t.after(async () => { release.resolve(); await operation.catch(() => {}); });
  void operation.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(operation, (error: unknown) => error === original);
  await entered.promise;
  await nextTurn();
  assert.equal(settled, false);
  assert((await stat(destination)).isDirectory());
  release.resolve();
  await rejected;
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  assert.ok(retained);
  const callback = retained;
  await assert.rejects(callback(file('late', Uint8Array.of(1)), { signal: new AbortController().signal }), /closed/u);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('directory case and Unicode aliases either remain distinct or fail without merging', async (t) => {
  const root = await directoryRoot(t);
  const { sandbox } = await directorySandbox(t, true);
  for (const [name, first, second] of [['case', 'A', 'a'], ['unicode', 'é', 'é']] as const) {
    const probe = join(root, `${name}-probe`);
    await mkdir(probe);
    await mkdir(join(probe, first));
    let aliased = false;
    try {
      const left = await lstat(join(probe, first), { bigint: true });
      const right = await lstat(join(probe, second), { bigint: true });
      aliased = left.dev === right.dev && left.ino === right.ino;
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const destination = join(root, name);
    const operation = exportSandboxDirectory(exporting(sandbox, [file(`${first}/one`, Uint8Array.of(1)), file(`${second}/two`, Uint8Array.of(2))]),
      { kind: 'workspace' }, destination);
    if (aliased) {
      await assert.rejects(operation, /aliases/u);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
    } else {
      const result = await operation;
      assert.deepEqual([...await readFile(join(result.directory, first, 'one'))], [1]);
      assert.deepEqual([...await readFile(join(result.directory, second, 'two'))], [2]);
      assert.notEqual((await lstat(join(result.directory, first), { bigint: true })).ino,
        (await lstat(join(result.directory, second), { bigint: true })).ino);
    }
  }
});

for (const mutation of ['unknown', 'replacement', 'published-collision'] as const) {
  test(`${mutation} is preserved when exact local cleanup cannot prove ownership`, async (t) => {
    const root = await directoryRoot(t);
    const destination = join(root, 'result');
    const { sandbox } = await directorySandbox(t, true);
    const original = new Error('export rejected after foreign mutation');
    let stage = '';
    const saved = join(root, 'saved-owned');
    const selected = exporting(sandbox, [file('artifact', Uint8Array.of(17))]);
    const failing: Sandbox = { ...selected, async exportTree(...args) {
      const summary = await selected.exportTree(...args);
      stage = await privateChild(destination, '.staging-');
      if (mutation === 'unknown') await writeFile(join(stage, 'foreign'), 'keep foreign');
      else if (mutation === 'replacement') {
        await rename(join(stage, 'artifact'), saved);
        await writeFile(join(stage, 'artifact'), 'keep replacement');
      } else { await mkdir(join(destination, 'files')); return summary; }
      throw original;
    } };
    let retained: SandboxDirectoryCleanupError | undefined;
    await assert.rejects(exportSandboxDirectory(failing, { kind: 'workspace' }, destination), (error: unknown) => {
      assert.ok(error instanceof SandboxDirectoryCleanupError);
      retained = error;
      if (mutation !== 'published-collision') assert.equal(error.primaryError, original);
      assert.equal(error.publishedDirectory, undefined);
      return true;
    });
    assert.ok(retained);
    const owner = retained;
    if (mutation === 'unknown') {
      assert.equal(await readFile(join(stage, 'foreign'), 'utf8'), 'keep foreign');
      await unlink(join(stage, 'foreign'));
    } else if (mutation === 'replacement') {
      assert.equal(await readFile(join(stage, 'artifact'), 'utf8'), 'keep replacement');
      assert.deepEqual([...await readFile(saved)], [17]);
      await unlink(join(stage, 'artifact'));
      await rename(saved, join(stage, 'artifact'));
    } else {
      assert.deepEqual(await readdir(join(destination, 'files')), []);
      await rmdir(join(destination, 'files'));
    }
    await owner.retryCleanup();
    await owner.retryCleanup();
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    if (mutation !== 'published-collision') assert.equal(owner.primaryError, original);
  });
}

test('post-publication cleanup failure reports committed data and retry preserves it', {
  skip: process.getuid?.() === 0,
}, async (t) => {
  const root = await directoryRoot(t);
  const destination = join(root, 'result');
  const { sandbox } = await directorySandbox(t, true);
  let metadata = '';
  const selected = exporting(sandbox, [file('artifact', Uint8Array.of(23))]);
  const restricted: Sandbox = { ...selected, async exportTree(...args) {
    const summary = await selected.exportTree(...args);
    metadata = await privateChild(destination, '.metadata-');
    await chmod(metadata, 0o500);
    return summary;
  } };
  t.after(async () => { if (metadata) await chmod(metadata, 0o700).catch(() => {}); });
  let retained: SandboxDirectoryCleanupError | undefined;
  await assert.rejects(exportSandboxDirectory(restricted, { kind: 'workspace' }, destination), (error: unknown) => {
    assert.ok(error instanceof SandboxDirectoryCleanupError);
    retained = error;
    assert.equal(error.primaryError, undefined);
    assert.equal(error.publishedDirectory, join(destination, 'files'));
    return true;
  });
  assert.ok(retained);
  assert.deepEqual([...await readFile(join(destination, 'files/artifact'))], [23]);
  const cleanup = retained.cleanupError;
  await chmod(metadata, 0o700);
  await retained.retryCleanup();
  assert.equal(retained.cleanupError, cleanup);
  assert.deepEqual(await readdir(destination), ['files']);
  assert.deepEqual([...await readFile(join(destination, 'files/artifact'))], [23]);
});

test('an expected staged file removed before publication fails instead of publishing an incomplete tree', async (t) => {
  const root = await directoryRoot(t);
  const destination = join(root, 'result');
  const { sandbox } = await directorySandbox(t, true);
  const selected = exporting(sandbox, [file('artifact', Uint8Array.of(23))]);
  const removing: Sandbox = { ...selected, async exportTree(...args) {
    const summary = await selected.exportTree(...args);
    await unlink(join(await privateChild(destination, '.staging-'), 'artifact'));
    return summary;
  } };
  await assert.rejects(exportSandboxDirectory(removing, { kind: 'workspace' }, destination), { code: 'ENOENT' });
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});
