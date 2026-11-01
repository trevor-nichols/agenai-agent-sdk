import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runResidentCommand } from './ownership.mjs';
import { spawn } from 'node:child_process';

const exists = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

for (const reportingFails of [false, true]) test(`a retained command preserves its original process and cleanup owner when reporting ${reportingFails ? 'fails' : 'succeeds'}`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'concurrency-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'owner.mjs');
  await writeFile(script, `import { retainCleanupOwner } from ${JSON.stringify(new URL('ownership.mjs', import.meta.url).href)};
await retainCleanupOwner({operation:async()=>{process.stdout.write(JSON.stringify({event:'original-cleanup',pid:process.pid})+'\\n');},
onRetained:async()=>{${reportingFails ? "throw new Error('Original evidence publication rejected');" : "process.stdout.write(JSON.stringify({status:'retained_cleanup',pid:process.pid,retrySignal:'SIGUSR2'})+'\\n');"}}});
process.stdout.write(JSON.stringify({event:'settled',pid:process.pid})+'\\n');
`);
  const result = await runResidentCommand({ command: process.execPath, args: [script], env: { PATH: process.env.PATH }, cwd: directory,
    directory: join(directory, 'command'), timeoutMs: 1000 });
  t.after(() => { if (exists(result.pid)) result.retryCleanup(); });
  assert.equal(result.disposition, 'retained_cleanup'); assert.equal(result.receipt.pid, result.pid);
  await delay(1100); assert.equal(exists(result.pid), true);
  assert.deepEqual((await readFile(result.stdoutPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).status), ['retained_cleanup']);
  result.retryCleanup();
  const deadline = performance.now() + 5000;
  while (exists(result.pid) && performance.now() < deadline) await delay(25);
  assert.equal(exists(result.pid), false);
  const records = (await readFile(result.stdoutPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.slice(1), [{ event: 'original-cleanup', pid: result.pid }, { event: 'settled', pid: result.pid }]);
});

test('stderr capacity returns the original resident cleanup owner instead of throwing away its process authority', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'concurrency-owner-capacity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'owner.mjs');
  await writeFile(script, `import {writeSync} from 'node:fs';
import {retainCleanupOwner} from ${JSON.stringify(new URL('ownership.mjs', import.meta.url).href)};
process.on('SIGTERM',()=>{});writeSync(2,Buffer.alloc(300000,120));
await retainCleanupOwner({operation:async()=>{},onRetained:async()=>{process.stdout.write(JSON.stringify({status:'retained_cleanup',pid:process.pid})+'\\n');}});
`);
  const result = await runResidentCommand({ command: process.execPath, args: [script], env: { PATH: process.env.PATH }, cwd: directory,
    directory: join(directory, 'command'), timeoutMs: 1000 });
  t.after(() => { if (exists(result.pid)) result.retryCleanup(); });
  assert.equal(result.disposition, 'retained_cleanup'); assert.equal(result.receipt.reason, 'diagnostic_capacity');
  assert.equal(result.receipt.diagnostics[0].observedBytes, 300000); assert.equal(result.receipt.diagnostics[0].capturedPrefixBytes, 262144);
  assert.equal(result.terminationSent, true); assert.equal(exists(result.pid), true);
  result.retryCleanup();
  const deadline = performance.now() + 5000; while (exists(result.pid) && performance.now() < deadline) await delay(25);
  assert.equal(exists(result.pid), false);
});

test('a broken retained-output pipe keeps the original cleanup owner until its explicit retry settles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'concurrency-owner-broken-output-'));
  const alive = join(directory, 'retained-alive.json'), settled = join(directory, 'settled.json');
  const script = join(directory, 'owner.mjs');
  await writeFile(script, `import {writeFile,rename} from 'node:fs/promises';
import {retainCleanupOwner} from ${JSON.stringify(new URL('ownership.mjs', import.meta.url).href)};
await retainCleanupOwner({operation:async()=>{await writeFile(${JSON.stringify(settled)},JSON.stringify({pid:process.pid,original:true}));},
onRetained:async()=>{setImmediate(async()=>{await writeFile(${JSON.stringify(alive+'.next')},JSON.stringify({pid:process.pid,retained:true}));
await rename(${JSON.stringify(alive+'.next')},${JSON.stringify(alive)});});throw new Error('evidence rejected');}});
`);
  const child = spawn(process.execPath, [script], { cwd: directory, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy(); let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const joined = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (exists(child.pid)) child.kill('SIGUSR2');
    await joined; await rm(directory, { recursive: true, force: true });
  });
  const deadline = performance.now() + 5000;
  for (;;) {
    try { assert.deepEqual(JSON.parse(await readFile(alive, 'utf8')), { pid: child.pid, retained: true }); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; assert(performance.now() < deadline, stderr); await delay(10); }
  }
  assert.equal(exists(child.pid), true, stderr);
  await assert.rejects(readFile(settled), { code: 'ENOENT' });
  child.kill('SIGUSR2'); assert.deepEqual(await joined, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(await readFile(settled, 'utf8')), { pid: child.pid, original: true });
});
