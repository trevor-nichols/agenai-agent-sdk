import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareDockerDesktopHostNetworkObserver, prepareDockerDesktopVmRouteObserver } from '../src/node/prepareDesktopObservers.js';

test('Desktop preparation rejects non-data and mutable image inputs before reserving a context', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agenai-desktop-preparation-'));
  const directory = join(parent, 'context');
  const sentinel = join(parent, 'caller-owned.txt');
  await writeFile(sentinel, 'preserve caller content');
  try {
    let entered = 0;
    const host = { directory, toolchain: { compiler: { path: '/offline/clang', sha256: '1'.repeat(64) },
      sdk: { path: '/offline/MacOSX.sdk', version: '26.4' }, deploymentTarget: '13.0' } };
    Object.defineProperty(host.toolchain.compiler, 'sha256', { enumerable: true, get() { entered++; return '1'.repeat(64); } });
    await assert.rejects(prepareDockerDesktopHostNetworkObserver(host), TypeError);
    assert.equal(entered, 0, 'Preparation must capture data fields without evaluating caller getters.');
    const vm = { directory, toolchainImageDigest: `registry.example/gcc@sha256:${'2'.repeat(64)}`,
      baseImageDigest: 'node:latest', user: { uid: 1000, gid: 1000 } };
    await assert.rejects(prepareDockerDesktopVmRouteObserver(vm), { name: 'SandboxValidationError' });
    assert.deepEqual(await readdir(parent), ['caller-owned.txt']);
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve caller content');
  } finally { await rm(parent, { recursive: true, force: true }); }
});
