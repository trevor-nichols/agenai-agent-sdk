// ------------------------------------------------------------------------------------------------
//                process.test.ts - Docker exec bytes, framing and ownership - Public backend tests
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { Readable, type Writable } from 'node:stream';
import test from 'node:test';
import { parseSandboxRequest, SandboxCleanupError, SandboxOperationError, SandboxStateError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import { gate, sandboxRequest } from './fixtures/engine.js';
import { execId, frame, processFixture } from './fixtures/process.js';

const bounded = { timeout: 5000 };
const recovery = { kind: 'in_process' as const };
const recipe = { executable: '/guest/bin/peer', args: ['literal;argument', 'two words'], env: { EXPLICIT: 'literal=guest' }, cwd: '/workspace/work' };
async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function write(target: Writable, value: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => target.write(value, (error) => error ? reject(error) : resolve()));
}

test('inert once-only exec preserves literal recipe, split/coalesced binary frames and outbound half-close', bounded, async () => {
  const first = frame(1, Uint8Array.of(0, 255, 13, 10));
  const fixture = await processFixture({ initialBytes: first.subarray(0, 3) });
  const reservation = fixture.backend.reserve(sandboxRequest(), recovery);
  try {
    const sandbox = await reservation.start();
    const before = fixture.effects.length;
    const process = sandbox.reserveProcess(recipe);
    assert.equal(fixture.effects.length, before);
    assert.equal(process.stopScope, 'sandbox');
    const streams = await process.start();
    const stdout = bytes(streams.stdout); const stderr = bytes(streams.stderr);
    const peer = await fixture.attached.promise;
    peer.write(Buffer.concat([first.subarray(3), frame(2, Uint8Array.of(128, 0, 69)), frame(1, Uint8Array.of(65, 0))]));
    await write(streams.stdin, Uint8Array.of(0, 254, 128, 10));
    streams.stdin.end();
    await fixture.inputEnded.promise;
    // Output after the write side closes must still arrive through the same upgraded connection.
    peer.end(frame(1, Uint8Array.of(66, 255)));
    fixture.exit(7);
    assert.deepEqual(await stdout, Buffer.from([0, 255, 13, 10, 65, 0, 66, 255]));
    assert.deepEqual(await stderr, Buffer.from([128, 0, 69]));
    assert.deepEqual(Buffer.concat(fixture.inputBytes), Buffer.from([0, 254, 128, 10]));
    assert.deepEqual(await streams.exit, { kind: 'exited', code: 7 });
    const create = fixture.effects.find((effect) => effect.path.endsWith('/exec'));
    assert.deepEqual(create?.body, { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Privileged: false,
      Cmd: ['/guest/bin/peer', 'literal;argument', 'two words'], Env: ['HOME=/home/sandbox', 'TMPDIR=/tmp', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'EXPLICIT=literal=guest'],
      WorkingDir: '/workspace/work', User: '65534:65534' });
    assert.deepEqual(fixture.upgrades, [{ path: `/v1.52/exec/${execId}/start`, body: { Detach: false, Tty: false } }]);
    await assert.rejects(process.start(), SandboxStateError);
    assert.equal(fixture.createCount, 1);
    assert.equal([...fixture.containers.values()].filter((container) => container.State.Running).length, 1);
    await process.stop();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 1, volumes: 1 });
    await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { await reservation.destroy(); await fixture.close(); }
});

test('fixed guest environment changes reject before creating an exec', bounded, async () => {
  const fixture = await processFixture();
  const reservation = fixture.backend.reserve(sandboxRequest(), recovery);
  try {
    const sandbox = await reservation.start();
    assert.throws(() => sandbox.reserveProcess({ ...recipe, env: { HOME: '/workspace/leak' } }), SandboxUnsupportedError);
    assert.equal(fixture.createCount, 0);
    assert.equal(fixture.upgrades.length, 0);
  } finally { await reservation.destroy(); await fixture.close(); }
});

