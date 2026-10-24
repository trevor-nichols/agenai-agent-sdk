// ------------------------------------------------------------------------------------------------
//                memory.test.mjs - Independent sampler work, selected-budget failure and actual join
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { records } from './manifests.mjs';
import { runObservedController } from './memory.mjs';

async function fixture(t, exceed) {
  const output = await mkdtemp(join(tmpdir(), 'sandbox-scale-observer-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const controllerPath = join(output, 'controlled.mjs');
  await writeFile(controllerPath, `
import { writeFile } from 'node:fs/promises';
const configuration = process.argv[2];
const finish = async () => { await writeFile(configuration, 'finally-joined'); if (process.connected) process.disconnect(); };
process.on('SIGTERM', finish);
process.on('message', (message) => {
  if (message.kind === 'memory') {
    process.send({ kind:'memory', id:message.id, pid:process.pid, phase:'real-work', memory:process.memoryUsage() });
    ${exceed ? '' : 'setTimeout(finish, 400);'}
  }
});
`);
  return { output, controllerPath, configurationPath: join(output, 'joined.txt'), consumer: output,
    budgets: { rssBytes: 1024 ** 3, externalBytes: exceed ? 1 : 256 * 1024 ** 2 }, env: { PATH: '/usr/bin:/bin' } };
}

test('separate sampler observes the actual controller PID and streams bounded memory evidence', async (t) => {
  const options = await fixture(t, false);
  const result = await runObservedController(options);
  assert.equal(result.failure, null);
  assert(result.samples > 0);
  assert.notEqual(result.controllerPid, process.pid);
  assert.equal(result.controllerIdentity.pid, result.controllerPid);
  assert(result.peaks.rssBytes > 0 && result.peaks.externalBytes > 0);
  assert.equal(result.commandQuiescent, true);
  let count = 0;
  for await (const sample of records(join(options.output, 'memory-samples.jsonl'))) {
    assert.equal(sample.pid, result.controllerPid);
    assert.equal(sample.phase, 'real-work');
    assert(sample.rssBytes > 0 && sample.externalBytes > 0);
    count += 1;
  }
  assert.equal(count, result.samples);
  assert.equal(await readFile(options.configurationPath, 'utf8'), 'finally-joined');
});

test('a caller-selected external-memory budget failure terminates cooperatively and joins actual finally work', async (t) => {
  const options = await fixture(t, true);
  const result = await runObservedController(options);
  assert.match(result.failure.message, /qualification external-memory budget/u);
  assert.equal(result.commandQuiescent, true);
  assert.equal(await readFile(options.configurationPath, 'utf8'), 'finally-joined');
  assert.equal(result.exit.code, 0);
});
