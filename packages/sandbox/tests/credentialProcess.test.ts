// ------------------------------------------------------------------------------------------------
//                credentialProcess.test.ts - Credential prefix ownership - Public Node boundary
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { SandboxCleanupError, SandboxOperationError, SandboxStateError } from '../src/index.js';
import type { SandboxProcessInput } from '../src/index.js';
import { reserveSandboxCredentialProcess } from '../src/node/index.js';
import { bytes, fixture, gate, nextTurn, processSpec, request } from './fixtures/backend.js';

const bounded = { timeout: 3000 };
const recovery = { kind: 'in_process' as const };
const payload = Buffer.from([0, 255, 17, 128, 13, 10]);
const prefix = Buffer.concat([Buffer.from([65, 71, 67, 49, 0, 9, 0, 0, 0, 0, 0, 6]), Buffer.from('auth.json'), payload]);
const input = (bytes: Uint8Array = payload, preparationTimeoutMs = 1000) => ({
  bootstrapExecutable: '/usr/local/bin/agenai-credential-bootstrap', process: processSpec,
  file: { name: 'auth.json', bytes }, preparationTimeoutMs,
});

function protocol(options: { prefixLength?: number; nativeOutput?: Buffer; prepared?: boolean; onRecipe?: (spec: SandboxProcessInput) => void } = {}) {
  const output = new Readable({ read() {} });
  const received: Buffer[] = [];
  let total = 0;
  const writable = new Writable({ write(chunk: Buffer, _encoding, callback) {
    received.push(Buffer.from(chunk));
    total += chunk.byteLength;
    if (total === (options.prefixLength ?? prefix.byteLength) && options.prepared !== false) {
      output.push(Buffer.concat([Buffer.from('AGC1 PREPARED\n'), options.nativeOutput ?? Buffer.alloc(0)]));
    }
    callback();
  } });
  output.push(Buffer.from('AGC1 HELLO\n'));
  return { physical: fixture({ output, input: writable, decorateReady(ready) {
    return { ...ready, reserveProcess(spec) { options.onRecipe?.(spec); return ready.reserveProcess(spec); } };
  } }), received };
}

for (const name of ['auth.json', '.credentials.json']) test(`credential preparation preserves ${name}, the one recipe and untouched binary streams`, bounded, async () => {
  const expected = Buffer.concat([Buffer.from([65, 71, 67, 49, 0, name.length, 0, 0, 0, 0, 0, 6]), Buffer.from(name), payload]);
  const output = Buffer.from([0, 255, 65, 128]);
  let recipe: SandboxProcessInput | undefined;
  const control = protocol({ prefixLength: expected.length, nativeOutput: output, onRecipe: (spec) => { recipe = spec; } });
  const sandbox = await control.physical.backend.reserve(request(), recovery).start();
  const source = Buffer.from(payload);
  const reservation = reserveSandboxCredentialProcess(sandbox, { ...input(source), file: { name, bytes: source } });
  source.fill(42);
  assert.equal(reservation.id, 'process-1');
  assert.equal(reservation.stopScope, 'sandbox');
  assert.equal(control.physical.processStarted, false);
  const streams = await reservation.start();
  assert.deepEqual(recipe, { ...processSpec, executable: '/usr/local/bin/agenai-credential-bootstrap', args: ['/bin/fixture'] });
  assert.deepEqual(Buffer.concat(control.received), expected);
  assert.deepEqual(source, Buffer.alloc(payload.length, 42));
  assert.equal(streams.stdin.writableEnded, false);
  assert.deepEqual(streams.stdout.read(output.length), output);
  const nativeInput = Buffer.from([9, 0, 254, 10]);
  await new Promise<void>((resolve, reject) => streams.stdin.write(nativeInput, (error) => error ? reject(error) : resolve()));
  assert.deepEqual(Buffer.concat(control.received), Buffer.concat([expected, nativeInput]));
  control.physical.errorOutput.push(Buffer.from([253, 0]));
  control.physical.errorOutput.push(null);
  assert.deepEqual(await bytes(streams.stderr), Buffer.from([253, 0]));
  await assert.rejects(reservation.start(), SandboxStateError);
  await sandbox.destroy();
  assert.deepEqual([...control.physical.resources], []);
});

