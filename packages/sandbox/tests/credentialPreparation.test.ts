// ------------------------------------------------------------------------------------------------
//                credentialPreparation.test.ts - Explicit offline shipped-source preparation boundary
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { prepareSandboxCredentialBootstrap } from '../src/node/credentials/prepare.js';
import { spillDirectory } from './fixtures/metadataSpill.js';

test('offline preparation publishes fixed shipped sources with independently verifiable identities in a fresh private directory', async (t) => {
  const parent = await spillDirectory(t);
  const directory = join(parent, 'prepared');
  const prepared = await prepareSandboxCredentialBootstrap({ directory });
  assert.equal(prepared.directory, directory);
  assert.equal(prepared.protocol, 'agenai.sandbox-credential-bootstrap.v1');
  assert.equal(prepared.guestDirectory, '/home/sandbox/.agenai-credentials');
  assert.equal(prepared.executableName, 'agenai-credential-bootstrap');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(directory)).sort(), ['BUILDING.md', 'bootstrap.c', 'manifest.json', 'protocol.h']);
  assert.deepEqual(prepared.files.map((file) => file.path), ['bootstrap.c', 'protocol.h']);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), prepared);
  const identities = [];
  for (const file of prepared.files) {
    const bytes = await readFile(join(directory, file.path));
    const shipped = await readFile(new URL(`../native/credentials/${file.path}`, import.meta.url));
    assert.deepEqual(bytes, shipped);
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    identities.push({ path: file.path, sha256: file.sha256 });
    assert.equal((await stat(join(directory, file.path))).mode & 0o777, 0o600);
  }
  assert.equal(prepared.sourceDigest, `sha256:${createHash('sha256').update(JSON.stringify(identities)).digest('hex')}`);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.files));
  const second = await prepareSandboxCredentialBootstrap({ directory: join(parent, 'second') });
  assert.equal(second.sourceDigest, prepared.sourceDigest);
  assert.deepEqual(second.files, prepared.files);
});

test('preparation rejects existing, noncanonical and symlink-parent directories without changing caller files', async (t) => {
  const parent = await spillDirectory(t);
  const existing = join(parent, 'existing');
  await mkdir(existing);
  const sentinel = join(existing, 'caller-file');
  await writeFile(sentinel, 'caller content');
  const alias = join(parent, 'alias');
  await symlink(existing, alias);
  for (const directory of ['relative', `${parent}/../out`, `${parent}//out`, `${parent}/out/`, `${parent}/bad\0path`,
    existing, sentinel, join(alias, 'out'), join(parent, 'missing', 'out')]) {
    await assert.rejects(prepareSandboxCredentialBootstrap({ directory }));
  }
  assert.deepEqual(await readdir(existing), ['caller-file']);
  assert.equal(await readFile(sentinel, 'utf8'), 'caller content');
  assert.deepEqual((await readdir(parent)).sort(), ['alias', 'existing']);
});