for (const initialState of ['running', 'pending'] as const) {
  test(`a native ${initialState} exec with null ExitCode keeps its streams and ownership until a numeric terminal receipt`, bounded, async () => {
    const pauseStart = initialState === 'pending' ? gate() : undefined;
    const fixture = await processFixture({ runningExitCode: null, pauseStart });
    const reservation = fixture.backend.reserve(sandboxRequest(), recovery);
    try {
      const sandbox = await reservation.start();
      const streams = await sandbox.reserveProcess(recipe).start();
      const stdout = bytes(streams.stdout); const stderr = bytes(streams.stderr);
      void stdout.catch(() => {}); void stderr.catch(() => {});
      await fixture.inspectionEntered.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 125));
      assert.equal(fixture.containers.size, 2, 'A null exit code must preserve the owned live compute.');
      pauseStart?.resolve();
      await fixture.started.promise;
      await write(streams.stdin, Uint8Array.of(0, 255, 128));
      const peer = await fixture.attached.promise;
      fixture.exit(19);
      peer.end(Buffer.concat([frame(1, Uint8Array.of(0, 128, 255)), frame(2, Uint8Array.of(254, 0))]));
      assert.deepEqual(await stdout, Buffer.from([0, 128, 255]));
      assert.deepEqual(await stderr, Buffer.from([254, 0]));
      assert.deepEqual(Buffer.concat(fixture.inputBytes), Buffer.from([0, 255, 128]));
      assert.deepEqual(await streams.exit, { kind: 'exited', code: 19 });
      assert.equal(fixture.containers.size, 2, 'The terminal receipt must still retain whole-sandbox cleanup ownership.');
    } finally { pauseStart?.resolve(); await reservation.destroy(); await fixture.close(); }
  });
}

test('an exec that remains pending is stopped by its execution deadline without an invented leader exit receipt', bounded, async () => {
  const pauseStart = gate();
  const fixture = await processFixture({ pauseStart });
  const request = sandboxRequest();
  const reservation = fixture.backend.reserve(parseSandboxRequest({ policy: { ...request.policy,
    execution: { kind: 'deadline', timeoutMs: 500 } } }), recovery);
  try {
    const sandbox = await reservation.start();
    const streams = await sandbox.reserveProcess(recipe).start();
    const stdout = bytes(streams.stdout).catch(() => Buffer.alloc(0));
    const stderr = bytes(streams.stderr).catch(() => Buffer.alloc(0));
    await fixture.inspectionEntered.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 125));
    assert.equal(fixture.containers.size, 2, 'Pending startup must remain owned before the execution deadline.');
    assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
    await stdout; await stderr;
    await sandbox.stop();
    assert.equal(fixture.containers.size, 1);
    assert.deepEqual({ creates: fixture.createCount, starts: fixture.upgrades.length }, { creates: 1, starts: 1 });
  } finally { pauseStart.resolve(); await reservation.destroy(); await fixture.close(); }
});

test('a lost exec-start acknowledgement is never replayed and exact workload deletion closes ownership', bounded, async () => {
  const fixture = await processFixture({ loseUpgrade: true });
  const reservation = fixture.backend.reserve(sandboxRequest(), recovery);
  try {
    const sandbox = await reservation.start();
    const process = sandbox.reserveProcess(recipe);
    await assert.rejects(process.start(), SandboxOperationError);
    await sandbox.stop();
    await assert.rejects(process.start(), SandboxStateError);
    assert.deepEqual({ creates: fixture.createCount, starts: fixture.upgrades.length, remaining: fixture.containers.size }, { creates: 1, starts: 1, remaining: 1 });
  } finally { await reservation.destroy(); await fixture.close(); }
});

test('stop removes compute before joining delayed exec-create and upgrade dispatch', bounded, async () => {
  for (const stage of ['create', 'upgrade'] as const) {
    const pause = gate();
    const fixture = await processFixture(stage === 'create' ? { pauseCreate: pause } : { pauseUpgrade: pause });
    const reservation = fixture.backend.reserve(sandboxRequest(), recovery);
    let stopped: Promise<void> | undefined;
    try {
      const sandbox = await reservation.start();
      const process = sandbox.reserveProcess(recipe);
      const starting = assert.rejects(process.start(), SandboxOperationError);
      await (stage === 'create' ? fixture.createEntered.promise : fixture.upgradeEntered.promise);
      stopped = sandbox.stop();
      await fixture.computeDeleted.promise;
      assert.equal([...fixture.containers.values()].some((container) => container.State.Running), false);
      pause.resolve();
      await starting; await stopped;
      assert.deepEqual({ creates: fixture.createCount, starts: fixture.upgrades.length, remaining: fixture.containers.size },
        { creates: 1, starts: stage === 'create' ? 0 : 1, remaining: 1 });
    } finally { pause.resolve(); await stopped; await reservation.destroy(); await fixture.close(); }
  }
});

