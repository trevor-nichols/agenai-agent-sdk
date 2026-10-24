// ------------------------------------------------------------------------------------------------
//                streams.test.ts - Binary stream behavior - Public backend and stream fixtures
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { SandboxOperationError } from '../src/index.js';
import { bytes, fixture, gate, nextTurn, processSpec, request } from './fixtures/backend.js';

const bounded = { timeout: 3000 };
const inProcess = Object.freeze({ kind: 'in_process' as const });

function write(target: Writable, value: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => target.write(value, (error) => error ? reject(error) : resolve()));
}

test('process streams preserve exact duplex binary bytes and keep stderr separate', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  const stdout = bytes(streams.stdout); const stderr = bytes(streams.stderr);
  await write(streams.stdin, Uint8Array.from([0, 255, 128, 13, 10, 65]));
  streams.stdin.end(Uint8Array.from([66, 0]));
  await new Promise<void>((resolve, reject) => { streams.stdin.once('finish', resolve); streams.stdin.once('error', reject); });
  physical.errorOutput.push(Buffer.from([254, 0, 69]));
  physical.output.push(null); physical.errorOutput.push(null);
  assert.deepEqual(await stdout, Buffer.from([0, 255, 128, 13, 10, 65, 66, 0]));
  assert.deepEqual(await stderr, Buffer.from([254, 0, 69]));
  assert.deepEqual(physical.inputBytes, [0, 255, 128, 13, 10, 65, 66, 0]);
  await sandbox.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('slow readers backpressure finite output without changing bytes', bounded, async () => {
  const physical = fixture({ output: Readable.from([Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8]), Buffer.from([9, 10, 11, 12])], { objectMode: false, highWaterMark: 1 }) });
  const sandbox = await physical.backend.reserve(request({ maxOutputBytes: 32, maxBufferedOutputBytes: 16, highWaterMarkBytes: 4 }), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  await nextTurn(); await nextTurn();
  assert.equal(streams.stdout.readableLength, 4);
  assert.equal(physical.resources.has('compute'), true);
  const stdout = await bytes(streams.stdout);
  assert.deepEqual(stdout, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});

test('combined output lifetime overflow fails output and initiates complete owned stop', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request({ maxOutputBytes: 8, maxBufferedOutputBytes: 8, highWaterMarkBytes: 2 }), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  const stdout = bytes(streams.stdout); const stderr = bytes(streams.stderr);
  const stdoutFailure = assert.rejects(stdout, (error: unknown) => { assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'output_limit'); return true; });
  const stderrFailure = assert.rejects(stderr, (error: unknown) => { assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'output_limit'); return true; });
  physical.output.push(Buffer.from([1, 2, 3, 4]));
  physical.errorOutput.push(Buffer.from([5, 6, 7, 8, 9]));
  await Promise.all([stdoutFailure, stderrFailure]);
  await sandbox.stop();
  assert.deepEqual([...physical.resources], ['storage']);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});

test('aggregate buffered overflow fails an abandoned output before retaining an oversized chunk', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request({ maxOutputBytes: 64, maxBufferedOutputBytes: 8, highWaterMarkBytes: 4 }), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  const stderrFailure = assert.rejects(bytes(streams.stderr), (error: unknown) => { assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'output_limit'); return true; });
  physical.output.push(Buffer.alloc(9, 1));
  await stderrFailure;
  assert.equal(streams.stdout.readableLength, 0);
  await sandbox.stop();
  assert.deepEqual([...physical.resources], ['storage']);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});

test('reader abandonment fences the other stream and removes the complete compute workload', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  const failed = assert.rejects(bytes(streams.stderr), (error: unknown) => { assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'stream_failure'); return true; });
  streams.stdout.destroy();
  await failed; await sandbox.stop();
  assert.deepEqual([...physical.resources], ['storage']);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});

test('stdin lifetime overflow and text chunks reject before delivery and stop compute', bounded, async () => {
  for (const kind of ['overflow', 'text'] as const) {
    const physical = fixture();
    const sandbox = await physical.backend.reserve(request({ maxStdinBytes: 4 }), inProcess).start();
    const streams = await sandbox.reserveProcess(processSpec).start();
    const outputFailure = assert.rejects(bytes(streams.stdout), SandboxOperationError);
    const written = new Promise<Error | null | undefined>((resolve) => {
      if (kind === 'text') streams.stdin.write('text is not protocol bytes', resolve);
      else streams.stdin.write(Uint8Array.from([1, 2, 3, 4, 5]), resolve);
    });
    const error = await written;
    assert.ok(error instanceof SandboxOperationError);
    assert.equal(error.code, kind === 'text' ? 'stream_failure' : 'input_limit');
    await outputFailure;
    assert.deepEqual(physical.inputBytes, []);
    await sandbox.stop(); assert.deepEqual([...physical.resources], ['storage']);
    await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
  }
});

