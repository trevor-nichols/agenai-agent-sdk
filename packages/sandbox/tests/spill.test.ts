// ------------------------------------------------------------------------------------------------
//                spill.test.ts - Explicit native spill admission and physical ownership lifecycle
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SandboxStateError, SandboxValidationError } from '../src/errors.js';
import { createSandboxSpillStore, parseSandboxSpillDirectory, verifySandboxSpillDirectory } from '../src/node/index.js';
import { spillDescriptors, spillDirectory } from './fixtures/metadataSpill.js';
import { capturedSpillFiles, parseLsofDescriptors } from './fixtures/darwinSpill.js';

test('lsof field observations preserve exact descriptor identities without relying on deleted names', () => {
  const output = 'p4123\0\nf12\0tREG\0D0x1000006\0i9007199254740993\0k0\0s65\0n/ (APFS)\0\nf13\0tREG\0D0x1000006\0i42\0k0\0s0\0\n';
  assert.deepEqual(parseLsofDescriptors(output, 4123), [
    { descriptor: 12, device: '16777222', inode: '9007199254740993', links: 0, bytes: 65, target: '/ (APFS)' },
    { descriptor: 13, device: '16777222', inode: '42', links: 0, bytes: 0, target: '' },
  ]);
  assert.throws(() => parseLsofDescriptors(output, 9999), /different process/u);
  assert.throws(() => parseLsofDescriptors(output.slice(0, -1), 4123), /Truncated/u);
  assert.throws(() => parseLsofDescriptors(output.replace('i42\0', ''), 4123), /inode/u);
  assert.throws(() => parseLsofDescriptors(output.replace('k0\0', 'k0\0k0\0'), 4123), /Repeated/u);
});

test('explicit canonical directory admission rejects discovery and symlinks without changing caller files', async (t) => {
  const directory = await spillDirectory(t);
  const sentinel = join(directory, 'caller-sentinel');
  await writeFile(sentinel, 'retain this caller file');
  const alias = `${directory}-alias`;
  await symlink(directory, alias);
  t.after(() => unlink(alias));
  for (const value of [undefined, 'relative', `${directory}/`, `${directory}/../elsewhere`, `${directory}//child`]) {
    assert.throws(() => parseSandboxSpillDirectory(value), SandboxValidationError);
  }
  assert.equal(parseSandboxSpillDirectory(directory), directory);
  await verifySandboxSpillDirectory(directory);
  await assert.rejects(createSandboxSpillStore({ directory: alias }), SandboxValidationError);
  await assert.rejects(createSandboxSpillStore({ directory: sentinel }), SandboxValidationError);
  assert.deepEqual(await readdir(directory), ['caller-sentinel']);
  assert.equal(await readFile(sentinel, 'utf8'), 'retain this caller file');
});

test('four anonymous files preserve exact positional bytes, truncation and bounded acquisition', async (t) => {
  const directory = await spillDirectory(t);
  const store = await createSandboxSpillStore({ directory });
  t.after(() => store.close());
  const files = [];
  for (let index = 0; index < 4; index += 1) files.push(await store.createFile());
  await assert.rejects(store.createFile(), SandboxStateError);
  const file = files[0];
  assert.ok(file);
  const bytes = Uint8Array.of(0, 255, 65, 7);
  assert.deepEqual(await file.write(bytes, 1, 2, 0), { bytesWritten: 2 });
  const output = new Uint8Array(4);
  assert.deepEqual(await file.read(output, 1, 2, 0), { bytesRead: 2 });
  assert.deepEqual([...output], [0, 255, 65, 0]);
  assert.throws(() => file.write(bytes, 0, 2, Number.MAX_SAFE_INTEGER), RangeError);
  assert.throws(() => file.read(output, 3, 2, 0), RangeError);
  assert.throws(() => file.truncate(-1), RangeError);
  await file.truncate(1);
  assert.deepEqual(await file.read(output, 0, 4, 0), { bytesRead: 1 });
  assert.deepEqual(await readdir(directory), []);
  if (process.platform === 'linux') {
    const owned = await spillDescriptors(directory);
    assert.equal(owned.length, 4);
    assert(owned.every((value) => value.links === 0));
  }
  await file.close();
  const replacement = await store.createFile();
  assert.deepEqual(await replacement.write(Uint8Array.of(23), 0, 1, 0), { bytesWritten: 1 });
  await store.close();
  await store.close();
  assert.throws(() => store.createFile(), SandboxStateError);
  assert.throws(() => replacement.read(output, 0, 1, 0), SandboxStateError);
  if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(directory), []);
});

test('store close joins an entered native write before releasing its exact file', async (t) => {
  const directory = await spillDirectory(t);
  const store = await createSandboxSpillStore({ directory });
  const file = await store.createFile();
  const written = file.write(new Uint8Array(64 * 1024), 0, 64 * 1024, 0);
  const closing = store.close();
  assert.deepEqual(await written, { bytesWritten: 64 * 1024 });
  await closing;
  assert.deepEqual(await readdir(directory), []);
  if (process.platform === 'linux') assert.deepEqual(await spillDescriptors(directory), []);
});

test('controller death releases four unlinked production spill files and preserves caller storage', {
  skip: process.platform !== 'linux' && process.platform !== 'darwin', timeout: 15_000,
}, async (t) => {
  const directory = await spillDirectory(t);
  await writeFile(join(directory, 'caller-sentinel'), 'retain this caller file');
  const child = fork(fileURLToPath(new URL('./fixtures/spill-controller.ts', import.meta.url)), [directory], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  });
  const [ready] = await once(child, 'message');
  assert.ok(child.pid);
  const pid = child.pid;
  const files = process.platform === 'darwin' ? capturedSpillFiles(ready, directory) : undefined;
  if (process.platform === 'linux') assert.deepEqual(ready, { kind: 'spill_held' });
  const owned = await spillDescriptors(directory, pid, files);
  assert.equal(owned.length, 4);
  assert(owned.every((value) => value.links === 0));
  if (process.platform === 'linux') assert(owned.every((value) => value.target.endsWith(' (deleted)')));
  else t.diagnostic(JSON.stringify({ observer: 'darwin-lsof-own-child', pid, files, observed: owned }));
  assert(owned.some((value) => value.bytes > 0));
  assert.deepEqual(await readdir(directory), ['caller-sentinel']);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  if (process.platform === 'linux') await assert.rejects(stat(`/proc/${pid}/fd`), { code: 'ENOENT' });
  else assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await readdir(directory), ['caller-sentinel']);
  assert.equal(await readFile(join(directory, 'caller-sentinel'), 'utf8'), 'retain this caller file');
});