test('split markers and bounded input backpressure preserve the exact frame without queuing later chunks', bounded, async () => {
  const output = new Readable({ read() {} });
  const entered = gate(); const release = gate();
  const chunks: Buffer[] = [];
  let total = 0;
  const writable = new Writable({ write(chunk: Buffer, _encoding, callback) {
    chunks.push(Buffer.from(chunk)); total += chunk.byteLength;
    const complete = () => {
      if (total === prefix.length) { output.push(Buffer.from('AGC1 PRE')); output.push(Buffer.from('PARED\n')); }
      callback();
    };
    if (chunks.length === 1) { entered.resolve(); void release.promise.then(complete); } else complete();
  } });
  output.push(Buffer.from('AG')); output.push(Buffer.from('C1 HELLO\n'));
  const physical = fixture({ output, input: writable });
  const sandbox = await physical.backend.reserve(request({ highWaterMarkBytes: 3, maxBufferedInputBytes: 3 }), recovery).start();
  const starting = reserveSandboxCredentialProcess(sandbox, input()).start();
  await entered.promise; await nextTurn();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.length, 3);
  release.resolve();
  await starting;
  assert.ok(chunks.every((chunk) => chunk.length <= 3));
  assert.deepEqual(Buffer.concat(chunks), prefix);
  await sandbox.destroy();
});

for (const ending of ['wrong', 'eof', 'close', 'error'] as const) {
  test(`a ${ending} helper hello delivers no credential and stops original compute`, bounded, async () => {
    const physical = fixture();
    const sandbox = await physical.backend.reserve(request(), recovery).start();
    const reservation = reserveSandboxCredentialProcess(sandbox, input());
    const starting = reservation.start();
    const failed = assert.rejects(starting, (error: unknown) => {
      assert.ok(error instanceof SandboxOperationError);
      assert.equal(error.code, 'stream_failure');
      assert.doesNotMatch(error.message, /synthetic-secret/);
      assert.equal(error.cause, undefined);
      return true;
    });
    await physical.processEntered.promise;
    if (ending === 'wrong') physical.output.push(Buffer.from('AGC0 HELLO\n'));
    if (ending === 'eof') { physical.output.push(Buffer.from('AGC1 ')); physical.output.push(null); }
    if (ending === 'close') physical.output.destroy();
    if (ending === 'error') physical.output.destroy(new Error('native synthetic-secret diagnostic'));
    await failed;
    assert.deepEqual(physical.inputBytes, []);
    assert.deepEqual([...physical.resources], ['storage']);
    await sandbox.destroy();
  });
}

test('abort before process entry sends nothing, consumes start once and omits arbitrary abort reasons', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request(), recovery).start();
  const controller = new AbortController(); controller.abort(new SandboxOperationError('input_limit', 'synthetic-secret abort reason'));
  const reservation = reserveSandboxCredentialProcess(sandbox, input());
  await assert.rejects(reservation.start({ signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof SandboxOperationError);
    assert.equal(error.code, 'cancelled');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /synthetic-secret/);
    return true;
  });
  assert.equal(physical.processStarted, false);
  assert.deepEqual(physical.inputBytes, []);
  await assert.rejects(reservation.start(), SandboxStateError);
  await sandbox.destroy();
});

test('stop before start closes admission without delivering its unused secret', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request(), recovery).start();
  const reservation = reserveSandboxCredentialProcess(sandbox, input());
  await reservation.stop();
  await assert.rejects(reservation.start(), SandboxStateError);
  assert.equal(physical.processStarted, false);
  assert.deepEqual(physical.inputBytes, []);
  await sandbox.destroy();
});

