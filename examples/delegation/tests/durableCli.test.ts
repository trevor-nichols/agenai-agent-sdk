// ------------------------------------------------------------------------------------------------
//                durableCli.test.ts - Human CLI ownership and recovery across independent processes
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sqliteParentInboxSchema } from '../inbox/index.js';
import { openSqliteDelegationStore } from '../sqlite/index.js';

interface Output {
  event: string;
  root?: string;
  code?: string;
  expectedSignal?: string;
  tuple?: { node: string; sqlite: string; filesystem: string };
  task?: { taskId: string; runId: string; state: string; outcome?: { kind: string; reason?: string } };
  notification?: { notificationId: string; state: string };
  inbox?: { inboxId: string; state: string };
  inboxId?: string;
  effects?: { child: number; parent: number };
  parentDelivery?: { text: string };
  removed?: boolean;
  shutdown?: string;
}
const cli = fileURLToPath(new URL('../durable.ts', import.meta.url));
function run(...args: string[]) { return launch(args); }
function launch(args: string[], imports: string[] = []): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: Output[]; diagnostics: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...imports.flatMap((path) => ['--import', path]), '--import', 'tsx', cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let diagnostics = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Durable CLI timed out: ${args.join(' ')}\n${stdout}\n${diagnostics}`)); }, 15_000);
    const append = (text: string) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(diagnostics) > 65_536) { child.kill('SIGKILL'); reject(new Error('Durable CLI diagnostics exceeded their bounded output.')); }
      return text;
    };
    child.stdout.on('data', (bytes: Buffer) => { stdout += append(bytes.toString()); });
    child.stderr.on('data', (bytes: Buffer) => { diagnostics += append(bytes.toString()); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      try { resolve({ code, signal, diagnostics, output: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Output) }); }
      catch (error) { reject(error); }
    });
  });
}
function baseDirectory() {
  const base = process.env.AGENT_SDK_DURABLE_TEST_ROOT ?? join(process.cwd(), '.agent');
  assert.ok(isAbsolute(base), 'Durable CLI qualification requires an absolute local-volume base.');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(base, 'durable-cli-test-'));
}
function completed(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.signal, null, result.diagnostics);
  const output = result.output.find((entry) => entry.event === 'complete');
  assert.ok(output, JSON.stringify(result));
  assert.equal(output.shutdown, 'closed');
  return output;
}

for (const scenario of ['normal', 'lost-ack', 'revoked', 'uncertain']) {
  test(`durable CLI ${scenario} retains its public result and effect counts across process invocations`, { timeout: 30_000 }, async (t) => {
    const base = baseDirectory();
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const setup = await run('setup', '--base', base, '--scenario', scenario);
    const ready = setup.output[0];
    assert.equal(ready?.event, 'ready', JSON.stringify(setup));
    assert.deepEqual(ready.tuple, { node: 'v24.18.0', sqlite: '3.53.1', filesystem: '0xef53' });
    assert.ok(ready.root);
    const root = ready.root;
    let originalInbox: string | undefined;
    if (scenario === 'normal') {
      const initial = completed(setup);
      assert.deepEqual(initial.effects, { child: 1, parent: 1 });
      originalInbox = initial.inbox?.inboxId;
    } else {
      assert.equal(setup.signal, 'SIGKILL', JSON.stringify(setup));
      const fault = setup.output.find((entry) => entry.event === 'fault');
      assert.equal(fault?.expectedSignal, 'SIGKILL');
      assert.deepEqual(fault.effects, { child: 1, parent: 0 });
      originalInbox = fault.inboxId;
    }
    const before = completed(await run('inspect', '--root', root));
    assert.equal(before.effects?.child, 1);
    assert.equal(before.effects?.parent, scenario === 'normal' ? 1 : 0, 'Passive inspection must not dispatch a parent turn.');
    const restarted = completed(await run('restart', '--root', root));
    assert.equal(restarted.task?.taskId, before.task?.taskId);
    assert.equal(restarted.task?.runId, before.task?.runId);
    assert.equal(restarted.effects?.child, 1, 'Restart must not replay completed or ambiguous child work.');
    if (scenario === 'uncertain') {
      assert.equal(before.task?.outcome, undefined, 'Inspection must not schedule recovery or another native turn.');
      assert.equal(restarted.task?.outcome?.kind, 'recovery_required');
      const again = completed(await run('restart', '--root', root));
      assert.deepEqual(again.task, restarted.task);
      assert.deepEqual(again.effects, { child: 1, parent: 0 });
    } else {
      assert.equal(restarted.task?.outcome?.kind, 'succeeded');
      assert.ok(originalInbox);
      assert.equal(restarted.inbox?.inboxId, originalInbox, 'A lost acknowledgement must retain the original durable acceptance.');
      assert.equal(restarted.notification?.state, 'accepted');
      assert.equal(restarted.inbox?.state, scenario === 'revoked' ? 'pending' : 'acknowledged');
      assert.equal(restarted.effects?.parent, scenario === 'revoked' ? 0 : 1);
      if (scenario === 'normal' || scenario === 'lost-ack') {
        assert.ok(restarted.parentDelivery, 'The actual parent native input must be observable after delivery.');
        const delivered = JSON.parse(restarted.parentDelivery.text) as Record<string, unknown>;
        assert.equal(delivered.notificationId, restarted.notification?.notificationId);
        assert.equal(delivered.taskId, restarted.task?.taskId);
        assert.equal(delivered.runId, restarted.task?.runId);
        assert.deepEqual(delivered.outcome, restarted.task?.outcome, 'Parent continuation must receive the retained result and artifact references.');
      }
    }
    const cleaned = await run('cleanup', '--root', root);
    assert.equal(cleaned.code, 0, JSON.stringify(cleaned));
    assert.equal(cleaned.output[0]?.removed, true);
    assert.equal(existsSync(root), false);
  });
}

test('durable CLI cleanup preserves unknown files and a live exclusive owner before allowing offline removal', { timeout: 20_000 }, async (t) => {
  const base = baseDirectory();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const initial = completed(await run('setup', '--base', base));
  assert.ok(initial.root);
  const root = initial.root;
  const marker = readFileSync(join(root, 'demo.json'));
  const unknown = join(root, 'operator-data.txt');
  writeFileSync(unknown, 'Preserve unrelated operator data.', { mode: 0o600 });
  const deniedUnknown = await run('cleanup', '--root', root);
  assert.equal(deniedUnknown.code, 1);
  assert.equal(readFileSync(unknown, 'utf8'), 'Preserve unrelated operator data.');
  assert.ok(readFileSync(join(root, 'demo.json')).equals(marker));
  rmSync(unknown);
  const opened = openSqliteDelegationStore({ root: join(root, 'database'), inboxSchema: sqliteParentInboxSchema });
  const owner = await opened.store.acquireOwner();
  try {
    const deniedLive = await run('cleanup', '--root', root);
    assert.equal(deniedLive.code, 1, JSON.stringify(deniedLive));
    assert.equal(deniedLive.output[0]?.code, 'owner_lost');
    opened.assertCurrent();
    assert.ok(readFileSync(join(root, 'demo.json')).equals(marker));
  } finally { await opened.store.releaseOwner(owner); }
  const finalInspection = completed(await run('inspect', '--root', root));
  assert.deepEqual(finalInspection.effects, { child: 1, parent: 1 });
  const cleanup = await run('cleanup', '--root', root);
  assert.equal(cleanup.code, 0, JSON.stringify(cleanup));
  assert.equal(existsSync(root), false);
});

test('durable CLI retirement excludes a real inspection after SQLite owner release and before removal', { timeout: 20_000 }, async (t) => {
  const base = baseDirectory();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const initial = completed(await run('setup', '--base', base));
  assert.ok(initial.root);
  const root = initial.root;
  const acquired = join(base, 'inspection-acquired');
  const continued = join(base, 'inspection-continue');
  const exited = join(base, 'inspection-exit');
  const output = join(base, 'inspection-output');
  const inspectPreload = join(base, 'inspect-preload.mjs');
  const cleanupPreload = join(base, 'cleanup-preload.mjs');
  writeFileSync(inspectPreload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      if (path === ${JSON.stringify(join(root, 'effects.json'))}) {
        fs.writeFileSync(${JSON.stringify(acquired)}, 'acquired');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(${JSON.stringify(continued)})) {
          if (Date.now() >= deadline) throw new Error('Inspection barrier timed out.');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return original.call(this, path, ...args);
    };
    process.on('exit', code => fs.writeFileSync(${JSON.stringify(exited)}, String(code)));
    syncBuiltinESMExports();
  `, { mode: 0o600 });
  writeFileSync(cleanupPreload, `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.rmSync;
    fs.rmSync = function(path, ...args) {
      if (path !== ${JSON.stringify(root)}) return original.call(this, path, ...args);
      const descriptor = fs.openSync(${JSON.stringify(output)}, 'w', 0o600);
      spawn(process.execPath, ['--import', ${JSON.stringify(inspectPreload)}, '--import', 'tsx', ${JSON.stringify(cli)}, 'inspect', '--root', path],
        { stdio: ['ignore', descriptor, descriptor] });
      fs.closeSync(descriptor);
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(${JSON.stringify(acquired)}) && !fs.existsSync(${JSON.stringify(exited)})) {
        if (Date.now() >= deadline) throw new Error('Retirement barrier timed out.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const result = original.call(this, path, ...args);
      fs.writeFileSync(${JSON.stringify(continued)}, 'continue');
      while (!fs.existsSync(${JSON.stringify(exited)})) {
        if (Date.now() >= deadline) throw new Error('Inspection exit timed out.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return result;
    };
    syncBuiltinESMExports();
  `, { mode: 0o600 });
  const cleanup = await launch(['cleanup', '--root', root], [cleanupPreload]);
  assert.equal(cleanup.code, 0, JSON.stringify(cleanup));
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(acquired), false, 'A competing CLI must not acquire SQLite ownership while retirement owns the root.');
  assert.equal(readFileSync(exited, 'utf8'), '1');
  const inspection = readFileSync(output, 'utf8').split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Output);
  assert.equal(inspection[0]?.event, 'error');
  assert.equal(inspection[0]?.code, 'owner_lost');
});
