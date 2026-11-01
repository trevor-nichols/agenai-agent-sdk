import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinOriginalChild } from './child.mjs';

test('failed evidence publication cannot release a retained original cleanup capability', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-negative-retain-'));
  const program = `import assert from 'node:assert/strict';import {setImmediate} from 'node:timers/promises';
    import {retainUntilFinished} from ${JSON.stringify(new URL('./cleanup.mjs', import.meta.url).href)};
    const report={cleanupFailures:[],evidenceFailures:[]};let attempts=0;
    const settled=retainUntilFinished(async()=>{attempts++;if(attempts===1)throw new Error('original scope still active');},
      report,async()=>{throw new Error('evidence volume unavailable');});
    await setImmediate();assert.equal(attempts,1);assert.equal(report.cleanupComplete,false);
    process.kill(process.pid,'SIGUSR2');await settled;console.log(JSON.stringify({attempts,report}));`;
  try {
    const child = await joinOriginalChild({ command: process.execPath, args: ['--input-type=module', '-e', program],
      cwd: directory, env: { PATH: '/usr/bin:/bin' }, output: directory, async onSpawn() {} });
    assert.equal(child.code, 0, await readFile(join(directory, 'controller-stderr.log'), 'utf8'));
    const output = (await readFile(join(directory, 'controller-stdout.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(output[0].status, 'retained_cleanup');
    assert.equal(output[1].attempts, 2);
    assert.equal(output[1].report.cleanupFailures[0].message, 'original scope still active');
    assert.equal(output[1].report.evidenceFailures[0].message, 'evidence volume unavailable');
  } finally { await rm(directory, { recursive: true }); }
});
