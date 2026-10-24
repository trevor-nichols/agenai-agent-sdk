// ------------------------------------------------------------------------------------------------
//                directoryImport.test.ts - Explicit host traversal and descriptor-read behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, rename, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import type { Sandbox } from '../src/contracts.js';
import { SandboxOperationError, SandboxValidationError } from '../src/errors.js';
import type { SandboxTreeEntry } from '../src/files/types.js';
import { importSandboxDirectory } from '../src/node/index.js';
import { directoryRoot, directorySandbox } from './fixtures/directoryTransfer.js';

test('directory import preserves binary, empty, executable and empty-directory entries with caller-sized chunks', async (t) => {
  const root = await directoryRoot(t);
  await mkdir(join(root, 'nested'));
  await mkdir(join(root, 'empty-directory'));
  await writeFile(join(root, 'nested', 'binary'), Uint8Array.of(0, 255, 7, 13, 10));
  await writeFile(join(root, 'empty'), '');
  await writeFile(join(root, 'run'), '#!/bin/sh\n');
  await chmod(join(root, 'run'), 0o700);
  const { sandbox } = await directorySandbox(t);
  const observed: Array<{ kind: string; path: string; executable?: boolean; bytes?: number[] }> = [];
  const consuming: Sandbox = { ...sandbox, async importTree(entries, options) {
    let files = 0n; let directories = 0n; let payloadBytes = 0n;
    for await (const entry of entries) {
      if (entry.kind === 'directory') { observed.push(entry); directories += 1n; continue; }
      const bytes: number[] = [];
      for await (const chunk of entry.open({ signal: options?.signal ?? new AbortController().signal })) {
        assert(chunk.byteLength <= 2);
        bytes.push(...chunk);
      }
      observed.push({ kind: entry.kind, path: entry.path, executable: entry.executable, bytes });
      files += 1n; payloadBytes += BigInt(bytes.length);
    }
    return { files, directories, payloadBytes, archiveBytes: payloadBytes };
  } };
  const summary = await importSandboxDirectory(consuming, root, { chunkBytes: 2 });
  assert.deepEqual(observed.sort((left, right) => left.path.localeCompare(right.path)), [
    { kind: 'file', path: 'empty', executable: false, bytes: [] },
    { kind: 'directory', path: 'empty-directory' },
    { kind: 'directory', path: 'nested' },
    { kind: 'file', path: 'nested/binary', executable: false, bytes: [0, 255, 7, 13, 10] },
    { kind: 'file', path: 'run', executable: true, bytes: [...Buffer.from('#!/bin/sh\n')] },
  ]);
  assert.deepEqual(summary, { files: 3n, directories: 2n, payloadBytes: 15n, archiveBytes: 15n });
  assert.deepEqual((await readdir(root)).sort(), ['empty', 'empty-directory', 'nested', 'run']);
});

test('host imports reject symlink roots, symlink entries and special socket files without reading their targets', async (t) => {
  const root = await directoryRoot(t);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(root, 'outside'), 'outside bytes');
  await symlink(source, join(root, 'root-alias'));
  const { sandbox, physical } = await directorySandbox(t);
  await assert.rejects(importSandboxDirectory(sandbox, join(root, 'root-alias')), SandboxValidationError);
  await symlink(join(root, 'outside'), join(source, 'linked'));
  await assert.rejects(importSandboxDirectory(sandbox, source), (error: unknown) => error instanceof SandboxOperationError && error.code === 'input_limit');
  assert.equal(physical.files.size, 0);

  const other = await directorySandbox(t);
  const socketSource = join(root, 'socket-source');
  await mkdir(socketSource);
  const server = createServer();
  t.after(() => server.close());
  server.listen(join(socketSource, 'socket'));
  await once(server, 'listening');
  await assert.rejects(importSandboxDirectory(other.sandbox, socketSource), /regular files and directories/u);
  assert.equal(other.physical.files.size, 0);
});

