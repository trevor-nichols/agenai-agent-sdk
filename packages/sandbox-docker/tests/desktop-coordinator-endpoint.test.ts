// ------------------------------------------------------------------------------------------------
//                desktop-coordinator-endpoint.test.ts - Real Unix socket alias and substitution guards
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import filesystem, { lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { inspectDesktopCoordinatorEndpoint } from '../src/node/desktopCoordinatorEndpoint.js';

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dce-')));
  const physicalDirectory = join(directory, 'real');
  await mkdir(physicalDirectory);
  const physical = join(physicalDirectory, 's');
  const servers: ReturnType<typeof createServer>[] = [];
  const listen = async (path: string) => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
  };
  await listen(physical);
  const alias = join(directory, 'alias');
  await symlink('real', alias);
  return { directory, physicalDirectory, physical, alias, listen,
    endpoint(path: string) { return `unix://${path}`; },
    async close() {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await rm(directory, { recursive: true, force: true });
    } };
}

test('selected parent and leaf aliases retain distinct immutable bindings to the same real Unix socket', async () => {
  const owned = await fixture();
  try {
    const leaf = join(owned.directory, 'leaf');
    const absolute = join(owned.directory, 'absolute');
    await symlink('alias/s', leaf);
    await symlink(owned.physical, absolute);
    const physical = await inspectDesktopCoordinatorEndpoint(owned.endpoint(owned.physical));
    const parent = await inspectDesktopCoordinatorEndpoint(owned.endpoint(join(owned.alias, 's')));
    const selected = await inspectDesktopCoordinatorEndpoint(owned.endpoint(leaf));
    const directAlias = await inspectDesktopCoordinatorEndpoint(owned.endpoint(absolute));
    const socket = await lstat(owned.physical, { bigint: true });
    assert.deepEqual(physical.physical, { path: owned.physical, device: String(socket.dev), inode: String(socket.ino), mode: String(socket.mode) });
    assert.deepEqual(physical.aliases, []);
    for (const observed of [parent, selected, directAlias]) assert.deepEqual(observed.physical, physical.physical);
    assert.equal(selected.endpoint, owned.endpoint(leaf));
    assert.deepEqual(selected.aliases.map(({ path, target }) => ({ path, target })), [
      { path: leaf, target: 'alias/s' }, { path: owned.alias, target: 'real' },
    ]);
    for (const alias of selected.aliases) {
      const value = await lstat(alias.path, { bigint: true });
      assert.equal(alias.target, await readlink(alias.path));
      assert.deepEqual([alias.device, alias.inode, alias.mode, alias.uid, alias.gid, alias.birthtimeNs, alias.ctimeNs, alias.mtimeNs],
        [value.dev, value.ino, value.mode, value.uid, value.gid, value.birthtimeNs, value.ctimeNs, value.mtimeNs].map(String));
    }
    assert.equal(new Set([physical.digest, parent.digest, selected.digest, directAlias.digest]).size, 4);
    assert.deepEqual(await inspectDesktopCoordinatorEndpoint(owned.endpoint(leaf)), selected);
    assert.equal(Reflect.set(selected, 'endpoint', 'unix:///substituted'), false);
    assert.equal(Reflect.set(selected.physical, 'inode', '0'), false);
    assert.equal(Reflect.set(selected.aliases, '0', {}), false);
    assert.equal(Reflect.set(selected.aliases[0], 'target', '/substituted'), false);
  } finally { await owned.close(); }
});

test('alias targets preserve parent-component resolution before dot-dot and trailing-slash requirements', async () => {
  const owned = await fixture();
  try {
    await mkdir(join(owned.physicalDirectory, 'child'));
    const jump = join(owned.directory, 'jump');
    const selected = join(owned.directory, 'selected');
    await symlink('real/child', jump);
    await symlink('jump/../s', selected);
    const observed = await inspectDesktopCoordinatorEndpoint(owned.endpoint(selected));
    assert.equal(observed.physical.path, owned.physical);
    assert.deepEqual(observed.aliases.map((alias) => alias.path), [selected, jump]);
    const trailing = join(owned.directory, 'trailing');
    await symlink('real/s/', trailing);
    await assert.rejects(inspectDesktopCoordinatorEndpoint(owned.endpoint(trailing)), /non-directory parent component/u);
  } finally { await owned.close(); }
});

test('endpoint observation rejects cycles, non-sockets and bounded path or component overflow', async () => {
  const owned = await fixture();
  try {
    const cycle = join(owned.directory, 'cycle');
    await symlink('cycle', cycle);
    await assert.rejects(inspectDesktopCoordinatorEndpoint(owned.endpoint(cycle)), /symbolic-link cycle/u);
    const file = join(owned.directory, 'file');
    await writeFile(file, 'not a socket');
    for (const path of [file, owned.physicalDirectory]) {
      await assert.rejects(inspectDesktopCoordinatorEndpoint(owned.endpoint(path)), /physical local Unix socket/u);
    }
    const excessiveComponents = join(owned.directory, 'components');
    await symlink(`${'a/'.repeat(256)}s`, excessiveComponents);
    await assert.rejects(inspectDesktopCoordinatorEndpoint(owned.endpoint(excessiveComponents)), /256-component resolution bound/u);
    await assert.rejects(inspectDesktopCoordinatorEndpoint(`unix:///${'é'.repeat(2048)}`), /4096-byte path bound/u);
  } finally { await owned.close(); }
});

test('the forty-first actual alias expansion rejects before physical endpoint admission', async () => {
  const owned = await fixture();
  try {
    for (let index = 40; index >= 0; index -= 1) {
      await symlink(index === 40 ? 'real/s' : `a${index + 1}`, join(owned.directory, `a${index}`));
    }
    await assert.rejects(inspectDesktopCoordinatorEndpoint(owned.endpoint(join(owned.directory, 'a0'))), /40-symbolic-link expansion bound/u);
  } finally { await owned.close(); }
});

test('real alias, ancestor and socket replacements during their read brackets fail admission', { concurrency: false }, async () => {
  for (const cut of ['alias', 'ancestor', 'socket'] as const) {
    const owned = await fixture();
    const replacement = join(owned.directory, 'replacement');
    if (cut === 'socket') await owned.listen(replacement);
    const originalLstat = filesystem.lstat;
    let replaced = false;
    const target = cut === 'alias' ? owned.alias : cut === 'ancestor' ? owned.physicalDirectory : owned.physical;
    const interception = mock.method(filesystem, 'lstat', async (...args: Parameters<typeof originalLstat>) => {
      const observed = await originalLstat(...args);
      if (!replaced && args[0] === target) {
        replaced = true;
        if (cut === 'alias') {
          await rename(owned.alias, join(owned.directory, 'retired-alias'));
          await symlink('real', owned.alias);
        } else if (cut === 'ancestor') {
          const retired = join(owned.directory, 'retired-directory');
          await rename(owned.physicalDirectory, retired);
          await mkdir(owned.physicalDirectory);
          await rename(join(retired, 's'), owned.physical);
        } else {
          await rename(owned.physical, join(owned.directory, 'retired-socket'));
          await rename(replacement, owned.physical);
        }
      }
      return observed;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(inspectDesktopCoordinatorEndpoint(owned.endpoint(join(owned.alias, 's'))),
        /alias chain or physical socket changed/u, cut);
      assert.equal(replaced, true, `${cut} replacement must reach the actual filesystem read`);
    } finally {
      interception.mock.restore();
      syncBuiltinESMExports();
      await owned.close();
    }
  }
});
