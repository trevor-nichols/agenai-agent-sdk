// ------------------------------------------------------------------------------------------------
//                directorySymlinks.test.ts - Real host link preservation, selected-root publication and cleanup
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { Sandbox } from '../src/contracts.js';
import type { SandboxExportEntry, SandboxTransferSummary } from '../src/files/types.js';
import { exportSandboxDirectory, importSandboxDirectory, SandboxDirectoryCleanupError } from '../src/node/index.js';
import { SandboxValidationError } from '../src/errors.js';
import { directoryRoot, directorySandbox, exporting, file } from './fixtures/directoryTransfer.js';

async function capturedSource(sandbox: Sandbox, directory: string) {
  const entries: SandboxExportEntry[] = [];
  const receiver: Sandbox = { ...sandbox, async importTree(source, options): Promise<SandboxTransferSummary> {
    assert.equal(options?.symlinks, 'preserve_internal');
    let files = 0n, directories = 0n, symlinks = 0n, payloadBytes = 0n;
    for await (const entry of source) {
      if (entry.kind === 'file') {
        const chunks: Buffer[] = [];
        for await (const bytes of entry.open({ signal: options?.signal ?? new AbortController().signal })) chunks.push(Buffer.from(bytes));
        const bytes = Buffer.concat(chunks);
        entries.push(file(entry.path, bytes, entry.executable)); files += 1n; payloadBytes += BigInt(bytes.length);
      } else {
        entries.push(entry);
        if (entry.kind === 'directory') directories += 1n; else symlinks += 1n;
      }
    }
    return { files, directories, symlinks, payloadBytes, archiveBytes: payloadBytes };
  } };
  return { entries, summary: await importSandboxDirectory(receiver, directory, { symlinks: 'preserve_internal', chunkBytes: 2 }) };
}

async function stagedChild(destination: string): Promise<string> {
  const child = (await readdir(destination)).find((name) => name.startsWith('.staging-'));
  assert(child); return join(destination, child);
}

test('real directory round trips preserve raw parent chains, inert cycles, dangling links, bytes and executable flags', async (t) => {
  const root = await directoryRoot(t), source = join(root, 'source');
  await mkdir(source); await mkdir(join(source, 'nested')); await mkdir(join(source, 'empty'));
  await writeFile(join(source, 'payload.bin'), Uint8Array.of(0, 255, 7, 13));
  await writeFile(join(source, '\uFEFFpayload.bin'), Uint8Array.of(8, 9, 10));
  await writeFile(join(source, 'run'), '#!/bin/sh\n'); await chmod(join(source, 'run'), 0o700);
  await writeFile(join(source, 'é'), 'ok');
  const links = new Map([
    ['alias', 'nested/up'], ['nested/up', '../payload.bin'], ['raw', './nested//../payload.bin'],
    ['dangling', 'not-created/item'], ['cycle-a', 'cycle-b'], ['cycle-b', 'cycle-a'], ['unicode', './é'],
    ['leading-bom', '\uFEFFpayload.bin'], ['\uFEFFalias', 'payload.bin'],
  ]);
  for (const [path, target] of links) await symlink(target, join(source, path));
  const { sandbox } = await directorySandbox(t, true);
  const captured = await capturedSource(sandbox, source);
  assert.deepEqual(captured.summary, { files: 4n, directories: 2n, symlinks: 9n, payloadBytes: 19n, archiveBytes: 19n });
  assert.deepEqual(new Map(captured.entries.filter((entry) => entry.kind === 'symlink').map(({ path, target }) => [path, target])), links);
  const linksFirst = [...captured.entries.filter(({ kind }) => kind === 'symlink'), ...captured.entries.filter(({ kind }) => kind !== 'symlink')];
  const destination = join(root, 'result');
  const result = await exportSandboxDirectory(exporting(sandbox, linksFirst), { kind: 'workspace' }, destination, { symlinks: 'preserve_internal' });
  assert.deepEqual(result.summary, captured.summary);
  assert.deepEqual(await readdir(destination), ['files']);
  for (const [path, target] of links) {
    assert.equal((await lstat(join(result.directory, path))).isSymbolicLink(), true);
    assert.deepEqual(await readlink(join(result.directory, path), { encoding: 'buffer' }), Buffer.from(target));
    assert.deepEqual(await readlink(join(source, path), { encoding: 'buffer' }), Buffer.from(target));
  }
  assert.deepEqual([...await readFile(join(result.directory, 'alias'))], [0, 255, 7, 13]);
  assert.deepEqual([...await readFile(join(result.directory, 'leading-bom'))], [8, 9, 10]);
  assert.equal(await readFile(join(result.directory, 'unicode'), 'utf8'), 'ok');
  assert.equal((await stat(join(result.directory, 'run'))).mode & 0o111, 0o100);
  assert.deepEqual(await readdir(join(result.directory, 'empty')), []);
  await assert.rejects(stat(join(result.directory, 'dangling')), { code: 'ENOENT' });
  await assert.rejects(stat(join(result.directory, 'cycle-a')), { code: 'ELOOP' });
});

