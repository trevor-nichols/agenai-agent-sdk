import assert from 'node:assert/strict';
import test from 'node:test';
import { observeCoordinatorCrash } from './coordinator-crash-process.mjs';

const options = { executable: process.execPath, cwd: '/', env: { PATH: '/usr/bin:/bin' } };

test('expected controller SIGKILL passes only after natural process-group settlement', { timeout: 10_000 }, async () => {
  const result = await observeCoordinatorCrash({ ...options, args: ['--input-type=module', '--eval', "process.kill(process.pid, 'SIGKILL')"], timeoutMs: 5_000 });
  assert.deepEqual({ status: result.status, signal: result.signal, quiescent: result.quiescent, intervention: result.intervention,
    stdout: result.stdout, stderr: result.stderr },
  { status: null, signal: 'SIGKILL', quiescent: true, intervention: false, stdout: '', stderr: '' });
});

test('a surviving holder makes crash proof fail even when forced cleanup later succeeds', { timeout: 15_000 }, async () => {
  const script = `import { spawn } from 'node:child_process';
const survivor = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
survivor.once('spawn', () => process.kill(process.pid, 'SIGKILL'));`;
  await assert.rejects(observeCoordinatorCrash({ ...options, args: ['--input-type=module', '--eval', script], timeoutMs: 750 }), (error) => {
    assert.match(error.message, /did not settle naturally/u);
    assert.equal(error.status, null); assert.equal(error.signal, 'SIGKILL');
    assert.equal(error.intervention, true); assert.equal(error.quiescent, true);
    assert.throws(() => process.kill(-error.pid, 0), { code: 'ESRCH' });
    return true;
  });
});
