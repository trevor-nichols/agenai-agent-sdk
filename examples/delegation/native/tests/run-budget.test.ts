import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { NativeCandidate, NativeSelection } from '../contracts.js';

test('one invocation deadline spans preflight and sequential workers while retaining independent cleanup', async (t) => {
  // Module mocks are confined to this owned child; the normal example test command needs no experimental flag.
  if (!process.execArgv.includes('--experimental-test-module-mocks')) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', import.meta.resolve('tsx'),
      '--test', fileURLToPath(import.meta.url)], { env, timeout: 15_000, maxBuffer: 32_768 });
    assert.match(result.stdout, /tests 1/u);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'native-invocation-budget-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, 'worker.mjs');
  await writeFile(worker, `
    import {access, writeFile} from 'node:fs/promises';
    let root, kind, settled = false;
    const keepAlive = setInterval(() => {}, 10);
    process.on('message', async message => {
      if (message.type === 'job') {
        ({root, kind} = message.job);
        await writeFile(root+'/'+kind, 'started');
        if (kind === 'install') {
          for (;;) { try { await access(root+'/finish-install'); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
          const identity = {bytes:1, sha256:'a'.repeat(64)};
          process.send({type:'result', payload:{kind:'installed', cleanup:'closed', installation:{
            format:'native-local-raw-installation-v1', storeRoot:root, installerProcessId:process.pid,
            allocationId:'fixture-allocation', snapshotDigest:'sha256:'+'a'.repeat(64), planDigest:'sha256:'+'a'.repeat(64),
            installationId:'fixture-installation', receiptDigest:'sha256:'+'a'.repeat(64), native:identity,
            transformation:{...identity, decoded:identity, decoderExecutableSha256:'a'.repeat(64),
              pythonVersion:'fixture', zlibCompileVersion:'fixture', zlibRuntimeVersion:'fixture'}}}},
            () => { clearInterval(keepAlive); process.disconnect(); });
        }
      } else if (message.type === 'cancel') {
        await writeFile(root+'/canceled', 'observed');
        if (!settled) { settled = true; process.send({type:'result', payload:{kind:'failure', code:'budget_exhausted', cleanup:'pending'}}); }
      } else if (message.type === 'cleanup') {
        await writeFile(root+'/cleaned', 'quiesced');
        clearInterval(keepAlive);
        process.send({type:'cleanup', status:'closed', requestId:message.requestId}, () => process.disconnect());
      }
    });
    process.send({type:'ready', processId:process.pid});
  `, { mode: 0o600 });
  const exists = async (name: string) => {
    try { await readFile(join(root, name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const waitFor = async (name: string, maximumMs = 2_000) => {
    const until = performance.now() + maximumMs;
    while (performance.now() < until) { if (await exists(name)) return true; await setImmediate(); }
    return false;
  };
  const identity = await import('../identity.js');
  const workers = await import('../process.js');
  const caller = new AbortController();
  let deadlineCanceled = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.module(new URL('../identity.ts', import.meta.url).href, { namedExports: { ...identity,
    async assertSdkIdentity() { t.mock.timers.tick(20_000); }, async assertRunnerIdentity() {} } });
  t.mock.module(new URL('../process.ts', import.meta.url).href, { namedExports: { ...workers,
    async executeNativeWorker(input: Parameters<typeof workers.executeNativeWorker>[0]) {
      const pending = workers.executeNativeWorker({ ...input, worker: pathToFileURL(worker) });
      assert.equal(await waitFor(input.job.kind), true);
      if (input.job.kind === 'install') {
        t.mock.timers.tick(80_000);
        await writeFile(join(root, 'finish-install'), 'continue');
      } else {
        t.mock.timers.tick(199_999);
        assert.equal(await exists('canceled'), false);
        t.mock.timers.tick(1);
        deadlineCanceled = await waitFor('canceled', 250);
        // Unblock the pre-fix fixture so a missing deadline produces an assertion failure, never a hung worker.
        if (!deadlineCanceled) caller.abort();
      }
      return pending;
    } } });
  const { runNativeOperation } = await import('../run.js');
  const result = await runNativeOperation({ command: 'execute', launch: 'registry', root, signal: caller.signal,
    candidate: {} as NativeCandidate, selection: {} as NativeSelection });
  assert.ok(result.retryCleanup);
  t.after(() => result.retryCleanup!());
  assert.equal(result.cleanup, 'pending');
  assert.equal(result.processProof.run?.exitedAt, undefined);
  t.mock.timers.tick(30_001);
  assert.equal(await exists('cleaned'), false);
  await result.retryCleanup();
  assert.equal(await readFile(join(root, 'cleaned'), 'utf8'), 'quiesced');
  assert.throws(() => process.kill(result.processProof.run!.processId, 0), { code: 'ESRCH' });
  assert.equal(deadlineCanceled, true, 'The operator must receive cancellation at the original invocation deadline.');
});