test('long raw targets preserve exact bytes when supported and otherwise fail closed at the native limit', async (t) => {
  const root = await directoryRoot(t);
  const target = Array.from({ length: 16 }, () => 'x'.repeat(249)).join('/');
  const rootMetadata = await lstat(root, { bigint: true });
  const probe = join(root, 'native-long');
  const native = await symlink(target, probe).then(() => ({ kind: 'created' as const }), (error: unknown) => {
    assert(error instanceof Error && 'code' in error && 'syscall' in error && 'path' in error);
    assert.equal(error.code, 'ENAMETOOLONG');
    assert.equal(error.syscall, 'symlink');
    assert.equal(error.path, target);
    return { kind: 'rejected' as const, code: error.code, syscall: error.syscall };
  });
  if (native.kind === 'created') {
    assert.deepEqual(await readlink(probe, { encoding: 'buffer' }), Buffer.from(target));
    await unlink(probe);
  } else await assert.rejects(lstat(probe), { code: 'ENOENT' });
  const { sandbox } = await directorySandbox(t, true);
  const publish = (rawTarget: string, destination: string) => exportSandboxDirectory(
    exporting(sandbox, [{ kind: 'symlink', path: 'long', target: rawTarget }]), { kind: 'workspace' }, destination, { symlinks: 'preserve_internal' });
  const destination = join(root, 'result');
  const targetIdentity = { utf8Bytes: Buffer.byteLength(target), sha256: createHash('sha256').update(target).digest('hex'),
    construction: '16 components of 249 ASCII x bytes joined by /' };
  assert.equal(targetIdentity.utf8Bytes, 3999);
  if (native.kind === 'created') {
    const result = await publish(target, destination);
    assert.deepEqual(result.summary, { files: 0n, directories: 0n, symlinks: 1n, payloadBytes: 0n, archiveBytes: 0n });
    assert.equal((await lstat(join(result.directory, 'long'))).size, 3999);
    assert.deepEqual(await readlink(join(result.directory, 'long'), { encoding: 'buffer' }), Buffer.from(target));
    assert.deepEqual(await readdir(destination), ['files']);
    t.diagnostic(JSON.stringify({ root, device: String(rootMetadata.dev), inode: String(rootMetadata.ino), target: targetIdentity,
      native: 'created', sdk: 'published_exact_3999_bytes' }));
  } else {
    await assert.rejects(publish(target, destination), (error: unknown) => {
      assert(error instanceof Error && 'code' in error && 'syscall' in error && 'path' in error);
      assert.equal(error.code, native.code);
      assert.equal(error.syscall, native.syscall);
      assert.equal(error.path, target);
      return true;
    });
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    assert.deepEqual(await readdir(root), [], 'Failed publication must remove its namespace, staging and metadata effects.');
    t.diagnostic(JSON.stringify({ root, device: String(rootMetadata.dev), inode: String(rootMetadata.ino), target: targetIdentity,
      native, sdk: { code: native.code, syscall: native.syscall, targetUnchanged: true, publication: 'absent', ownedEffects: 'removed' } }));
    const supportedTarget = Array.from({ length: 4 }, () => 'x'.repeat(249)).join('/');
    const supported = await publish(supportedTarget, join(root, 'supported-long'));
    assert.deepEqual(supported.summary, { files: 0n, directories: 0n, symlinks: 1n, payloadBytes: 0n, archiveBytes: 0n });
    assert.equal((await lstat(join(supported.directory, 'long'))).size, 999);
    assert.deepEqual(await readlink(join(supported.directory, 'long'), { encoding: 'buffer' }), Buffer.from(supportedTarget));
    assert.deepEqual(await readdir(join(root, 'supported-long')), ['files']);
    t.diagnostic(JSON.stringify({ control: 'independent_999_byte_target', utf8Bytes: Buffer.byteLength(supportedTarget),
      sdk: 'published_exact_bytes', symlinks: '1', payloadBytes: '0' }));
  }
  const after = await lstat(root, { bigint: true });
  assert.equal(after.dev, rootMetadata.dev); assert.equal(after.ino, rootMetadata.ino);
});