test('malformed, oversized and truncated multiplex frames fail without treating bytes as stdout', bounded, async () => {
  const invalid = Buffer.alloc(8); invalid[0] = 3;
  const reserved = Buffer.alloc(8); reserved[0] = 1; reserved[2] = 1;
  const oversized = Buffer.alloc(8); oversized[0] = 1; oversized.writeUInt32BE(1024 * 1024 + 1, 4);
  for (const payload of [invalid, reserved, oversized, Buffer.from([1, 0, 0]), frame(1, Uint8Array.of(42, 43)).subarray(0, 9)]) {
    const fixture = await processFixture();
    const reservation = fixture.backend.reserve(sandboxRequest(), recovery);
    try {
      const sandbox = await reservation.start();
      const streams = await sandbox.reserveProcess(recipe).start();
      const output = bytes(streams.stdout);
      const failure = assert.rejects(output, SandboxOperationError);
      const errorOutput = bytes(streams.stderr).catch(() => Buffer.alloc(0));
      (await fixture.attached.promise).end(payload);
      await failure; await errorOutput;
      await sandbox.stop();
      assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
      assert.equal(fixture.containers.size, 1);
    } finally { await reservation.destroy(); await fixture.close(); }
  }
});

test('slow readers backpressure multiplex payload while preserving every byte', bounded, async () => {
  const fixture = await processFixture();
  const request = sandboxRequest();
  const reservation = fixture.backend.reserve(parseSandboxRequest({ policy: { ...request.policy,
    streams: { maxStdinBytes: 64, maxOutputBytes: 64, maxBufferedInputBytes: 64, maxBufferedOutputBytes: 16, highWaterMarkBytes: 4 } } }), recovery);
  try {
    const sandbox = await reservation.start();
    const streams = await sandbox.reserveProcess(recipe).start();
    const peer = await fixture.attached.promise;
    peer.write(Buffer.concat([frame(1, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), frame(2, Buffer.from([9, 10]))]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(streams.stdout.readableLength <= 4);
    assert.equal([...fixture.containers.values()].filter((container) => container.State.Running).length, 1);
    const output = bytes(streams.stdout); const errors = bytes(streams.stderr);
    peer.end(); fixture.exit();
    assert.deepEqual(await output, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.deepEqual(await errors, Buffer.from([9, 10]));
  } finally { await reservation.destroy(); await fixture.close(); }
});

test('multiplex lifetime overflow and reader abandonment stop the complete workload and settle raw exit', bounded, async () => {
  for (const mode of ['flood', 'abandon'] as const) {
    const fixture = await processFixture();
    const request = sandboxRequest();
    const reservation = fixture.backend.reserve(parseSandboxRequest({ policy: { ...request.policy,
      streams: { maxStdinBytes: 16, maxOutputBytes: 8, maxBufferedInputBytes: 16, maxBufferedOutputBytes: 8, highWaterMarkBytes: 2 } } }), recovery);
    try {
      const sandbox = await reservation.start();
      const streams = await sandbox.reserveProcess(recipe).start();
      const failure = assert.rejects(bytes(streams.stderr), SandboxOperationError);
      if (mode === 'flood') {
        const output = bytes(streams.stdout).catch(() => Buffer.alloc(0));
        (await fixture.attached.promise).write(Buffer.concat([frame(1, Buffer.alloc(6, 1)), frame(2, Buffer.alloc(4, 2))]));
        await output;
      } else streams.stdout.destroy();
      await failure;
      await sandbox.stop();
      assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
      assert.equal(fixture.containers.size, 1);
    } finally { await reservation.destroy(); await fixture.close(); }
  }
});

test('physical cleanup failure retains exact exec owner and retry settles exit without an invented status', bounded, async () => {
  const fixture = await processFixture({ failComputeDeleteAttempts: 2 });
  const reservation = fixture.backend.reserve(sandboxRequest(), recovery);
  try {
    const sandbox = await reservation.start();
    const streams = await sandbox.reserveProcess(recipe).start();
    await assert.rejects(sandbox.stop(), SandboxCleanupError);
    assert.equal(fixture.containers.size, 2);
    await sandbox.stop();
    assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
    assert.deepEqual({ creates: fixture.createCount, starts: fixture.upgrades.length, remaining: fixture.containers.size }, { creates: 1, starts: 1, remaining: 1 });
  } finally { await reservation.destroy(); await fixture.close(); }
});

test('stop joins a blocked native stdin write without requiring the guest to consume it', bounded, async () => {
  const fixture = await processFixture({ onAttachment(stream) { stream.pause(); } });
  const reservation = fixture.backend.reserve(sandboxRequest(), recovery);
  try {
    const sandbox = await reservation.start();
    const streams = await sandbox.reserveProcess(recipe).start();
    let delivered = false;
    const written = new Promise<Error | null | undefined>((resolve) => {
      assert.equal(streams.stdin.write(Buffer.alloc(4 * 1024 * 1024, 127), (error) => { delivered = true; resolve(error); }), false);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(delivered, false);
    assert.equal(Buffer.concat(fixture.inputBytes).byteLength, 0);
    await sandbox.stop();
    assert.ok(await written instanceof Error);
    assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 1, volumes: 1 });
  } finally { await reservation.destroy(); await fixture.close(); }
});
