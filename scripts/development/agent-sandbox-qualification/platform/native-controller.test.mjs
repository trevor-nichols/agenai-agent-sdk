import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedCommand } from '../command.mjs';
import { runNativeController } from './native-controller.mjs';

const childSource = String.raw`
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { nativeControllerReady } = await import(config.module);
const publish = async (name, value) => {
  const path = join(config.root, name);
  await writeFile(path + '.pending', JSON.stringify(value)); await rename(path + '.pending', path);
};
let declaredReady = false;
let resolveCleanup;
const cleanup = new Promise(resolve => { resolveCleanup = resolve; });
process.on('SIGTERM', () => {
  void publish('cleanup-requested.json', { pid: process.pid, declaredReady });
  resolveCleanup();
});
const grandchild = spawn(process.execPath, ['--input-type=module', '-e', String.raw\`
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[1];
process.on('SIGTERM', () => {
  if (!existsSync(join(root, 'cleanup-authorized'))) writeFileSync(join(root, 'unexpected-group-signal'), 'SIGTERM');
  process.exit(0);
});
writeFileSync(join(root, 'group-ready.json'), JSON.stringify({ pid: process.pid }));
setInterval(() => { if (existsSync(join(root, 'release-group'))) process.exit(0); }, 5);
\`, config.root], { stdio: 'ignore' });
const groupClosed = once(grandchild, 'close');
while (true) {
  try { await readFile(join(config.root, 'group-ready.json')); break; } catch { await delay(5); }
}
await publish('before-ready.json', { pid: process.pid });
if (config.holdReady) while (true) {
  try { await readFile(join(config.root, 'release-ready')); break; } catch { await delay(5); }
}
declaredReady = true;
if (!config.noReady) await nativeControllerReady();
await publish('child-ready.json', { pid: process.pid, groupPid: grandchild.pid });
if (config.groupOnly) process.exit(0);
const socket = createConnection(config.socket);
await once(socket, 'connect');
if (config.output) process.stdout.write(Buffer.alloc(config.output, 111));
if (config.finish) resolveCleanup();
await cleanup;
const reply = once(socket, 'data');
socket.write('cleanup');
await reply;
await writeFile(join(config.root, 'cleanup-authorized'), 'yes');
grandchild.kill('SIGTERM');
await groupClosed;
socket.end();
await once(socket, 'close');
await publish('completed.json', { pid: process.pid, groupPid: grandchild.pid });
`;