test('default, escaping, chained-escape and intermediate-member links leave no complete host publication', async (t) => {
  const root = await directoryRoot(t);
  await writeFile(join(root, 'outside'), 'untouched');
  const { sandbox } = await directorySandbox(t, true);
  const cases: ReadonlyArray<Readonly<{ name: string; preserve: boolean; entries: SandboxExportEntry[] }>> = [
    { name: 'default', preserve: false, entries: [{ kind: 'symlink', path: 'alias', target: 'inside' }] },
    { name: 'absolute', preserve: true, entries: [{ kind: 'symlink', path: 'alias', target: join(root, 'outside') }] },
    { name: 'escape', preserve: true, entries: [{ kind: 'symlink', path: 'alias', target: '../../outside' }] },
    { name: 'chain', preserve: true, entries: [{ kind: 'directory', path: 'dir' },
      { kind: 'symlink', path: 'dir/pivot', target: '..' }, { kind: 'symlink', path: 'escape', target: 'dir/pivot/../outside' }] },
    { name: 'intermediate', preserve: true, entries: [{ kind: 'symlink', path: 'alias', target: 'dir' }, file('alias/payload', Uint8Array.of(7))] },
  ];
  for (const item of cases) {
    const destination = join(root, item.name);
    await assert.rejects(exportSandboxDirectory(exporting(sandbox, item.entries), { kind: 'workspace' }, destination,
      item.preserve ? { symlinks: 'preserve_internal' } : undefined));
    await assert.rejects(lstat(join(destination, 'files')), { code: 'ENOENT' });
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'untouched');
  }
});

test('subtree publication uses the captured selected root even though output keeps workspace-relative paths', async (t) => {
  const root = await directoryRoot(t);
  const { sandbox } = await directorySandbox(t, true);
  const link: SandboxExportEntry = { kind: 'symlink', path: 'pkg/shared', target: '../shared/data' };
  const workspace = await exportSandboxDirectory(exporting(sandbox, [link, { kind: 'directory', path: 'pkg' }, file('shared/data', Buffer.from('shared'))]),
    { kind: 'workspace' }, join(root, 'workspace'), { symlinks: 'preserve_internal' });
  assert.equal(await readFile(join(workspace.directory, 'pkg/shared'), 'utf8'), 'shared');
  const selected = exporting(sandbox, [link, { kind: 'directory', path: 'pkg' }]);
  const checked: Sandbox = { ...selected, async exportTree(selection, consume, options) {
    assert.deepEqual(selection, { kind: 'subtree', path: 'pkg' });
    return selected.exportTree(selection, consume, options);
  } };
  const selection = { kind: 'subtree' as const, path: 'pkg' };
  const destination = join(root, 'subtree');
  const operation = exportSandboxDirectory(checked, selection, destination, { symlinks: 'preserve_internal' });
  selection.path = 'shared';
  await assert.rejects(operation, (error: unknown) => error instanceof SandboxValidationError
    && error.issues.some((issue) => issue.message.includes('target escapes the selected publication root')));
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  assert.equal(await readFile(join(workspace.directory, 'shared/data'), 'utf8'), 'shared');
});