test('stdin propagates physical backpressure and stop joins pending writes without a reader', bounded, async () => {
  const writeEntered = gate();
  const input = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { writeEntered.resolve(); } });
  const physical = fixture({ input });
  const sandbox = await physical.backend.reserve(request({ highWaterMarkBytes: 1 }), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  const writeResult = new Promise<Error | null | undefined>((resolve) => {
    assert.equal(streams.stdin.write(Buffer.from([1, 2]), resolve), false);
  });
  await writeEntered.promise;
  await sandbox.stop();
  const error = await writeResult;
  assert.ok(error instanceof Error);
  assert.deepEqual([...physical.resources], ['storage']);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});

test('omitted traffic quotas carry more than the retired 64 MiB ceiling through bounded streams', bounded, async () => {
  const chunk = Buffer.alloc(64 * 1024, 165);
  const source = async function* () { for (let index = 0; index < 1025; index++) yield chunk; };
  let inputBytes = 0;
  const inputDigest = createHash('sha256');
  const input = new Writable({ write(value: Uint8Array, _encoding, callback) {
    inputBytes += value.byteLength;
    inputDigest.update(value);
    callback();
  } });
  const physical = fixture({ input, output: Readable.from(source(), { objectMode: false, highWaterMark: chunk.length }) });
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  const outputDigest = createHash('sha256');
  let outputBytes = 0;
  const consuming = (async () => {
    for await (const value of streams.stdout) { outputBytes += value.length; outputDigest.update(value); }
  })();
  for (let index = 0; index < 1025; index++) await write(streams.stdin, chunk);
  await consuming;
  assert.equal(inputBytes, 67_174_400);
  assert.equal(outputBytes, 67_174_400);
  assert.equal(inputDigest.digest('hex'), 'c482597c1cc74218fe188c65867251897d9cd28725e9d721ab72b4d0ed6b84bd');
  assert.equal(outputDigest.digest('hex'), 'c482597c1cc74218fe188c65867251897d9cd28725e9d721ab72b4d0ed6b84bd');
  assert.equal(physical.resources.has('compute'), true);
  await sandbox.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('stdin bounds queued writes even when cumulative traffic is unlimited and backpressure is ignored', bounded, async () => {
  const entered = gate();
  const delivered: number[] = [];
  const input = new Writable({ highWaterMark: 1, write(chunk: Uint8Array) {
    delivered.push(...chunk);
    entered.resolve();
  } });
  const physical = fixture({ input });
  const sandbox = await physical.backend.reserve(request({ maxBufferedInputBytes: 4, highWaterMarkBytes: 1 }), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  const stoppedOutput = assert.rejects(bytes(streams.stdout), SandboxOperationError);
  streams.stdin.write(Buffer.from([1, 2, 3, 4]));
  await entered.promise;
  await assert.rejects(write(streams.stdin, Buffer.from([5])), (error: unknown) => {
    assert.ok(error instanceof SandboxOperationError);
    assert.equal(error.code, 'input_limit');
    assert.match(error.message, /buffered/);
    return true;
  });
  await stoppedOutput;
  assert.deepEqual(delivered, [1, 2, 3, 4]);
  await sandbox.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('startup timer is retired for established streams while execution timer owns later shutdown', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request({ startupMs: 15, execution: { kind: 'deadline', timeoutMs: 1000 } }), inProcess).start();
  const streams = await sandbox.reserveProcess(processSpec).start();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(physical.resources.has('compute'), true);
  await write(streams.stdin, Buffer.from([0, 241]));
  assert.deepEqual(physical.inputBytes, [0, 241]);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
  const timed = fixture();
  const timedSandbox = await timed.backend.reserve(request({ execution: { kind: 'deadline', timeoutMs: 15 } }), inProcess).start();
  await timedSandbox.reserveProcess(processSpec).start();
  await timed.stopping.promise;
  await timedSandbox.stop();
  assert.deepEqual([...timed.resources], ['storage']);
  await timedSandbox.destroy(); assert.deepEqual([...timed.resources], []);
});

test('decoded output cannot masquerade as binary protocol bytes', bounded, async () => {
  const output = new Readable({ read() {} }); output.setEncoding('utf8');
  const physical = fixture({ output });
  const sandbox = await physical.backend.reserve(request(), inProcess).start();
  await assert.rejects(sandbox.reserveProcess(processSpec).start(), (error: unknown) => { assert.ok(error instanceof SandboxOperationError); assert.equal(error.code, 'stream_failure'); return true; });
  await sandbox.stop(); assert.deepEqual([...physical.resources], ['storage']);
  await sandbox.destroy(); assert.deepEqual([...physical.resources], []);
});
