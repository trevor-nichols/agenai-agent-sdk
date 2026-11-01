import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareDockerDesktopCoordinatorHelper } from '../src/node/prepareDesktopCoordinator.js';

const toolchain = { compiler: { path: '/offline/never-run-clang', sha256: '1'.repeat(64) },
  sdk: { path: '/offline/MacOSX.sdk', version: '26.4' }, deploymentTarget: '14.0' };

test('Desktop coordinator preparation publishes verifiable offline assets without invoking its selected compiler', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agenai-coordinator-preparation-')));
  const directory = join(parent, 'context');
  try {
    const prepared = await prepareDockerDesktopCoordinatorHelper({ directory, toolchain });
    assert.equal(prepared.protocol, 'agenai.desktop-coordinator.v1');
    assert.equal(prepared.architecture, 'darwin/arm64');
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const file of prepared.files) {
      const bytes = await readFile(join(directory, file.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      assert.equal((await stat(join(directory, file.path))).mode & 0o777, 0o600);
    }
    assert.equal(prepared.sourceDigest, `sha256:${createHash('sha256').update(JSON.stringify(prepared.files)).digest('hex')}`);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), prepared);
    const recipe = JSON.parse(await readFile(join(directory, 'commands.json'), 'utf8'));
    assert.equal(recipe.cwd, directory);
    assert.equal(recipe.compilerSha256, toolchain.compiler.sha256);
    assert.deepEqual(recipe.commands, prepared.commands);
    await assert.rejects(stat(join(directory, prepared.executable)), { code: 'ENOENT' });
    await assert.rejects(prepareDockerDesktopCoordinatorHelper({ directory, toolchain }), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), prepared);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Desktop coordinator preparation rejects alternate authority roots and accessors before writing', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agenai-coordinator-preparation-')));
  const directory = join(parent, 'context');
  await writeFile(join(parent, 'sentinel'), 'original');
  try {
    const alternateRoot = { directory, toolchain, authorityRoot: '/alternate' };
    await assert.rejects(prepareDockerDesktopCoordinatorHelper(alternateRoot),
      { name: 'SandboxValidationError' });
    let entered = 0;
    const accessor = { directory, toolchain };
    Object.defineProperty(accessor, 'directory', { enumerable: true, get() { entered++; return directory; } });
    await assert.rejects(prepareDockerDesktopCoordinatorHelper(accessor), TypeError);
    assert.equal(entered, 0);
    assert.deepEqual(await readdir(parent), ['sentinel']);
    assert.equal(await readFile(join(parent, 'sentinel'), 'utf8'), 'original');
  } finally { await rm(parent, { recursive: true, force: true }); }
});