test('late payload failure never installs provisional links and removes every owned staged effect', async (t) => {
  const root = await directoryRoot(t), destination = join(root, 'result');
  const { sandbox } = await directorySandbox(t, true);
  const original = new Error('late payload rejected');
  const selected: Sandbox = { ...sandbox, async exportTree(_selection, consume) {
    const input = { signal: new AbortController().signal };
    await consume({ kind: 'symlink', path: 'alias', target: 'payload' }, input);
    const stage = await stagedChild(destination);
    await assert.rejects(lstat(join(stage, 'alias')), { code: 'ENOENT' });
    await consume({ kind: 'file', path: 'payload', byteLength: 2, executable: false,
      bytes: { async *[Symbol.asyncIterator]() { yield Uint8Array.of(1); throw original; } } }, input);
    throw new Error('Invalid payload unexpectedly completed.');
  } };
  await assert.rejects(exportSandboxDirectory(selected, { kind: 'workspace' }, destination, { symlinks: 'preserve_internal' }),
    (error: unknown) => error === original);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('link-install ownership failure retains cleanup retry without publishing a complete tree', { skip: process.getuid?.() === 0 }, async (t) => {
  const root = await directoryRoot(t), destination = join(root, 'result');
  const { sandbox } = await directorySandbox(t, true);
  const selected = exporting(sandbox, [file('payload', Uint8Array.of(7)), { kind: 'symlink', path: 'alias', target: 'payload' }]);
  let controls = '';
  const restricted: Sandbox = { ...selected, async exportTree(...args) {
    const summary = await selected.exportTree(...args);
    const name = (await readdir(destination)).find((child) => child.startsWith('.metadata-'));
    assert(name); controls = join(destination, name); await chmod(controls, 0o500);
    return summary;
  } };
  t.after(async () => { if (controls) await chmod(controls, 0o700).catch(() => {}); });
  let retained: SandboxDirectoryCleanupError | undefined;
  await assert.rejects(exportSandboxDirectory(restricted, { kind: 'workspace' }, destination, { symlinks: 'preserve_internal' }), (error: unknown) => {
    assert(error instanceof SandboxDirectoryCleanupError); retained = error;
    assert.equal(error.publishedDirectory, undefined); return true;
  });
  assert(retained); const originalCleanup = retained.cleanupError;
  await assert.rejects(lstat(join(destination, 'files')), { code: 'ENOENT' });
  await chmod(controls, 0o700);
  await retained.retryCleanup(); await retained.retryCleanup();
  assert.equal(retained.cleanupError, originalCleanup);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('raw target and filename encodings are rejected by their owning boundary without modifying valid source names', async (t) => {
  const root = await directoryRoot(t);
  const { sandbox } = await directorySandbox(t);
  const targetSource = join(root, 'target-source'); await mkdir(targetSource);
  await symlink(Buffer.from([0xff]), join(targetSource, 'invalid'));
  await assert.rejects(capturedSource(sandbox, targetSource), /valid UTF-8/u);
  assert.deepEqual(await readlink(join(targetSource, 'invalid'), { encoding: 'buffer' }), Buffer.from([0xff]));
  const nameSource = join(root, 'name-source'); await mkdir(nameSource);
  const validName = join(nameSource, 'bad�');
  await writeFile(validName, 'distinct-valid-name', { flag: 'wx' });
  const sentinel = await lstat(validName, { bigint: true });
  const invalidName = Buffer.concat([Buffer.from(`${nameSource}/bad`), Buffer.from([0xff])]);
  const native = await writeFile(invalidName, 'raw-name', { flag: 'wx' }).then(() => ({ kind: 'created' as const }), (error: unknown) => {
    assert(error instanceof Error && 'code' in error && 'syscall' in error);
    assert.equal(error.code, 'EILSEQ');
    assert.equal(error.syscall, 'open');
    return { kind: 'rejected' as const, code: error.code, syscall: error.syscall };
  });
  const names = (await readdir(nameSource, { encoding: 'buffer' })).sort(Buffer.compare);
  if (native.kind === 'created') {
    assert.deepEqual(names, [Buffer.from('bad�'), Buffer.from([0x62, 0x61, 0x64, 0xff])].sort(Buffer.compare));
    await assert.rejects(capturedSource(sandbox, nameSource), /encoded data|encoding/iu);
    assert.equal(await readFile(invalidName, 'utf8'), 'raw-name');
  } else {
    assert.deepEqual(names, [Buffer.from('bad�')], 'The rejected raw name must create no entry or replacement-character alias.');
    const captured = await capturedSource(sandbox, nameSource);
    assert.deepEqual(captured.summary, { files: 1n, directories: 0n, symlinks: 0n, payloadBytes: 19n, archiveBytes: 19n });
    assert.deepEqual(captured.entries.map(({ kind, path }) => ({ kind, path })), [{ kind: 'file', path: 'bad�' }]);
  }
  assert.deepEqual((await readdir(nameSource, { encoding: 'buffer' })).sort(Buffer.compare), names);
  assert.equal(await readFile(validName, 'utf8'), 'distinct-valid-name');
  const after = await lstat(validName, { bigint: true });
  assert.equal(after.dev, sentinel.dev); assert.equal(after.ino, sentinel.ino); assert.equal(after.size, sentinel.size);
  const parent = await lstat(nameSource, { bigint: true });
  t.diagnostic(JSON.stringify({ root: nameSource, device: String(parent.dev), inode: String(parent.ino), rawNameHex: '626164ff',
    replacementNameHex: Buffer.from('bad�').toString('hex'), native,
    sdk: native.kind === 'created' ? 'invalid_filename_rejected_during_traversal' : 'remaining_valid_filename_imported',
    rawTarget: 'invalid_utf8_rejected_by_sdk_without_modification', rawEntryCensus: names.map((name) => name.toString('hex')),
    validSentinel: 'same_inode_and_bytes' }));
});
