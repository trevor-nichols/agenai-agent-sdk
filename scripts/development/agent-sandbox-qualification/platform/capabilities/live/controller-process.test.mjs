import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startController } from './controller-process.mjs';

test('an original controller work deadline joins its graceful cleanup without killing its group', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'original-controller-deadline-'));
  const script = join(directory, 'controller.mjs'), started = join(directory, 'cleanup-entered'), release = join(directory, 'release');
  await writeFile(script, `import {access,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeControllerReady} from ${JSON.stringify(new URL('../../native-controller.mjs', import.meta.url).href)};
const keepAlive=setInterval(()=>{},1000);const interrupted=Promise.withResolvers();process.on('SIGTERM',()=>interrupted.resolve());process.on('SIGINT',()=>interrupted.resolve());
await nativeControllerReady();await interrupted.promise;await writeFile(${JSON.stringify(started)},String(process.pid));
for(;;){try{await access(${JSON.stringify(release)});break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(10);}}
clearInterval(keepAlive);console.log(JSON.stringify({phase:'cleanup-complete',pid:process.pid,readerJoined:true,proxyClosed:true}));
`);
  const child = startController({ script, configuration: join(directory, 'unused.json'), cwd: directory,
    env: { PATH: '/usr/bin:/bin' }, timeoutMs: 100, maxOutputBytes: 65536 });
  try {
    const deadline = performance.now() + 5000;
    for (;;) {
      try { assert.equal(Number(await readFile(started, 'utf8')), child.pid); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; assert(performance.now() < deadline, 'Original graceful cleanup was never entered.'); await delay(10); }
    }
    process.kill(child.pid, 0);
    assert.deepEqual(child.controls, [], 'A finite work failure cannot enter the planned group-kill fixture.');
    await writeFile(release, 'release', { flag: 'wx' });
    await assert.rejects(child.join(), (error) => {
      assert.match(error.message, /exceeded its deadline/u); assert.equal(error.quiescent, true);
      assert.deepEqual(JSON.parse(error.stdout), { phase: 'cleanup-complete', pid: child.pid, readerJoined: true, proxyClosed: true });
      assert.equal(error.stderr, ''); return true;
    });
  } finally {
    await writeFile(release, 'release'); await child.join().catch(() => {}); await rm(directory, { recursive: true });
  }
});

test('cleanup resumes the exact stopped child even when pause and resume evidence publication reject', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'original-controller-resume-'));
  const script = join(directory, 'controller.mjs'), completed = join(directory, 'complete.json');
  await writeFile(script, `import{writeFile,rename}from'node:fs/promises';
import{nativeControllerReady}from ${JSON.stringify(new URL('../../native-controller.mjs', import.meta.url).href)};
const keepAlive=setInterval(()=>{},1000),interrupted=Promise.withResolvers();process.on('SIGTERM',()=>interrupted.resolve());process.on('SIGINT',()=>interrupted.resolve());
await nativeControllerReady();console.log(JSON.stringify({phase:'ready',pid:process.pid}));await interrupted.promise;
await writeFile(${JSON.stringify(completed + '.next')},JSON.stringify({pid:process.pid,originalCleanup:true}));
await rename(${JSON.stringify(completed + '.next')},${JSON.stringify(completed)});clearInterval(keepAlive);
`);
  const child = startController({ script, configuration: join(directory, 'unused.json'), cwd: directory,
    env: { PATH: '/usr/bin:/bin' }, timeoutMs: 30000, maxOutputBytes: 65536,
    async onControl(observation) {
      if (observation.signal === 'SIGCONT' || observation.signal === 'SIGSTOP' && observation.status === 'sent') throw new Error('control evidence rejected');
    } });
  try {
    await child.ready(5000); await assert.rejects(child.pause(), /control evidence rejected/u);
    const finishing = child.finish().catch((error) => error);
    const deadline = performance.now() + 5000;
    for (;;) {
      try { assert.deepEqual(JSON.parse(await readFile(completed, 'utf8')), { pid: child.pid, originalCleanup: true }); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; assert(performance.now() < deadline, 'Same stopped child never resumed its original cleanup.'); await delay(10); }
    }
    const failure = await finishing;
    assert.match(failure.message, /control evidence rejected/u); assert.equal(failure.quiescent, true);
    assert.deepEqual(child.controls.map(({ signal, status }) => ({ signal, status })),
      [{ signal: 'SIGSTOP', status: 'sent' }, { signal: 'SIGCONT', status: 'sent' }]);
  } finally {
    // Only this benign fixture is signalled if a regressed implementation strands it stopped.
    try { process.kill(child.pid, 'SIGCONT'); process.kill(child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await child.join().catch(() => {}); await rm(directory, { recursive: true });
  }
});