async function observed(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function until(operation) {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const value = await operation(); if (value) return value;
    assert(performance.now() < deadline, 'Expected original child protocol event.'); await delay(5);
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp('/tmp/agenai-owner-');
  const socketPath = join(root, 'dependency.sock');
  let socket, requested, released = false;
  const cleanupRequested = new Promise((resolve) => { requested = resolve; });
  const server = createServer((connection) => {
    socket = connection; connection.on('error', () => {});
    connection.on('data', () => { requested(); if (released) connection.write('done'); });
  });
  server.listen(socketPath); await once(server, 'listening');
  const source = join(root, 'child.mjs'), config = join(root, 'input.json');
  // Nested template literals belong to the emitted fixture child, not this test host.
  await writeFile(source, childSource.replaceAll('\\`', '`'));
  await writeFile(config, JSON.stringify({ root, socket: socketPath,
    module: new URL('./native-controller.mjs', import.meta.url).href, ...options }));
  let work;
  t.after(async () => {
    await writeFile(join(root, 'release-ready'), 'yes');
    await writeFile(join(root, 'release-group'), 'yes');
    released = true; socket?.write('done');
    const original = await observed(join(root, 'child-ready.json')) ?? await observed(join(root, 'before-ready.json'));
    if (original) {
      try { process.kill(JSON.parse(original).pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (work) await work.catch(() => {});
    if (original) await until(() => {
      try { process.kill(JSON.parse(original).pid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    });
    socket?.destroy(); await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, config, server, cleanupRequested, own(value) { work = value; },
    release() { released = true; socket.write('done'); },
    start(configuration) {
      const run = process.env.AGENAI_NATIVE_CONTROLLER_LEGACY_PROOF === '1' ? runOwnedCommand : runNativeController;
      work = run({ command: process.execPath, args: [source, config], cwd: root, timeoutMs: 10_000,
        terminationGraceMs: 25, ...configuration });
      work.catch(() => {}); return work;
    } };
}

test('a successful original child and its ready-only IPC channel join without a cleanup request', async (t) => {
  const selected = await fixture(t, { finish: true }); let entered;
  const work = selected.start({ onStarted(value) { entered = value; } });
  await selected.cleanupRequested; selected.release();
  const result = await work;
  const completed = JSON.parse(await readFile(join(selected.root, 'completed.json'), 'utf8'));
  assert.equal(result.pid, entered.pid); assert.equal(result.pid, completed.pid);
  assert.equal(result.status, 0); assert.equal(result.quiescent, true); assert.equal(result.ready, true);
  assert.equal(result.gracefulRequest, null); assert.equal(result.observedOutputBytes, 0);
  assert.throws(() => process.kill(completed.groupPid, 0), { code: 'ESRCH' });
});

for (const trigger of ['cancellation', 'deadline', 'output', 'receipt']) test(`original native child retains cleanup and dependency through ${trigger}`, async (t) => {
  const selected = await fixture(t, { output: trigger === 'output' ? 256 : 0 });
  const cancellation = new AbortController(); let entered;
  const firstFailure = new Error('Entered PID persistence failed.');
  let settled = false, dependencyReleased = false;
  const work = selected.start({ signal: cancellation.signal, timeoutMs: trigger === 'deadline' ? 1 : 10_000,
    maxOutputBytes: trigger === 'output' ? 128 : 4096,
    onStarted(receipt) { entered = receipt; if (trigger === 'receipt') throw firstFailure; } });
  const lifetime = work.finally(() => { settled = true; dependencyReleased = true; }); lifetime.catch(() => {});
  const ready = JSON.parse(await until(() => observed(join(selected.root, 'child-ready.json'))));
  if (trigger === 'cancellation') cancellation.abort();
  await selected.cleanupRequested;
  assert.equal(dependencyReleased, false, 'Outer dependency must outlive blocked original cleanup.');
  assert.equal(settled, false); process.kill(ready.pid, 0); process.kill(ready.groupPid, 0);
  assert.equal(JSON.parse(await until(() => observed(join(selected.root, 'cleanup-requested.json')))).declaredReady, true);
  selected.release();
  let failure; try { await lifetime; } catch (error) { failure = error; }
  assert(failure instanceof Error);
  assert.equal(await observed(join(selected.root, 'unexpected-group-signal')), null,
    'The parent must never signal the cleanup owner process group.');
  const completed = JSON.parse(await readFile(join(selected.root, 'completed.json'), 'utf8'));
  assert.deepEqual(completed, { pid: ready.pid, groupPid: ready.groupPid });
  assert.equal(failure.pid, ready.pid); assert.equal(entered.pid, ready.pid);
  assert.equal(failure.status, 0); assert.equal(failure.quiescent, true); assert.equal(failure.ready, true);
  assert.equal(failure.gracefulRequest.signal, 'SIGTERM'); assert.equal(failure.gracefulRequest.delivered, true);
  assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(ready.groupPid, 0), { code: 'ESRCH' });
  if (trigger === 'receipt') assert.equal(failure, firstFailure);
  if (trigger === 'output') {
    assert.equal(failure.retainedOutputBytes, 128); assert.equal(failure.stdout, 'o'.repeat(128));
    assert.equal(failure.observedOutputBytes, 256);
  }
});

test('work cancellation waits for original readiness and joins a child with no declared signal support naturally', async (t) => {
  const selected = await fixture(t, { holdReady: true, noReady: true });
  const cancellation = new AbortController(); let entered;
  const work = selected.start({ signal: cancellation.signal, requireReady: false, onStarted(value) { entered = value; } });
  const original = JSON.parse(await until(() => observed(join(selected.root, 'before-ready.json'))));
  cancellation.abort(); await writeFile(join(selected.root, 'release-ready'), 'yes');
  await until(() => observed(join(selected.root, 'child-ready.json')));
  assert.equal(await observed(join(selected.root, 'cleanup-requested.json')), null);
  // No declared IPC support grants no parent signal authority. The fixture's original
  // caller now requests its own benign cleanup directly, after proving that absence.
  process.kill(original.pid, 'SIGTERM'); await selected.cleanupRequested; selected.release();
  await assert.rejects(work, (error) => error.pid === entered.pid && error.quiescent === true
    && error.ready === false && error.gracefulRequest === null);
});

test('asynchronous PID diagnostic pipe failure retains the original child and dependency until cleanup joins', async (t) => {
  const selected = await fixture(t);
  const hostSource = join(selected.root, 'host.mjs');
  await writeFile(hostSource, `
import { writeFile } from 'node:fs/promises';
import { runNativeController } from ${JSON.stringify(new URL('./native-controller.mjs', import.meta.url).href)};
try {
  await runNativeController({ command: process.execPath, args: ${JSON.stringify([selected.source, selected.config])},
    timeoutMs: 10000, onStarted(value) {
      return writeFile(${JSON.stringify(join(selected.root, 'host-started.json'))}, JSON.stringify(value));
    } });
} catch (error) {
  await writeFile(${JSON.stringify(join(selected.root, 'host-joined.json'))}, JSON.stringify({
    pid: error.pid, code: error.code, quiescent: error.quiescent, status: error.status, gracefulRequest: error.gracefulRequest }));
  process.exitCode = 1;
}
`);
  const host = spawn(process.execPath, [hostSource], { stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(host, 'close'); selected.own(closed);
  host.stderr.destroy();
  const original = JSON.parse(await until(() => observed(join(selected.root, 'child-ready.json'))));
  const first = await Promise.race([selected.cleanupRequested.then(() => 'cleanup'), closed.then(() => 'host_exited')]);
  assert.equal(first, 'cleanup', 'A broken diagnostic reader must not discard the entered native child owner.');
  process.kill(original.pid, 0); process.kill(original.groupPid, 0);
  selected.release(); const [status] = await closed; assert.equal(status, 1);
  const receipt = JSON.parse(await readFile(join(selected.root, 'host-joined.json'), 'utf8'));
  assert.equal(receipt.pid, original.pid); assert.equal(receipt.code, 'EPIPE');
  assert.equal(receipt.quiescent, true); assert.equal(receipt.status, 0);
  assert.equal(receipt.gracefulRequest.signal, 'SIGTERM');
  assert.deepEqual(JSON.parse(await readFile(join(selected.root, 'completed.json'), 'utf8')), original);
});

test('a naturally exiting direct child cannot release a remaining owned process group', async (t) => {
  const selected = await fixture(t, { groupOnly: true }); let settled = false;
  const work = selected.start({}); work.finally(() => { settled = true; }).catch(() => {});
  const original = JSON.parse(await until(() => observed(join(selected.root, 'child-ready.json'))));
  await until(() => { try { process.kill(original.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
  assert.equal(settled, false); assert.equal(selected.server.listening, true); process.kill(original.groupPid, 0);
  await writeFile(join(selected.root, 'release-group'), 'yes');
  await assert.rejects(work, (error) => error.pid === original.pid && error.quiescent === true
    && error.message === 'Native controller exited with an active owned process group.');
});
