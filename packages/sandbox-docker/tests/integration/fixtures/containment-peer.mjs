// ------------------------------------------------------------------------------------------------
//                containment-peer.mjs - Finite credential-free containment workloads - MS005 fixture
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const scenario = process.argv[2];
const marker = process.argv[3];
if (process.version !== 'v24.18.0' || !['memory', 'pids', 'flood', 'hold', 'isolation'].includes(scenario)
  || !/^agenai-ms005-[a-f0-9-]+$/u.test(marker ?? '')) {
  throw new Error('The containment peer requires the qualified Node version, an explicit scenario and owned marker.');
}

const commands = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
const report = (value) => new Promise((resolve, reject) => {
  process.stderr.write(`${JSON.stringify({ ...value, marker })}\n`, (error) => error ? reject(error) : resolve());
});
const persist = (value) => {
  writeFileSync('containment.json.next', `${JSON.stringify({ ...value, marker })}\n`, { mode: 0o600 });
  renameSync('containment.json.next', 'containment.json');
};
const nextCommand = async () => {
  const result = await commands.next();
  if (result.done || result.value.length > 4096) throw new Error('An explicit bounded containment command is required.');
  return JSON.parse(result.value);
};
const failSafe = setTimeout(() => process.exit(79), 25_000);
await report({ kind: 'ready', scenario, pid: process.pid, node: process.version });
const command = await nextCommand();
if (command.command !== 'begin') throw new Error('The containment workload requires explicit begin.');

if (scenario === 'memory') {
  const pages = [];
  const chunkBytes = 4 * 1024 ** 2;
  for (let index = 0; index < 96; index += 1) {
    // Buffer.alloc touches every page and the retained array prevents collection.
    pages.push(Buffer.alloc(chunkBytes, 0x5a));
    persist({ kind: 'memory-progress', allocatedBytes: pages.length * chunkBytes, chunkBytes, allocationCeilingBytes: 384 * 1024 ** 2 });
  }
  await report({ kind: 'memory-uncontained', allocatedBytes: pages.length * chunkBytes });
  await delay(5000);
} else if (scenario === 'pids') {
  let spawned = 0;
  const errors = {};
  for (let attempt = 0; attempt < 64; attempt += 1) {
    await new Promise((resolve, reject) => {
      const child = spawn('/bin/sleep', ['20'], { stdio: 'ignore', env: {}, cwd: process.cwd() });
      child.once('spawn', () => { spawned += 1; child.unref(); resolve(); });
      child.once('error', (error) => {
        if (error.code !== 'EAGAIN') { reject(error); return; }
        errors[error.code] = (errors[error.code] ?? 0) + 1;
        resolve();
      });
    });
  }
  const result = { kind: 'pids-result', attempts: 64, spawned, rejected: 64 - spawned, errors };
  persist(result);
  await report(result);
  await delay(15_000);
} else if (scenario === 'flood') {
  const chunk = Buffer.alloc(4096, 0xa5);
  for (let index = 0; index < 4096; index += 1) {
    await new Promise((resolve, reject) => process.stdout.write(chunk, (error) => error ? reject(error) : resolve()));
  }
  await report({ kind: 'flood-complete', bytes: 16 * 1024 ** 2 });
} else if (scenario === 'hold') {
  persist({ kind: 'hold-entered', pid: process.pid });
  await new Promise((resolve, reject) => process.stdout.write(Buffer.from('held-output\n'), (error) => error ? reject(error) : resolve()));
  await report({ kind: 'hold-entered', pid: process.pid });
  await delay(20_000);
  await report({ kind: 'hold-complete' });
} else {
  if (!/^private-[a-f0-9-]+\.txt$/u.test(command.ownFile ?? '')
    || !/^private-[a-f0-9-]+\.txt$/u.test(command.foreignFile ?? '')
    || !/^agenai-ms005-[a-f0-9-]+$/u.test(command.foreignMarker ?? '')) {
    throw new Error('Isolation requires exact owned and foreign fixture identities.');
  }
  const ownContent = readFileSync(command.ownFile, 'utf8');
  let foreignFileStatus;
  try { readFileSync(command.foreignFile); foreignFileStatus = 'visible'; }
  catch (error) { if (error.code !== 'ENOENT') throw error; foreignFileStatus = 'absent'; }
  const visibleProcesses = readdirSync('/proc').filter((name) => /^\d+$/u.test(name));
  if (visibleProcesses.length > 128) throw new Error('The isolated fixture process census exceeded its bound.');
  const foreignProcesses = visibleProcesses.filter((name) => {
    if (Number(name) === process.pid) return false;
    try { return readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(command.foreignMarker); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
  });
  const result = { kind: 'isolation-result', ownContent, foreignFileStatus, foreignProcesses, visibleProcessCount: visibleProcesses.length };
  persist(result);
  await report(result);
  const ping = await nextCommand();
  if (ping.command !== 'ping' || typeof ping.nonce !== 'string' || ping.nonce.length > 128) throw new Error('An owned bounded ping is required.');
  await report({ kind: 'pong', nonce: ping.nonce, ownContent: readFileSync(command.ownFile, 'utf8') });
  await delay(15_000);
}

clearTimeout(failSafe);
process.exit(0);
