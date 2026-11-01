import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { joinOriginalChild } from './child.mjs';

test('a failed owner checkpoint still joins its original child and readers without termination', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-negative-child-'));
  const marker = join(directory, 'original-finished');
  try {
    await assert.rejects(joinOriginalChild({ command: process.execPath,
      args: ['-e', 'setTimeout(()=>{require("fs").writeFileSync(process.argv[1],"joined");process.stdout.write("original-reader-finished");},30)', marker],
      cwd: directory, env: { PATH: '/usr/bin:/bin' }, output: directory,
      async onSpawn() { throw new Error('owner checkpoint rejected'); } }), /owner checkpoint rejected/u);
    assert.equal(await readFile(marker, 'utf8'), 'joined');
    assert.equal(await readFile(join(directory, 'controller-stdout.log'), 'utf8'), 'original-reader-finished');
  } finally { await rm(directory, { recursive: true }); }
});
