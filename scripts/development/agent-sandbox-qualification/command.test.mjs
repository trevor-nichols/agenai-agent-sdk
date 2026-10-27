// ------------------------------------------------------------------------------------------------
//                command.test.mjs - Real finite producer termination and output settlement regressions
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedCommand } from './command.mjs';

const childProgram = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 20_000);`;

async function producerFixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'agenai-sandbox-command-'));
  const marker = path.join(root, 'producer.pid');
  let childPid;
  try {
    await run({ marker, observe: async () => {
      childPid = Number(await readFile(marker, 'utf8'));
      assert(Number.isSafeInteger(childPid) && childPid > 1);
      return childPid;
    } });
  } finally {
    if (childPid) {
      try { process.kill(childPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
}

function parentProgram(marker) {
  return `
const { spawn } = require('node:child_process');
let child;
process.on('SIGTERM', () => { child.once('close', () => process.exit(0)); });
child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}, ${JSON.stringify(marker)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`;
}

test('command output and status settle together, preserving both channels within one byte bound', async () => {
  assert.deepEqual(await runOwnedCommand({ command: process.execPath,
    args: ['-e', "process.stdout.write('result'); process.stderr.write('diagnostic');"], env: process.env, timeoutMs: 5_000 }),
  { stdout: 'result', stderr: 'diagnostic', status: 0, quiescent: true });
  await producerFixture(async ({ marker, observe }) => {
    const program = `require('node:fs').writeFileSync(process.argv[1], String(process.pid));
process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000);`;
    const error = await runOwnedCommand({ command: process.execPath,
      args: ['-e', program, marker], env: process.env, timeoutMs: 5_000, maxOutputBytes: 64 }).catch((value) => value);
    const childPid = await observe();
    assert.match(error.message, /64-byte output bound/u);
    assert.equal(error.quiescent, true);
    assert(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= 64);
    assert.throws(() => process.kill(-childPid, 0), { code: 'ESRCH' });
  });
});

test('a command deadline terminates its real finite producer and waits for that child to be reaped', async () => {
  await producerFixture(async ({ marker, observe }) => {
    const error = await runOwnedCommand({ command: process.execPath, args: ['-e', parentProgram(marker)], env: process.env, timeoutMs: 2_000 }).catch((value) => value);
    const childPid = await observe();
    assert.match(error.message, /2000ms deadline/u);
    assert.equal(error.quiescent, true);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  });
});

test('cancellation joins an entered producer group before returning cleanup authority', async () => {
  await producerFixture(async ({ marker, observe }) => {
    const cancellation = new AbortController();
    const pending = runOwnedCommand({ command: process.execPath, args: ['-e', parentProgram(marker)], env: process.env,
      timeoutMs: 15_000, signal: cancellation.signal }).catch((value) => value);
    const deadline = performance.now() + 10_000;
    let childPid;
    while (!childPid) {
      try { childPid = await observe(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert(performance.now() < deadline, 'The finite producer must enter before cancellation.');
      if (!childPid) await delay(20);
    }
    cancellation.abort();
    const error = await pending;
    assert.match(error.message, /was cancelled/u);
    assert.equal(error.quiescent, true);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  });
});

test('selected termination grace lets a real canceled command finish cleanup beyond the default grace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agenai-sandbox-command-grace-'));
  const ready = path.join(root, 'ready.pid');
  const cleanup = path.join(root, 'cleanup.txt');
  const cancellation = new AbortController();
  let childPid;
  let pending;
  try {
    const program = `const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(cleanup)}, 'cleanup completed\\n'); process.exit(0); }, 400));
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);`;
    pending = runOwnedCommand({ command: process.execPath, args: ['-e', program], env: process.env,
      timeoutMs: 10_000, terminationGraceMs: 2_000, signal: cancellation.signal }).catch((error) => error);
    const deadline = performance.now() + 5_000;
    while (!childPid) {
      try { childPid = Number(await readFile(ready, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert(performance.now() < deadline, 'The real command must install its cleanup handler before cancellation.');
      if (!childPid) await delay(20);
    }
    assert(Number.isSafeInteger(childPid) && childPid > 1);
    cancellation.abort();
    const error = await pending;
    assert.match(error.message, /was cancelled/u);
    assert.equal(error.quiescent, true);
    assert.equal(await readFile(cleanup, 'utf8'), 'cleanup completed\n');
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    cancellation.abort();
    if (pending) await pending;
    if (childPid) {
      try { process.kill(-childPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('leader success cannot declare an active producer group settled', async () => {
  await producerFixture(async ({ marker, observe }) => {
    const program = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}, ${JSON.stringify(marker)}], { stdio: 'ignore' });
const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) { clearInterval(poll); child.unref(); process.exit(0); } }, 10);`;
    const error = await runOwnedCommand({ command: process.execPath, args: ['-e', program], env: process.env, timeoutMs: 10_000 }).catch((value) => value);
    const childPid = await observe();
    assert.match(error.message, /active owned process group/u);
    try { process.kill(childPid, 0); assert.equal((await readFile(`/proc/${childPid}/stat`, 'utf8')).split(') ')[1].split(' ')[0], 'Z'); }
    catch (failure) { if (!['ENOENT', 'ESRCH'].includes(failure.code)) throw failure; }
  });
});
