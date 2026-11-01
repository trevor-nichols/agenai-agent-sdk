import assert from 'node:assert/strict';
import test from 'node:test';
import { settleOwnerCleanup } from './owner-cleanup.mjs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CleanupObligations, joinedCleanupChild } from '../cleanup/obligations.mjs';
import { joinOriginalChild } from '../../coordinator-negatives/child.mjs';

test('a finite cleanup observation retains the same entered owner operation until it settles', async () => {
  const actual = Promise.withResolvers(); let entered = 0;
  const owner = { state: { kind: 'destroying' }, recoveryRecord: { phase: 'destroying' },
    destroy() { entered += 1; return finished; } };
  const finished = actual.promise.then(() => { owner.state = { kind: 'destroyed' }; owner.recoveryRecord = { phase: 'destroyed' }; });
  await assert.rejects(settleOwnerCleanup(owner, 'destroy', { cleanupMs: 200, async observe() {} }), /did not settle/u);
  assert.equal(entered, 1, 'The first finite observation must actually enter the owned task.');
  assert.equal(owner.state.kind, 'destroying');
  const terminal = await settleOwnerCleanup(owner, 'destroy', { cleanupMs: 1000,
    async observe(value) { if (value.status === 'entered') actual.resolve(); } });
  assert.equal(entered, 1, 'An observation timeout cannot enter another cleanup operation.');
  assert.equal(terminal.status, 'fulfilled'); assert.equal(terminal.ownerState.kind, 'destroyed');
  assert.equal(terminal.recoveryRecord.phase, 'destroyed');
});

test('resident cleanup keeps the original reader and proxy until the same owner settles without advancing a failed case', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'qualifier-cleanup-owner-'));
  const program = `import assert from 'node:assert/strict';
    const done=Promise.withResolvers();let destroys=0,readers=0,proxies=0,nextCases=0;
    const owner={state:{kind:'destroying'},recoveryRecord:{phase:'destroying'},destroy(){destroys++;return done.promise.then(()=>{
      owner.state={kind:'destroyed'};owner.recoveryRecord={phase:'destroyed'};return {kind:'destroyed',original:true};});}};
    const evidence={status:'failed',owners:[{namespace:'original'}],observations:[],census:[],cleanupErrors:[]};
    const run={evidence,owners:[{namespace:'original',owner}],afterCleanup:[],
      sessions:[{async join(){assert.equal(owner.state.kind,'destroyed');readers++;return {exitCode:0,streamsJoined:true};}}],
      proxies:[{async close(){assert.equal(readers,1);proxies++;}}],async save(){
        if(evidence.retainedCleanup&&!run.released){run.released=true;
          assert.equal(destroys,1);assert.equal(readers,0);assert.equal(proxies,0);assert.equal(nextCases,0);
          done.resolve();process.kill(process.pid,'SIGUSR2');}
      }};
    const {finishRunCleanup}=await import(${JSON.stringify(new URL('../cleanup/obligations.mjs', import.meta.url).href)});
    await finishRunCleanup(run,{timeoutMs:20,readerKind:'original-reader',async census(){
      assert.equal(readers,0);assert.equal(proxies,0);return [{httpStatus:404}];}});
    if(evidence.status==='passed')nextCases++;
    console.log(JSON.stringify({phase:'finished',cleanupComplete:evidence.cleanupComplete,failed:evidence.status==='failed',
      history:evidence.cleanupErrors,finalRecord:evidence.owners[0].finalRecord,reader:evidence.observations[0],census:evidence.census,
      destroys,readers,proxies,nextCases}));`;
  try {
    const child = await joinOriginalChild({ command: process.execPath, args: ['--input-type=module', '-e', program],
      cwd: directory, env: { PATH: '/usr/bin:/bin' }, output: directory, async onSpawn() {} });
    assert.equal(child.code, 0, await readFile(join(directory, 'controller-stderr.log'), 'utf8'));
    const [retained, finished] = (await readFile(join(directory, 'controller-stdout.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(retained.status, 'retained_cleanup'); assert(retained.steps.some(({ name, state }) => name === 'destroy-original' && state === 'entered'));
    assert.equal(finished.cleanupComplete, true); assert.equal(finished.failed, true); assert.equal(finished.history.length, 1);
    assert.deepEqual([finished.destroys, finished.readers, finished.proxies, finished.nextCases], [1, 1, 1, 0]);
    assert.deepEqual(finished.finalRecord, { phase: 'destroyed' }); assert.deepEqual(finished.census, [{ httpStatus: 404 }]);
    assert.deepEqual(finished.reader, { kind: 'original-reader', result: { exitCode: 0, streamsJoined: true } });
  } finally { await rm(directory, { recursive: true }); }
});

test('rejected evidence after a confirmed cleanup effect never replays it or holds settled resources', async () => {
  let effects = 0, closed = 0, complete = false; const history = [];
  const cleanup = new CleanupObligations({ timeoutMs: 100, onFailure: (error) => { history.push(error.message); } });
  const finish = async () => {
    await cleanup.step('restore', async () => { effects++; complete = true; throw new Error('publication rejected after restore'); },
      { retryRejected: true, complete: () => complete });
    await cleanup.step('proxy', async () => { closed++; });
  };
  await finish(); await finish();
  assert.deepEqual([effects, closed], [1, 1]); assert.equal(cleanup.failed, true);
  assert.deepEqual(history, ['publication rejected after restore']); assert(cleanup.snapshot().every((entry) => entry.settled));
});

test('an entered cleanup child joins after PID publication fails and is never dispatched again on evidence retry', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'qualifier-cleanup-child-'));
  const physical = join(directory, 'physical.json'), effects = join(directory, 'effects.log');
  let prepared = 0;
  const run = { evidence: { cleanupErrors: [] }, async save() { throw new Error('PID receipt publication rejected'); } };
  const prepare = async () => {
    prepared++;
    return { command: process.execPath, args: ['--input-type=module', '-e', `import{appendFile,writeFile}from'node:fs/promises';
      import{nativeControllerReady}from ${JSON.stringify(new URL('../../native-controller.mjs', import.meta.url).href)};
      process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});await nativeControllerReady();
      await appendFile(${JSON.stringify(effects)},'original cleanup\\n');
      await writeFile(${JSON.stringify(physical)},JSON.stringify({pid:process.pid,readerJoined:true,proxyClosed:true}));`],
      cwd: directory, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1000 };
  };
  try {
    const original = await joinedCleanupChild(run, 'original', prepare);
    assert.match(original.message, /PID receipt publication rejected/u); assert.equal(original.quiescent, true); assert.equal(original.status, 0);
    const actual = JSON.parse(await readFile(physical, 'utf8'));
    assert.deepEqual(actual, { pid: original.pid, readerJoined: true, proxyClosed: true });
    assert.equal((await joinedCleanupChild(run, 'original', prepare)).pid, actual.pid);
    assert.equal(prepared, 1); assert.equal(await readFile(effects, 'utf8'), 'original cleanup\n');
    assert.equal(run.evidence.cleanupChildren[0].pid, actual.pid); assert.equal(run.evidence.cleanupErrors.length, 1);
  } finally { await rm(directory, { recursive: true }); }
});

