// ------------------------------------------------------------------------------------------------
//                source-tests.test.mjs - Real Node file scheduling and owned failure settlement
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { credentialFreeEnvironment } from '../ci-profile.mjs';
import { runOwnedCommand } from '../command.mjs';
import { sourceTestCommand } from './source-tests.mjs';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

async function runSourceTests(root, testConcurrency) {
  const command = await sourceTestCommand({ integrationRoot: root, row: 'core', testConcurrency });
  const result = await runOwnedCommand({ command: command.command, args: command.args, cwd: repository,
    env: credentialFreeEnvironment(process.env, join(root, 'docker-config')), timeoutMs: 15_000 });
  return { ...result, selection: command.selection };
}

async function schedulingFixture(root, overlappingControl) {
  await mkdir(root);
  for (const name of ['baseline', 'recovery']) await writeFile(join(root, `${name}.test.ts`), `
import assert from 'node:assert/strict';
import { pbkdf2 } from 'node:crypto';
import { appendFile, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
const root = ${JSON.stringify(root)};
test('${name} source scenario', async () => {
  await writeFile(join(root, '${name}.pid'), String(process.pid));
  let active;
  try { active = await open(join(root, 'active'), 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await writeFile(join(root, 'overlap'), '${name}:overlap\\n');
    assert.fail('source test files overlapped');
  }
  await appendFile(join(root, 'events'), '${name}:start\\n');
  try {
    if (${overlappingControl}) {
      const deadline = performance.now() + 5_000;
      while (true) {
        try { await readFile(join(root, 'overlap')); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        assert(performance.now() < deadline, 'The overlapping control must enter both test files.');
        await delay(10);
      }
    } else {
      const bytes = await promisify(pbkdf2)('fixture-work', 'fixture-salt', 2_000_000, 16, 'sha256');
      assert.equal(bytes.byteLength, 16);
    }
  } finally {
    await active.close();
    await unlink(join(root, 'active'));
    await appendFile(join(root, 'events'), '${name}:end\\n');
  }
});
`);
  await writeFile(join(root, 'datasets.test.ts'), "throw new Error('The core row must exclude datasets.');\n");
}

test('selected source files serialize at one, while an overlapping control trips the same exclusive sentinel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-scheduling-'));
  try {
    const serial = join(root, 'serial');
    await schedulingFixture(serial, false);
    const result = await runSourceTests(serial, 1);
    assert.equal(result.status, 0);
    assert.equal(result.quiescent, true);
    assert.deepEqual(result.selection, { files: [join(serial, 'baseline.test.ts'), join(serial, 'recovery.test.ts')],
      requestedTestConcurrency: 1, effectiveTestConcurrency: 1 });
    assert.equal(await readFile(join(serial, 'events'), 'utf8'), 'baseline:start\nbaseline:end\nrecovery:start\nrecovery:end\n');
    assert.match(result.stdout, /baseline source scenario/u);
    assert.match(result.stdout, /recovery source scenario/u);
    assert.equal((await readdir(serial)).includes('active'), false);
    assert.equal((await readdir(serial)).includes('overlap'), false);

    const control = join(root, 'control');
    await schedulingFixture(control, true);
    const error = await runSourceTests(control, 2).catch((value) => value);
    assert.equal(error.status, 1);
    assert.equal(error.quiescent, true);
    assert.match(error.stdout, /source test files overlapped/u);
    assert.match(await readFile(join(control, 'overlap'), 'utf8'), /^(baseline|recovery):overlap\n$/u);
    assert.equal((await readdir(control)).includes('active'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source test failure stays nonzero and joins its entered producer before cleanup returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-source-failure-'));
  const producerMarker = join(root, 'producer.pid');
  const cleanupMarker = join(root, 'producer-cleanup');
  let producerPid;
  try {
    const producer = `const fs = require('node:fs');
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(cleanupMarker)}, 'producer settled\\n'); process.exit(0); });
fs.writeFileSync(${JSON.stringify(producerMarker)}, String(process.pid));
setInterval(() => {}, 1000);`;
    await writeFile(join(root, 'failure.test.ts'), `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
test('intentional source failure', async (t) => {
  const producer = spawn(process.execPath, ['-e', ${JSON.stringify(producer)}], { stdio: 'ignore' });
  const settled = once(producer, 'close');
  t.after(async () => { producer.kill('SIGTERM'); await settled; });
  const deadline = performance.now() + 5_000;
  while (true) {
    try { await readFile(${JSON.stringify(producerMarker)}); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(performance.now() < deadline, 'The owned producer must enter before the source test fails.');
    await delay(10);
  }
  assert.fail('intentional source assertion');
});
`);
    const error = await runSourceTests(root, 1).catch((value) => value);
    producerPid = Number(await readFile(producerMarker, 'utf8'));
    assert.equal(error.status, 1);
    assert.equal(error.quiescent, true);
    assert.match(error.stdout, /intentional source assertion/u);
    assert.equal(await readFile(cleanupMarker, 'utf8'), 'producer settled\n');
    assert.throws(() => process.kill(producerPid, 0), { code: 'ESRCH' });
  } finally {
    producerPid ??= Number(await readFile(producerMarker, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return 0; }));
    if (producerPid) {
      try { process.kill(producerPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('dataset selection runs its dataset and recovery children while excluding baseline scenarios', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platform-datasets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['datasets', 'recovery']) await writeFile(join(root, `${name}.test.ts`), `
import { appendFile } from 'node:fs/promises';
import test from 'node:test';
test('${name} selected child', () => appendFile(${JSON.stringify(join(root, 'entered'))}, '${name}\\n'));
`);
  await writeFile(join(root, 'baseline.test.ts'), "throw new Error('Dataset row entered a baseline child.');\n");
  const command = await sourceTestCommand({ integrationRoot: root, row: 'datasets', testConcurrency: 1 });
  const result = await runOwnedCommand({ command: command.command, args: command.args, cwd: repository,
    env: credentialFreeEnvironment(process.env, join(root, 'docker-config')), timeoutMs: 15_000 });
  assert.equal(result.status, 0); assert.equal(result.quiescent, true);
  assert.equal(await readFile(join(root, 'entered'), 'utf8'), 'datasets\nrecovery\n');
  assert.deepEqual(command.selection, { files: [join(root, 'datasets.test.ts'), join(root, 'recovery.test.ts')],
    requestedTestConcurrency: 1, effectiveTestConcurrency: 1 });
});
