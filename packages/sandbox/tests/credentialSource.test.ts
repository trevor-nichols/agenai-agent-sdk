// ------------------------------------------------------------------------------------------------
//                credentialSource.test.ts - Real private-source admission and stable read ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { chmod, link, open, readFile, rename, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { readSandboxCredentialFile } from '../src/node/credentials/source.js';
import { spillDirectory } from './fixtures/metadataSpill.js';

const syntheticBytes = Uint8Array.of(0, 255, 34, 10, 65, 0, 123, 125);

function redactedSourceError(error: unknown): boolean {
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, 'Sandbox credential source is unavailable or invalid.');
  assert.equal(error.cause, undefined);
  return true;
}

async function observeRead(t: TestContext, path: string, afterFirstRead?: () => Promise<void> | void): Promise<() => FileHandle> {
  const probe = await open(path, 'r');
  const prototype: FileHandle = Object.getPrototypeOf(probe);
  const read = prototype.read;
  await probe.close();
  let observed: FileHandle | undefined;
  t.mock.method(prototype, 'read', async function (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) {
    const result = await read.call(this, { buffer, offset, length, position });
    if (!observed) { observed = this; await afterFirstRead?.(); }
    return result;
  });
  return () => { assert.ok(observed); return observed; };
}

test('private bounded source bytes are caller-owned and the host file and permissions remain unchanged', async (t) => {
  const directory = await spillDirectory(t);
  const path = join(directory, 'selected-auth.json');
  await writeFile(path, syntheticBytes, { mode: 0o600 });
  const before = await stat(path, { bigint: true });
  const descriptor = await observeRead(t, path);
  const result = await readSandboxCredentialFile({ path });
  assert.deepEqual(result, syntheticBytes);
  await assert.rejects(descriptor().stat(), { code: 'EBADF' });
  result.fill(0);
  assert.deepEqual(await readFile(path), Buffer.from(syntheticBytes));
  const after = await stat(path, { bigint: true });
  assert.equal(after.mode, before.mode);
  assert.equal(after.uid, before.uid);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
});

test('source admission rejects noncanonical paths, links, public permissions and invalid lengths with the same redacted error', async (t) => {
  const directory = await spillDirectory(t);
  const path = join(directory, 'selected-auth.json');
  await writeFile(path, syntheticBytes, { mode: 0o600 });
  const linked = join(directory, 'linked-auth.json');
  const alias = join(directory, 'alias');
  await symlink(path, linked);
  await symlink(directory, alias);
  for (const invalid of ['relative', `${directory}//selected-auth.json`, `${directory}/./selected-auth.json`, `${path}/`,
    `${path}\0`, join(directory, 'missing-secret-source'), directory, linked, join(alias, 'selected-auth.json')]) {
    await assert.rejects(readSandboxCredentialFile({ path: invalid }), redactedSourceError);
  }
  const hardlink = join(directory, 'hardlink');
  await link(path, hardlink);
  await assert.rejects(readSandboxCredentialFile({ path }), redactedSourceError);
  const other = join(directory, 'other');
  await writeFile(other, syntheticBytes, { mode: 0o600 });
  for (const mode of [0o640, 0o604, 0o7000 | 0o600]) {
    await chmod(other, mode);
    await assert.rejects(readSandboxCredentialFile({ path: other }), redactedSourceError);
  }
  await chmod(other, 0o600);
  for (const length of [0, 65_537]) {
    await writeFile(other, new Uint8Array(length));
    await assert.rejects(readSandboxCredentialFile({ path: other }), redactedSourceError);
  }
  for (const length of [1, 65_536]) {
    const bytes = new Uint8Array(length).fill(127);
    await writeFile(other, bytes);
    assert.deepEqual(await readSandboxCredentialFile({ path: other }), bytes);
  }
  assert.deepEqual(await readFile(path), Buffer.from(syntheticBytes));
});

for (const mutation of ['replacement', 'truncation', 'growth', 'modification'] as const) {
  test(`an observed source ${mutation} rejects the snapshot and closes the entered handle`, async (t) => {
    const directory = await spillDirectory(t);
    const path = join(directory, 'selected-auth.json');
    await writeFile(path, syntheticBytes, { mode: 0o600 });
    const descriptor = await observeRead(t, path, async () => {
      switch (mutation) {
        case 'replacement': {
          const replacement = join(directory, 'replacement');
          await writeFile(replacement, syntheticBytes, { mode: 0o600 });
          await rename(replacement, path);
          return;
        }
        case 'truncation': return truncate(path, 1);
        case 'growth': return writeFile(path, Uint8Array.of(...syntheticBytes, 1));
        case 'modification': return writeFile(path, new Uint8Array(syntheticBytes.length).fill(99));
      }
    });
    await assert.rejects(readSandboxCredentialFile({ path }), redactedSourceError);
    await assert.rejects(descriptor().stat(), { code: 'EBADF' });
  });
}

test('cancellation before or during a source read stays redacted and releases entered handles', async (t) => {
  const directory = await spillDirectory(t);
  const path = join(directory, 'selected-auth.json');
  await writeFile(path, syntheticBytes, { mode: 0o600 });
  const controller = new AbortController();
  const reason = new Error('synthetic secret-shaped cancellation reason');
  await assert.rejects(readSandboxCredentialFile({ path, signal: AbortSignal.abort(reason) }), redactedSourceError);
  const descriptor = await observeRead(t, path, () => controller.abort(reason));
  await assert.rejects(readSandboxCredentialFile({ path, signal: controller.signal }), redactedSourceError);
  await assert.rejects(descriptor().stat(), { code: 'EBADF' });
  assert.deepEqual(await readFile(path), Buffer.from(syntheticBytes));
});
