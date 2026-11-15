import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { NodeProviderCleanupError } from '../src/errors.js';
import { prepareNodeProviderWorkspace } from '../src/node/workspace.js';
import { FAKE_PID, fakeLauncher, fakeProc, report, type LauncherScript, type ProcState } from './support/launcher.js';

const STUB = new URL('./support/identity-stub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './identity.js' && /\/src\/node\/owner\.[jt]s$/u.test(context.parentURL ?? '')) return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { openNodeProviderToolOwner } = await import('../src/node/owner.js');

const HELPER_PID = FAKE_PID + 1;
const MISMATCHED_USER = { uid: process.geteuid!() + 1, gid: process.getegid!() + 1 };

async function fixture(t: test.TestContext, script: LauncherScript, states: Map<number, ProcState>) {
  fakeProc(t, states);
  const root = await realpath(await mkdtemp(`${tmpdir()}/provider-tools-owner-`));
  let owner: Awaited<ReturnType<typeof openNodeProviderToolOwner>> | undefined;
  t.after(async () => {
    for (const pid of states.keys()) states.set(pid, 'gone');
    try { await owner?.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  const workspace = await prepareNodeProviderWorkspace({ directory: `${root}/store` });
  const stateParentDirectory = `${root}/state`;
  await mkdir(stateParentDirectory, { mode: 0o700 });
  const launcher = await fakeLauncher(t, script);
  const path = launcher.executable.path;
  const open = async () => {
    owner = await openNodeProviderToolOwner({ workspace, stateParentDirectory, bubblewrapPath: path, filesystemHelperPath: path },
      { path, sha256: { 'linux-x64': 'test-launcher', 'linux-arm64': 'test-launcher' }, maxBytes: 1_048_576 });
    return owner;
  };
  const leased = () => prepareNodeProviderWorkspace({ directory: workspace.storeDirectory }).then(() => false, (error: { code?: string }) => {
    if (error.code === 'workspace_leased') return true;
    throw error;
  });
  return { launcher, open, leased, state: () => readdir(stateParentDirectory) };
}

const failure = (promise: Promise<unknown>) => promise.then(() => assert.fail('expected a retained cleanup failure'), (error: unknown) => {
  assert.ok(error instanceof NodeProviderCleanupError, String(error));
  return error;
});

test('ordinary materialization, sequential sessions and repeated disposal leave no lease or state', { timeout: 30_000 }, async (t) => {
  const owned = await fixture(t, { info: report(FAKE_PID), helperInfo: report(HELPER_PID) }, new Map([[FAKE_PID, 'gone'], [HELPER_PID, 'gone']]));
  const owner = await owned.open();
  assert.equal((await owned.state()).length, 1);
  for (const editApproval of ['automatic', 'host'] as const) {
    const session = await owner.openSession({ editApproval });
    await assert.rejects(owner.openSession({ editApproval }), { code: 'session_active' });
    await session.close();
    await session.close();
  }
  await owner.dispose();
  await owner.dispose();
  assert.deepEqual([await owned.leased(), await owned.state()], [false, []]);
});

for (const [name, script, states] of [
  ['an unreadable preflight namespace', { info: report(FAKE_PID) }, [[FAKE_PID, 'unreadable']]],
  ['a probe helper whose readiness fails and whose namespace survives', { info: report(FAKE_PID), helperInfo: report(HELPER_PID), ready: MISMATCHED_USER },
    [[FAKE_PID, 'gone'], [HELPER_PID, 'running']]],
] as const) {
  test(`materialization retains ${name} with the lease and state until the original retry confirms it`, { timeout: 30_000 }, async (t) => {
    const observed = new Map<number, ProcState>(states);
    const owned = await fixture(t, script, observed);
    const retained = await failure(owned.open());
    assert.deepEqual([await owned.leased(), (await owned.state()).length], [true, 1]);
    for (const pid of observed.keys()) observed.set(pid, 'gone');
    await retained.retryCleanup();
    await retained.retryCleanup();
    assert.deepEqual([await owned.leased(), await owned.state()], [false, []]);
  });
}

test('a preflight whose namespace report is invalid can never be confirmed, so the lease and state stay retained', { timeout: 30_000 }, async (t) => {
  const owned = await fixture(t, { info: '{"child-pid": 41' }, new Map());
  const retained = await failure(owned.open());
  await assert.rejects(retained.retryCleanup(), { code: 'namespace_unavailable' });
  assert.deepEqual([await owned.leased(), (await owned.state()).length], [true, 1]);
});

test('a session helper that cannot be joined blocks reuse and disposal until its original retry confirms it', { timeout: 45_000 }, async (t) => {
  const observed = new Map<number, ProcState>([[FAKE_PID, 'gone'], [HELPER_PID, 'gone']]);
  const owned = await fixture(t, { info: report(FAKE_PID), helperInfo: report(HELPER_PID) }, observed);
  const owner = await owned.open();
  const failing = async (pid: number) => {
    await owned.launcher.script({ info: report(FAKE_PID), helperInfo: report(pid), ready: MISMATCHED_USER });
    observed.set(pid, 'running');
    return failure(owner.openSession({ editApproval: 'automatic' }));
  };

  const first = await failing(HELPER_PID + 1);
  await assert.rejects(owner.openSession({ editApproval: 'automatic' }), { code: 'session_active' });
  observed.set(HELPER_PID + 1, 'gone');
  await first.retryCleanup();
  await owned.launcher.script({ info: report(FAKE_PID), helperInfo: report(HELPER_PID) });
  await (await owner.openSession({ editApproval: 'host' })).close();

  const second = await failing(HELPER_PID + 2);
  const disposal = await failure(owner.dispose());
  assert.deepEqual([await owned.leased(), (await owned.state()).length], [true, 1]);
  observed.set(HELPER_PID + 2, 'gone');
  await second.retryCleanup();
  await owner.dispose();
  await disposal.retryCleanup();
  await second.retryCleanup();
  assert.deepEqual([await owned.leased(), await owned.state()], [false, []]);
});