for (const interruption of ['abort', 'deadline', 'wrong-prepared', 'eof-prepared'] as const) {
  test(`${interruption} after complete prefix stops original compute without replay`, bounded, async () => {
    const control = protocol({ prepared: false });
    const sandbox = await control.physical.backend.reserve(request(), recovery).start();
    const controller = new AbortController();
    const starting = reserveSandboxCredentialProcess(sandbox, input(payload, interruption === 'deadline' ? 20 : 1000)).start({ signal: controller.signal });
    const failed = assert.rejects(starting, (error: unknown) => {
      assert.ok(error instanceof SandboxOperationError);
      assert.equal(error.code, interruption === 'deadline' ? 'deadline_exceeded' : interruption === 'abort' ? 'cancelled' : 'stream_failure');
      assert.equal(error.cause, undefined);
      return true;
    });
    while (Buffer.concat(control.received).length < prefix.length) await nextTurn();
    if (interruption === 'abort') controller.abort(new Error('synthetic-secret'));
    if (interruption === 'wrong-prepared') control.physical.output.push(Buffer.from('AGC0 PREPARED\n'));
    if (interruption === 'eof-prepared') control.physical.output.push(null);
    await failed;
    assert.deepEqual(Buffer.concat(control.received), prefix);
    assert.deepEqual([...control.physical.resources], ['storage']);
    await sandbox.destroy();
  });
}

test('preparation deadline covers pending attachment and sends no prefix on its late reply', bounded, async () => {
  const attached = gate();
  const physical = fixture({ processReply: attached.promise });
  const sandbox = await physical.backend.reserve(request(), recovery).start();
  const starting = reserveSandboxCredentialProcess(sandbox, input(payload, 20)).start();
  const failed = assert.rejects(starting, (error: unknown) => error instanceof SandboxOperationError && error.code === 'deadline_exceeded');
  await physical.stopping.promise;
  attached.resolve();
  await failed;
  assert.deepEqual(physical.inputBytes, []);
  await sandbox.destroy();
});

for (const stage of ['hello', 'prefix'] as const) {
  test(`preparation deadline bounds a pending ${stage} and joins its entered work on stop`, bounded, async () => {
    const output = new Readable({ read() {} });
    if (stage === 'prefix') output.push(Buffer.from('AGC1 HELLO\n'));
    const received: Buffer[] = [];
    const writable = new Writable({ write(chunk: Buffer) { received.push(Buffer.from(chunk)); } });
    const physical = fixture({ output, input: writable });
    const sandbox = await physical.backend.reserve(request(), recovery).start();
    await assert.rejects(reserveSandboxCredentialProcess(sandbox, input(payload, 20)).start(),
      (error: unknown) => error instanceof SandboxOperationError && error.code === 'deadline_exceeded');
    assert.deepEqual(Buffer.concat(received), stage === 'hello' ? Buffer.alloc(0) : prefix);
    assert.deepEqual([...physical.resources], ['storage']);
    await sandbox.destroy();
  });
}

test('maximum admitted filename and payload preserve big-endian lengths within bounded writes', bounded, async () => {
  const output = new Readable({ read() {} }); output.push(Buffer.from('AGC1 HELLO\n'));
  const name = 'a'.repeat(64);
  const secret = Buffer.alloc(65_536, 213);
  const expected = Buffer.concat([Buffer.from([65, 71, 67, 49, 0, 64, 0, 0, 0, 1, 0, 0]), Buffer.from(name), secret]);
  const received: Buffer[] = [];
  let delivered = 0;
  const writable = new Writable({ write(chunk: Buffer, _encoding, callback) {
    received.push(Buffer.from(chunk)); delivered += chunk.length;
    if (delivered === expected.length) output.push(Buffer.from('AGC1 PREPARED\n'));
    callback();
  } });
  const physical = fixture({ output, input: writable });
  const sandbox = await physical.backend.reserve(request(), recovery).start();
  await reserveSandboxCredentialProcess(sandbox, { ...input(), file: { name, bytes: secret } }).start();
  assert.deepEqual(Buffer.concat(received), expected);
  assert.ok(received.every((chunk) => chunk.length <= 65_536));
  assert.deepEqual(secret, Buffer.alloc(65_536, 213));
  await sandbox.destroy();
});