test('child cleanup proves each owner destroyed by the terminal fact its contract exposes', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'qualifier-child-owner-'));
  const cleanup = async (name, owner) => {
    const output = join(directory, name); await mkdir(output);
    const program = `let destroys=0;const owner=${owner};
      const result={status:'passed',cleanupErrors:[]};
      const {finishChildCleanup}=await import(${JSON.stringify(new URL('../cleanup/obligations.mjs', import.meta.url).href)});
      await finishChildCleanup({result,owners:[owner],sessions:[],timeoutMs:1000,async save(){
        if(result.retainedCleanup){console.log(JSON.stringify({phase:'retained',result,destroys}));process.exit(3);}}});
      console.log(JSON.stringify({phase:'finished',result,destroys}));`;
    const child = await joinOriginalChild({ command: process.execPath, args: ['--input-type=module', '-e', program],
      cwd: directory, env: { PATH: '/usr/bin:/bin' }, output, async onSpawn() {} });
    return { code: child.code, ...JSON.parse(await readFile(join(output, 'controller-stdout.log'), 'utf8')) };
  };
  const reconciled = (phase) => `{recoveryRecord:{phase:'running'},async stop(){},
    async destroy(){destroys++;owner.recoveryRecord={phase:'${phase}'};}}`;
  try {
    assert.deepEqual(await cleanup('reconciled', reconciled('destroyed')), { code: 0, phase: 'finished', destroys: 1,
      result: { status: 'passed', cleanupErrors: [], finalRecord: { phase: 'destroyed' }, cleanupComplete: true } });
    // An unverified reservation keeps its last durable phase; its lifecycle state carries destruction.
    assert.deepEqual(await cleanup('unverified-reservation', `{state:{kind:'ready'},recoveryRecord:{phase:'reserved'},async stop(){},
      async destroy(){destroys++;owner.state={kind:'destroyed'};}}`), { code: 0, phase: 'finished', destroys: 1,
      result: { status: 'passed', cleanupErrors: [], finalRecord: { phase: 'reserved' }, cleanupComplete: true } });
    const unproven = await cleanup('unproven', reconciled('destroying'));
    assert.equal(unproven.code, 3); assert.equal(unproven.phase, 'retained'); assert.equal(unproven.destroys, 1);
    assert.equal(unproven.result.status, 'failed'); assert.deepEqual(unproven.result.cleanupErrors.map(({ step }) => step), ['cleanup']);
  } finally { await rm(directory, { recursive: true }); }
});
