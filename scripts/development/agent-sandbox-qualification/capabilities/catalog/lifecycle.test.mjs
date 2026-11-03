import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { catalogReader, observeWork } from './lifecycle.mjs';

test('one guest reader returns the bounded record only after both streams and leader exit join', async () => {
  const stdout = new PassThrough(), stderr = new PassThrough(), exit = Promise.withResolvers();
  const reader = catalogReader({ stdout, stderr, exit: exit.promise }, (value) => value);
  let settled = false; void reader.result.finally(() => { settled = true; });
  stdout.end('{"catalog":"actual"}\n'); stderr.end('discarded native stderr');
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  exit.resolve({ kind: 'exited', code: 0 });
  assert.deepEqual(await reader.result, { result: { catalog: 'actual' }, exit: { kind: 'exited', code: 0 }, stdoutJoined: true, stderrJoined: true });
});

test('output capacity interrupts observation while the original SDK reader keeps draining to closure', async () => {
  const stdout = new PassThrough(), stderr = new PassThrough(), exit = Promise.withResolvers();
  const reader = catalogReader({ stdout, stderr, exit: exit.promise }, (value) => value);
  stdout.write(Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(reader.result, { code: 'guest_output_capacity' });
  let joined = false; void reader.join().catch(() => {}).finally(() => { joined = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(joined, false);
  stdout.end(); stderr.end(); exit.resolve({ kind: 'exited', code: 0 });
  await assert.rejects(reader.join(), { code: 'guest_output_capacity' });
});

test('a work deadline leaves actual work owned until its later settlement', async () => {
  const work = Promise.withResolvers(); let settled = false;
  void work.promise.finally(() => { settled = true; });
  await assert.rejects(observeWork(work.promise, { timeoutMs: 10 }), { code: 'observation_deadline' });
  assert.equal(settled, false); work.resolve(); await work.promise; assert.equal(settled, true);
});

test('cleanup failure retains the original credential process and sandbox owners until an explicit retry succeeds', async (t) => {
  for (const failureAt of ['credential_process', 'sandbox_destroy']) await t.test(failureAt, async () => {
  const module = new URL('./lifecycle.mjs', import.meta.url).href;
  const source = `import {finishCatalogCleanup} from ${JSON.stringify(module)};
    let processStopCalls=0,stopCalls=0,destroyCalls=0,disposed=false,readerJoined=false;
    const processOwner={async stop(){processStopCalls++;if(${JSON.stringify(failureAt)}==='credential_process'&&processStopCalls===1)throw Error('private prefix failure');}};
    const owner={state:{kind:'ready'},recoveryRecord:{phase:'ready'},async stop(){stopCalls++;this.state={kind:'stopped'};},
      async destroy(){destroyCalls++;if(${JSON.stringify(failureAt)}==='sandbox_destroy'&&destroyCalls===1)throw Error('private failure');this.state={kind:'destroyed'};this.recoveryRecord={phase:'destroyed'};}};
    const state={owner,processOwner,credential:{dispose(){disposed=true;}},reader:{async join(){readerJoined=true;return {result:{}};}}};
    const report={status:'running',failure:null,cleanup:{complete:false,failures:[]}};
    await finishCatalogCleanup({state,report,timeoutMs:100,save:async()=>{if(report.cleanup.retained&&!report.cleanup.complete)process.send({kind:'retained',pid:process.pid,disposed,readerJoined,processStopCalls,stopCalls,destroyCalls});},
      independentAbsence:async(record)=>{if(record.phase!=='destroyed')throw Error('premature absence');return [{status:404}];}});
    process.send({kind:'complete',pid:process.pid,disposed,readerJoined,processStopCalls,stopCalls,destroyCalls,report});process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let retained, complete, diagnostics = '';
  const outcome = new Promise((resolve, reject) => {
    child.stdout.resume(); child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
    child.on('message', (value) => {
      if (value.kind === 'retained' && !retained) { retained = value; child.kill('SIGUSR2'); }
      if (value.kind === 'complete') complete = value;
    });
    child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error(diagnostics)));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await outcome; } finally { clearTimeout(timer); }
  assert.deepEqual(retained, { kind: 'retained', pid: child.pid, disposed: false, readerJoined: false, processStopCalls: 1,
    stopCalls: failureAt === 'sandbox_destroy' ? 1 : 0, destroyCalls: failureAt === 'sandbox_destroy' ? 1 : 0 });
  assert.equal(complete.pid, child.pid); assert.equal(complete.stopCalls, 1);
  assert.equal(complete.processStopCalls, failureAt === 'credential_process' ? 2 : 1);
  assert.equal(complete.destroyCalls, failureAt === 'sandbox_destroy' ? 2 : 1);
  assert.equal(complete.disposed, true); assert.equal(complete.readerJoined, true); assert.equal(complete.report.cleanup.complete, true);
  assert.equal(complete.report.status, 'failed'); assert.deepEqual(complete.report.cleanup.absence, [{ status: 404 }]);
  });
});