test('failed cleanup returns promptly and its retry joins the actual writer before clearing helper bytes', bounded, async () => {
  const entered = gate(); const destroyed = gate(); const releaseDestroy = gate();
  let retained: Uint8Array | undefined;
  const writable = new Writable({ write(chunk: Uint8Array) { retained = chunk; entered.resolve(); },
    destroy(_error, callback) { destroyed.resolve(); void releaseDestroy.promise.then(() => callback()); },
  });
  const output = new Readable({ read() {} }); output.push(Buffer.from('AGC1 HELLO\n'));
  const physical = fixture({ input: writable, output, failFirstStop: true });
  const sandbox = await physical.backend.reserve(request(), recovery).start();
  const controller = new AbortController();
  const starting = reserveSandboxCredentialProcess(sandbox, input()).start({ signal: controller.signal });
  await entered.promise;
  controller.abort();
  let failure: SandboxCleanupError | undefined;
  await assert.rejects(starting, (error: unknown) => { assert.ok(error instanceof SandboxCleanupError); failure = error; return true; });
  await destroyed.promise;
  assert.deepEqual(retained, prefix);
  assert.ok(failure);
  assert.equal(failure.owner.recoveryRecord, sandbox.recoveryRecord);
  let cleaned = false;
  const retry = failure.retryCleanup().then(() => { cleaned = true; });
  await nextTurn();
  assert.equal(cleaned, false);
  assert.deepEqual(retained, prefix);
  releaseDestroy.resolve();
  await retry;
  assert.deepEqual(retained, Buffer.alloc(prefix.length));
  assert.deepEqual(payload, Buffer.from([0, 255, 17, 128, 13, 10]));
  assert.deepEqual([...physical.resources], ['storage']);
  await failure.owner.destroy();
  assert.deepEqual([...physical.resources], []);
});

test('control bytes retain existing input and output lifetime budgets', bounded, async () => {
  for (const budget of ['input', 'output'] as const) {
    const control = protocol();
    const sandbox = await control.physical.backend.reserve(request(budget === 'input'
      ? { maxStdinBytes: prefix.length - 1 } : { maxOutputBytes: 24 }), recovery).start();
    await assert.rejects(reserveSandboxCredentialProcess(sandbox, input()).start(), (error: unknown) => {
      assert.ok(error instanceof SandboxOperationError);
      assert.equal(error.code, budget === 'input' ? 'input_limit' : 'output_limit');
      return true;
    });
    await sandbox.destroy();
  }
});

test('invalid file and preparation fields fail synchronously before consuming the process reservation', bounded, async () => {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request(), recovery).start();
  for (const name of ['', '.', '..', '../auth', '/auth', 'a/b', 'a\\b', 'a\0b', 'é', 'a'.repeat(65)]) {
    assert.throws(() => reserveSandboxCredentialProcess(sandbox, { ...input(), file: { name, bytes: payload } }), TypeError);
  }
  for (const size of [0, 65_537]) assert.throws(() => reserveSandboxCredentialProcess(sandbox, input(new Uint8Array(size))), TypeError);
  for (const timeout of [0, -1, 1.5, 60_001, Infinity, NaN]) assert.throws(() => reserveSandboxCredentialProcess(sandbox, input(payload, timeout)), TypeError);
  const reservation = reserveSandboxCredentialProcess(sandbox, input());
  await reservation.stop();
  await sandbox.destroy();
});
