// ------------------------------------------------------------------------------------------------
//                messageWriter.test.ts - Asynchronous ACP output settlement and failure coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import test from 'node:test';

import { AcpClientError } from '../src/errors.js';
import { createAcpMessageWriter } from '../src/messageWriter.js';

const MESSAGE = Object.freeze({
  jsonrpc: '2.0' as const,
  method: 'session/cancel',
  params: Object.freeze({ sessionId: 'session-1' }),
});

function writerFor(writable: Writable) {
  return createAcpMessageWriter({
    writable,
    maxFrameBytes: 4_096,
    maxBufferedBytes: 8_192,
  });
}

test('one exact maximum frame fits with its newline delimiter', async () => {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const maximumFrameBytes = Buffer.byteLength(JSON.stringify(MESSAGE), 'utf8');
  const writer = createAcpMessageWriter({
    writable,
    maxFrameBytes: maximumFrameBytes,
    maxBufferedBytes: maximumFrameBytes + 1,
  });

  await writer.write(MESSAGE);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.byteLength, maximumFrameBytes + 1);
  assert.equal(chunks[0]?.at(-1), 0x0a);
  await writer.dispose(1);
});

test('a writable buffer admission does not settle before asynchronous completion', async () => {
  const completion = Promise.withResolvers<void>();
  const writable = new Writable({
    write(_chunk, _encoding, callback) {
      void completion.promise.then(() => callback(), callback);
    },
  });
  const writer = writerFor(writable);
  let settled = false;
  const pending = writer.write(MESSAGE).finally(() => { settled = true; });

  await waitForImmediate();
  assert.equal(settled, false);

  completion.resolve();
  await pending;
  assert.equal(settled, true);
  await writer.dispose(1);
});

test('an asynchronous writable failure rejects without an unhandled stream error', async () => {
  const writable = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(new Error('late write failure')));
    },
  });
  const writer = writerFor(writable);

  await assert.rejects(writer.write(MESSAGE), (error: unknown) => (
    error instanceof AcpClientError
    && error.reasonCode === 'acp_stdin_stream_error'
  ));
  await writer.dispose(1);
});

test('backpressured writes settle only after both completion and drain', async () => {
  let drained = false;
  const writable = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setImmediate(callback);
    },
  });
  writable.once('drain', () => { drained = true; });
  const writer = writerFor(writable);

  await writer.write(MESSAGE);
  assert.equal(drained, true);
  await writer.dispose(1);
});

test('disposal rejects the caller while retaining ownership of late write settlement', async (t) => {
  for (const outcome of ['success', 'failure', 'close'] as const) await t.test(outcome, async () => {
    const entered = Promise.withResolvers<(error?: Error | null) => void>();
    let nativeWrites = 0;
    const writable = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        nativeWrites += 1;
        entered.resolve(callback);
      },
    });
    const writer = writerFor(writable);
    const disposedError = (error: unknown) => error instanceof AcpClientError
      && error.reasonCode === 'acp_client_disposed';
    const rejected = assert.rejects(writer.write(MESSAGE), disposedError);
    const completeWrite = await entered.promise;

    await writer.dispose(0);
    await rejected;
    await assert.rejects(writer.write(MESSAGE), disposedError);
    assert.equal(nativeWrites, 1);

    if (outcome === 'close') writable.destroy();
    else completeWrite(outcome === 'failure' ? new Error('late write failure after disposal') : undefined);
    // Node emits a failed write's error after invoking the write callback. No test error listener
    // masks an unowned event; the test fails if disposal removed the writer's listener too early.
    await waitForImmediate();
    assert.equal(nativeWrites, 1);
    assert.equal(writable.listenerCount('drain'), 0);
    assert.equal(writable.listenerCount('error'), 0);
    assert.equal(writable.listenerCount('close'), 0);
    writable.destroy();
  });
});
