import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { executeNativeWorker, type NativeWorkerJob } from '../process.js';

async function fixture(t: TestContext, program: string) {
  const root = await mkdtemp(join(tmpdir(), 'native-ipc-test-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, 'worker.mjs');
  await writeFile(worker, program, { mode: 0o600 });
  const started = performance.now();
  return { worker: pathToFileURL(worker), root, clock: () => performance.now() - started,
    // The protocol fixture consumes only its own root; it never dispatches this intentionally invalid candidate.
    job: { kind: 'install', candidate: {}, root } as NativeWorkerJob };
}

test('worker completion requires actual process exit and the replacement environment excludes ambient secrets and loaders', async (t) => {
  const input = await fixture(t, `
    process.on('message', (message) => {
      if (message.type !== 'job') return;
      const isolated = !process.env.XAI_API_KEY && !process.env.NODE_OPTIONS && !process.env.GROK_HOME;
      process.send({type:'result',payload:{kind:'failure',code:isolated?'fixture_environment_isolated':'fixture_environment_leaked',cleanup:'closed'}},
        () => setTimeout(() => process.disconnect(), 25));
    });
    process.send({type:'ready',processId:process.pid});
  `);
  const previous = { key: process.env.XAI_API_KEY, options: process.env.NODE_OPTIONS, home: process.env.GROK_HOME };
  process.env.XAI_API_KEY = 'fixture-key-must-not-cross-ipc-launch';
  process.env.NODE_OPTIONS = '--fixture-invalid-inherited-node-option';
  process.env.GROK_HOME = '/fixture/ambient-home';
  try {
    const owner = await executeNativeWorker(input);
    assert.equal(owner.payload?.kind, 'failure');
    if (owner.payload?.kind !== 'failure') throw new Error('Fixture did not complete its environment observation.');
    assert.equal(owner.payload.code, 'fixture_environment_isolated');
    assert.equal(owner.cleanup, 'closed');
    const process = owner.observation;
    assert.equal(process.exitCode, 0);
    assert.ok(process.readyAt! >= process.spawnedAt);
    assert.ok(process.settledAt! >= process.readyAt!);
    assert.ok(process.exitedAt! > process.settledAt!);
  } finally {
    for (const [name, value] of [['XAI_API_KEY', previous.key], ['NODE_OPTIONS', previous.options], ['GROK_HOME', previous.home]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('cancellation retains the live worker and cleanup capability until acknowledgement and actual exit', async (t) => {
  for (const malformedOperation of [false, true]) await t.test(malformedOperation ? 'malformed operation report' : 'reported pending cleanup', async (t) => {
    const input = await fixture(t, `
    import {writeFile} from 'node:fs/promises';
    let root;
    const keepAlive = setInterval(() => {}, 1000);
    process.on('message', async (message) => {
      if (message.type === 'job') {
        root=message.job.root;
        process.send({type:'result',payload:${malformedOperation
    ? "{kind:'operation',result:{report:null,allocations:[],cleanup:'pending'},cleanup:'pending'}"
    : "{kind:'failure',code:'fixture_cleanup_pending',cleanup:'pending'}"}});
      } else if (message.type === 'cancel') {
        await writeFile(root+'/canceled','observed');
      } else if (message.type === 'cleanup') {
        await writeFile(root+'/cleaned','quiesced');
        clearInterval(keepAlive);
        process.send({type:'cleanup',status:'closed',requestId:message.requestId},()=>process.disconnect());
      }
    });
    process.send({type:'ready',processId:process.pid});
  `);
    const job = malformedOperation
      ? { kind: 'operate', command: 'execute', candidate: {}, root: input.root, installation: {} } as NativeWorkerJob
      : input.job;
    const stop = new AbortController();
    const owner = await executeNativeWorker({ ...input, job, signal: stop.signal });
    t.after(async () => { if (owner.cleanup === 'pending') await owner.retryCleanup(); });
    if (malformedOperation) assert.equal(owner.payload, undefined, 'Unvalidated worker reports must not escape their IPC owner.');
    assert.equal(owner.cleanup, 'pending');
    assert.equal(owner.observation.exitedAt, undefined);
    stop.abort();
    await owner.retryCleanup();
    assert.equal(owner.cleanup, 'closed');
    assert.equal(owner.observation.exitCode, 0);
    assert.ok(owner.observation.exitedAt! >= owner.observation.readyAt!);
    assert.equal(await readFile(join(input.root, 'canceled'), 'utf8'), 'observed');
    assert.equal(await readFile(join(input.root, 'cleaned'), 'utf8'), 'quiesced');
    await owner.retryCleanup();
  });
});

test('an exited worker with unproven native cleanup cannot turn process exit into a release receipt', async (t) => {
  const input = await fixture(t, `
    process.on('message', (message) => {
      if (message.type === 'job') process.send({type:'result',payload:{kind:'failure',code:'fixture_cleanup_pending',cleanup:'pending'}},
        ()=>{process.exitCode=1;process.disconnect();});
    });
    process.send({type:'ready',processId:process.pid});
  `);
  const owner = await executeNativeWorker(input);
  for (let attempt = 0; owner.observation.exitedAt === undefined && attempt < 100; attempt++) await delay(10);
  assert.equal(owner.observation.exitCode, 1);
  assert.equal(owner.cleanup, 'pending');
  await assert.rejects(owner.retryCleanup(), { code: 'worker_cleanup_unproven' });
});

test('the production worker rejects an invalid candidate before acquiring any native resources', async (t) => {
  const input = await fixture(t, '');
  const owner = await executeNativeWorker({ ...input, worker: new URL('../worker.ts', import.meta.url) });
  assert.equal(owner.payload?.kind, 'failure');
  if (owner.payload?.kind !== 'failure') throw new Error('Production worker did not reject the candidate.');
  assert.equal(owner.payload.code, 'input_fields_invalid');
  assert.equal(owner.cleanup, 'closed');
  assert.equal(owner.observation.exitCode, 0);
});
