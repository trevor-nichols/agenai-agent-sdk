import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { acquireWorkspaceLease } from '../src/node/lease.js';
import { prepareNodeProviderWorkspace } from '../src/node/index.js';

async function scratch(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(`${tmpdir()}/provider-tools-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const uid = process.geteuid!();
const gid = process.getegid!();

test('preparation refuses command-visible system stores before touching the filesystem', async () => {
  for (const directory of ['/usr', '/usr/local/private', '/bin/private', '/lib/private', '/lib64/private', '/sbin/private']) {
    await assert.rejects(prepareNodeProviderWorkspace({ directory }), { code: 'invalid_options' });
  }
});

test('preparation creates one private store, reuses only an idle valid layout and never adopts unrelated data', async (t) => {
  const root = await scratch(t);
  const workspace = await prepareNodeProviderWorkspace({ directory: `${root}/store` });
  assert.deepEqual(workspace, { storeDirectory: `${root}/store`, workspaceDirectory: `${root}/store/work` });
  await writeFile(`${workspace.workspaceDirectory}/caller.txt`, 'caller data');
  assert.deepEqual(await prepareNodeProviderWorkspace({ directory: `${root}/store` }), workspace);
  assert.deepEqual(await readdir(workspace.workspaceDirectory), ['caller.txt']);

  await mkdir(`${root}/repo`);
  await writeFile(`${root}/repo/README.md`, 'unrelated');
  await assert.rejects(prepareNodeProviderWorkspace({ directory: `${root}/repo` }), { code: 'workspace_invalid' });
  assert.deepEqual(await readdir(`${root}/repo`), ['README.md']);
  await assert.rejects(prepareNodeProviderWorkspace({ directory: `${root}/store/../store` }), { code: 'invalid_options' });
});

test('unsettled staging and a widened store are refused rather than repaired', async (t) => {
  const root = await scratch(t);
  const { storeDirectory } = await prepareNodeProviderWorkspace({ directory: `${root}/store` });
  await writeFile(`${storeDirectory}/stage/leftover`, '');
  await assert.rejects(prepareNodeProviderWorkspace({ directory: storeDirectory }), { code: 'workspace_invalid' });
  await rm(`${storeDirectory}/stage/leftover`);
  await chmod(`${storeDirectory}/work`, 0o755);
  await assert.rejects(prepareNodeProviderWorkspace({ directory: storeDirectory }), { code: 'workspace_invalid' });
});

test('one owned driver holds the store; a second owner and a stale lease are refused until explicit release', async (t) => {
  const root = await scratch(t);
  const { storeDirectory } = await prepareNodeProviderWorkspace({ directory: `${root}/store` });
  const lease = await acquireWorkspaceLease(storeDirectory, uid, gid);
  await assert.rejects(acquireWorkspaceLease(storeDirectory, uid, gid), { code: 'workspace_leased' });
  await assert.rejects(prepareNodeProviderWorkspace({ directory: storeDirectory }), { code: 'workspace_leased' });
  await lease.release();
  await lease.release();

  await writeFile(`${storeDirectory}/.agenai-lease`, '{"token":"crashed-owner"}\n');
  await assert.rejects(acquireWorkspaceLease(storeDirectory, uid, gid), { code: 'workspace_leased' });
  await rm(`${storeDirectory}/.agenai-lease`);
  await (await acquireWorkspaceLease(storeDirectory, uid, gid)).release();
});
