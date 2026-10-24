// ------------------------------------------------------------------------------------------------
//                recovery-controller.mjs - Killable public sandbox controller - Durable cleanup-only recovery
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSandboxRecoveryRecord, parseSandboxRequest, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';

async function readJson(filename) {
  assert(path.isAbsolute(filename));
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.byteLength;
    assert(bytes <= 65_536, 'Controller input exceeded its explicit bound.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function atomicJson(filename, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  assert(Buffer.byteLength(bytes) <= 65_536, 'Controller record exceeded its explicit bound.');
  await writeFile(`${filename}.next`, bytes, { mode: 0o600 });
  await rename(`${filename}.next`, filename);
}

function send(message) {
  assert(process.send, 'Controller requires the task-owned IPC channel.');
  return new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
}

async function command(expected, readiness) {
  const received = Promise.withResolvers();
  const listener = (message) => {
    try { assert.deepEqual(message, { command: expected }); received.resolve(); }
    catch (error) { received.reject(error); }
  };
  const timer = setTimeout(() => received.reject(new Error('Parent controller command exceeded its deadline.')), 60_000);
  process.once('message', listener);
  try {
    await Promise.all([received.promise, Promise.resolve().then(() => send(readiness))]);
  } finally {
    clearTimeout(timer);
    process.removeListener('message', listener);
  }
}

const [mode, configPath] = process.argv.slice(2);
assert(mode === 'start' || mode === 'create' || mode === 'recover');
const config = await readJson(configPath);
assert.equal(config.format, 'agenai.ms005-controller-config.v1');
assert(typeof config.marker === 'string' && /^[a-z0-9-]{1,128}$/u.test(config.marker));
for (const filename of [config.recordPath, config.plannedPath, config.returnedPath, config.resultPath]) assert(path.isAbsolute(filename));
const backend = createDockerSandboxBackend({ endpoint: config.endpoint, profile: config.profile ?? 'linux-x64', namespace: config.namespace,
  imageDigest: config.imageDigest, spillDirectory: path.dirname(config.recordPath), user: config.user,
  ...(config.datasets === undefined ? {} : { datasets: config.datasets }) });
let owner;
let completed = false;
try {
  if (mode === 'start' || mode === 'create') {
    owner = backend.reserve(parseSandboxRequest({ policy: {
      resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 256 },
      temporaryStorage: { homeBytes: 16 * 1024 ** 2, tempBytes: 16 * 1024 ** 2 }, network: { kind: 'isolated' },
      execution: { kind: 'deadline', timeoutMs: 300_000 },
      deadlines: { startupMs: 60_000, cleanupMs: 30_000 },
      transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS,
    } }), { kind: 'persisted', persist: (record) => atomicJson(config.recordPath, record) });
    await atomicJson(config.plannedPath, owner.recoveryRecord);
    if (mode === 'create') {
      await command('start', { kind: 'reserved', pid: process.pid, record: owner.recoveryRecord });
      await owner.start();
      throw new Error('The held-create controller must be killed before startup returns.');
    }
    const sandbox = await owner.start();
    const guest = `import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {createHash}from'node:crypto';
      const expected=JSON.parse(process.argv[2]);if(expected){const bytes=readFileSync('/datasets/'+expected.name+'/'+expected.path);
      const dataset={byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
      assert.deepEqual(dataset,{byteLength:expected.byteLength,sha256:expected.sha256});process.stdout.write(JSON.stringify({dataset})+'\\n');}
      writeFileSync('command-marker.json', JSON.stringify({marker:process.argv[1], executions:1, node:process.version}), {flag:'wx'}); process.stdout.write('WORKLOAD_READY\\n'); setInterval(()=>{},1000);`;
    const reservation = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: ['--input-type=module', '-e', guest, config.marker,
      JSON.stringify(config.datasetFixture ?? null)], cwd: sandbox.workspace, env: {} });
    const streams = await reservation.start();
    let stdout = '';
    const ready = Promise.withResolvers();
    streams.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1024) ready.reject(new Error('Controlled recovery workload exceeded stdout bound.'));
      else if (stdout.endsWith('WORKLOAD_READY\n')) ready.resolve();
    });
    streams.stdout.on('error', ready.reject);
    streams.stderr.on('data', () => ready.reject(new Error('Controlled recovery workload unexpectedly wrote stderr.')));
    streams.stderr.on('error', ready.reject);
    const timer = setTimeout(() => ready.reject(new Error('Recovery workload readiness deadline elapsed.')), 30_000);
    try { await ready.promise; } finally { clearTimeout(timer); }
    // Readiness follows native effects, settled SDK checkpoints and one final durable copy.
    await atomicJson(config.recordPath, owner.recoveryRecord);
    const dataset = config.datasetFixture ? JSON.parse(stdout.split('\n')[0]).dataset : undefined;
    await command('unexpected-graceful-close', { kind: 'started', pid: process.pid, processId: reservation.id, record: owner.recoveryRecord,
      ...(dataset ? { dataset } : {}) });
    throw new Error('The original controller must be killed rather than gracefully closed.');
  }
  const original = parseSandboxRecoveryRecord(await readJson(config.recordPath));
  const result = await backend.reconcile(original);
  assert.equal(result.kind, 'matched', 'Fresh process must match exactly the persisted resource ownership.');
  owner = result.owner;
  // Reconciliation may advance creating identities. Persist its returned record before cleanup.
  await atomicJson(config.returnedPath, owner.recoveryRecord);
  await atomicJson(config.recordPath, owner.recoveryRecord);
  await command('destroy', { kind: 'reconciled', pid: process.pid, record: owner.recoveryRecord,
    cleanupOnly: !('start' in owner) && !('reserveProcess' in owner) && !('exportTree' in owner) });
  await owner.destroy();
  await atomicJson(config.recordPath, owner.recoveryRecord);
  await atomicJson(config.resultPath, { kind: 'destroyed', pid: process.pid, record: owner.recoveryRecord,
    executionResumed: false, commandsDispatched: 0 });
  completed = true;
  await send({ kind: 'destroyed', pid: process.pid, record: owner.recoveryRecord });
} catch (error) {
  await atomicJson(config.resultPath, { kind: 'failed', pid: process.pid, error: error instanceof Error ? error.message.slice(0, 1024) : String(error),
    ...(owner ? { record: owner.recoveryRecord } : {}) });
  process.exitCode = 1;
} finally {
  // Failure retains exact recovery ownership for the parent. Never hide the original verdict.
  if (mode === 'recover' || process.exitCode || completed) process.disconnect();
  if (process.exitCode) process.exit(1);
}
