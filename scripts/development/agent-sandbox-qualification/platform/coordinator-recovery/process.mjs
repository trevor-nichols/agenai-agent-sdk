import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { failure } from '../coordinator/evidence.mjs';

export async function verifyFreshProcess({ executable, script, inputPath, cwd, evidence, timeoutMs = 90_000, mode = '--absent' }) {
  assert(mode === '--absent' || mode === '--members-absent');
  const child = spawn(executable, [script, mode, inputPath], { cwd, detached: false,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { pid: child.pid, executable, arguments: [script, mode, inputPath], joined: false,
    code: null, signal: null, bytes: 0, outputTruncated: false, failure: null, intervention: false };
  const stdout = []; const stderr = [];
  const receive = (destination, bytes) => {
    result.bytes += bytes.length;
    if (result.bytes <= 64 * 1024) destination.push(bytes);
    else result.outputTruncated = true;
  };
  child.stdout.on('data', (bytes) => receive(stdout, bytes)); child.stderr.on('data', (bytes) => receive(stderr, bytes));
  child.on('error', (error) => { result.failure = failure(error); });
  child.stdout.on('error', (error) => { result.failure ??= failure(error); });
  child.stderr.on('error', (error) => { result.failure ??= failure(error); });
  child.once('close', (code, signal) => { result.joined = true; result.code = code; result.signal = signal; });
  const deadline = performance.now() + timeoutMs;
  while (!result.joined && performance.now() < deadline) await delay(25);
  if (!result.joined) {
    await evidence.event({ kind: 'fresh-verifier-retains-original-child', child: result,
      policy: 'No signal or kill was sent. Child cleanup owners remain in their original process.' });
    process.stdout.write(`${JSON.stringify({ status: 'retained_child', pid: process.pid, childPid: child.pid,
      inputPath, message: 'Waiting for the same fresh verification process; no replacement or forced termination.' })}\n`);
    while (!result.joined) await delay(1000);
  }
  result.stdout = await evidence.file('fresh-process-stdout.log', Buffer.concat(stdout), 64 * 1024);
  result.stderr = await evidence.file('fresh-process-stderr.log', Buffer.concat(stderr), 64 * 1024);
  await evidence.event({ kind: 'fresh-verification-process-joined', child: result });
  assert.equal(result.failure, null); assert.equal(result.outputTruncated, false);
  assert.equal(result.signal, null); assert.equal(result.code, 0);
  return result;
}
