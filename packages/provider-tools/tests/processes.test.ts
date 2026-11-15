import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { NodeProviderCleanupError } from '../src/errors.js';
import { startHelper } from '../src/node/helper.js';
import { readNamespaceInit } from '../src/node/namespace.js';
import { FAKE_PID, fakeLauncher, fakeProc, report, type ProcState } from './support/launcher.js';

test('a helper client constructor failure kills and joins the child before rejecting', async (t) => {
  const launcher = await fakeLauncher(t, { info: null });
  const spawned: ChildProcess[] = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    spawned.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const child of spawned) if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  });
  await assert.rejects(startHelper({ bubblewrap: launcher.executable, helper: launcher.executable,
    storeDirectory: '/unused', uid: 262_144, gid: 1000 }), { code: 'helper_unavailable' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(spawned[0]!.pid!, 0), { code: 'ESRCH' });
});

test('a helper that fails readiness keeps its unjoined namespace behind the original retry until disappearance is confirmed', { timeout: 30_000 }, async (t) => {
  const states = new Map<number, ProcState>([[FAKE_PID, 'running']]);
  fakeProc(t, states);
  const launcher = await fakeLauncher(t, { info: report(FAKE_PID), ready: { uid: 1001, gid: 1001 } });
  const input = { bubblewrap: launcher.executable, helper: launcher.executable, storeDirectory: '/unused', uid: 1000, gid: 1000 };
  const failure = await startHelper(input).then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof NodeProviderCleanupError);
  assert.equal((failure.cause as { code?: string }).code, 'helper_unavailable');
  await assert.rejects(failure.retryCleanup(), { code: 'helper_unavailable' });
  states.set(FAKE_PID, 'zombie');
  await failure.retryCleanup();
  await failure.retryCleanup();
});

test('an info stream that fails before any report is an unknown namespace, unlike one that closes cleanly without a report', async () => {
  const failed = new PassThrough();
  const unknown = readNamespaceInit(failed);
  failed.destroy(new Error('EIO'));
  const closed = new PassThrough();
  const absent = readNamespaceInit(closed);
  closed.end();
  assert.deepEqual([await unknown, await absent], [{ kind: 'unidentified', pid: null, pidNamespace: null }, { kind: 'not_started' }]);
});