for (const mutation of ['replacement', 'shrink', 'grow', 'symlink'] as const) {
  test(`descriptor acquisition detects ${mutation} between entry metadata and file opening`, async (t) => {
    const root = await directoryRoot(t);
    const path = join(root, 'file');
    await writeFile(path, 'original');
    await writeFile(join(root, 'outside'), 'unrelated');
    const { sandbox } = await directorySandbox(t);
    let mutated = false;
    const consuming: Sandbox = { ...sandbox, async importTree(entries, options) {
      for await (const entry of entries) {
        if (entry.kind !== 'file' || entry.path !== 'file') continue;
        if (mutation === 'replacement' || mutation === 'symlink') {
          await rename(path, join(root, 'old-file'));
          if (mutation === 'replacement') await writeFile(path, 'replaced'); else await symlink(join(root, 'outside'), path);
        } else if (mutation === 'shrink') await truncate(path, 2); else await writeFile(path, 'original-plus');
        mutated = true;
        for await (const _chunk of entry.open({ signal: options?.signal ?? new AbortController().signal })) {}
      }
      throw new Error('Mutated file unexpectedly completed.');
    } };
    await assert.rejects(importSandboxDirectory(consuming, root), (error: unknown) =>
      error instanceof SandboxOperationError || (error instanceof Error && 'code' in error && error.code === 'ELOOP'));
    assert.equal(mutated, true);
  });
}

for (const mutation of ['truncate', 'append'] as const) {
  test(`file reads detect ${mutation} after the first actual descriptor chunk`, async (t) => {
    const root = await directoryRoot(t);
    const path = join(root, 'file');
    await writeFile(path, 'abcdef');
    const { sandbox } = await directorySandbox(t);
    let chunks = 0;
    const consuming: Sandbox = { ...sandbox, async importTree(entries, options) {
      for await (const entry of entries) {
        if (entry.kind !== 'file') continue;
        for await (const _chunk of entry.open({ signal: options?.signal ?? new AbortController().signal })) {
          chunks += 1;
          if (chunks === 1) {
            if (mutation === 'truncate') await truncate(path, 1); else await writeFile(path, 'abcdef-more');
          }
        }
      }
      throw new Error('Changed file unexpectedly completed.');
    } };
    await assert.rejects(importSandboxDirectory(consuming, root, { chunkBytes: 2 }), SandboxOperationError);
    assert(chunks >= 1);
  });
}

test('a late open retained after failed import is fenced before new filesystem acquisition', async (t) => {
  const root = await directoryRoot(t);
  await writeFile(join(root, 'file'), 'retained');
  const { sandbox } = await directorySandbox(t);
  let retained: Extract<SandboxTreeEntry, { kind: 'file' }> | undefined;
  const failure = new Error('backend declined import');
  const consuming: Sandbox = { ...sandbox, async importTree(entries) {
    for await (const entry of entries) {
      if (entry.kind === 'file') { retained = entry; throw failure; }
    }
    throw new Error('Missing fixture entry.');
  } };
  await assert.rejects(importSandboxDirectory(consuming, root), (error: unknown) => error === failure);
  assert.ok(retained);
  const entry = retained;
  assert.throws(() => entry.open({ signal: new AbortController().signal }), /once-only|closing/u);
  assert.equal((await stat(join(root, 'file'))).size, 8);
});

test('more than 20,000 real regular files traverse incrementally without a retained input list', { timeout: 60_000 }, async (t) => {
  const root = await directoryRoot(t);
  const count = 20_017;
  for (let offset = 0; offset < count; offset += 32) {
    const batch: Promise<void>[] = [];
    for (let index = offset; index < Math.min(count, offset + 32); index += 1) batch.push(writeFile(join(root, `file-${index}`), Uint8Array.of(index & 255)));
    await Promise.all(batch);
  }
  const { sandbox } = await directorySandbox(t);
  let observed = 0n;
  let sum = 0n;
  let indexSum = 0n;
  const consuming: Sandbox = { ...sandbox, async importTree(entries, options) {
    for await (const entry of entries) {
      assert.equal(entry.kind, 'file');
      if (entry.kind !== 'file') throw new Error('Unexpected directory.');
      const index = Number(entry.path.slice('file-'.length));
      for await (const chunk of entry.open({ signal: options?.signal ?? new AbortController().signal })) {
        assert.deepEqual([...chunk], [index & 255]);
        sum += BigInt(chunk.byteLength);
      }
      observed += 1n;
      indexSum += BigInt(index);
    }
    return { files: observed, directories: 0n, payloadBytes: sum, archiveBytes: sum };
  } };
  assert.deepEqual(await importSandboxDirectory(consuming, root), { files: 20_017n, directories: 0n, payloadBytes: 20_017n, archiveBytes: 20_017n });
  assert.equal(observed, BigInt(count));
  assert.equal(indexSum, BigInt(count) * BigInt(count - 1) / 2n);
});
