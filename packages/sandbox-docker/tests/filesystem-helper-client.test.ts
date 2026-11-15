import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { parseSandboxRelativePath } from '@agen-ai/sandbox';
import { createNodeFilesystemHelperClient } from '../src/node/index.js';

const READY = { protocol: 'agenai.sandbox.filesystem.v1', layout: 'agenai.sandbox.workspace.v1', uid: 1000, gid: 1000 };
const OPERATIONS = ['', 'stat', 'read', 'list', 'next', 'write', 'append', 'commit', 'cancel', 'close', 'heartbeat'];
const terminal = (status: string, effect: string, count: string, mode: number | null = null, entry: unknown = null) =>
  ({ status, effect, errno: 0, count, mode, entry });

interface Received { readonly operation: string; readonly path: string; readonly flags: number; readonly bytes: number }
type Reply = Readonly<{ kind: number; body?: unknown }>;

/** The helper side of the wire: decodes each request and answers with scripted frames. */
function scriptedHelper(answer: (request: Received) => readonly Reply[] | 'end') {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: Received[] = [];
  let buffered = Buffer.alloc(0);
  const send = (reply: Reply) => {
    const body = reply.body === undefined ? Buffer.alloc(0)
      : Buffer.from(reply.kind === 1 ? String(reply.body) : JSON.stringify(reply.body));
    const header = Buffer.alloc(8);
    header.writeUInt32BE(reply.kind, 0);
    header.writeUInt32BE(body.length, 4);
    output.write(Buffer.concat([header, body]));
  };
  input.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 16) {
      const pathBytes = buffered.readUInt32BE(8);
      const dataBytes = buffered.readUInt32BE(12);
      if (buffered.length < 16 + pathBytes + dataBytes) return;
      const request = { operation: OPERATIONS[buffered.readUInt32BE(0)] ?? 'invalid', flags: buffered.readUInt32BE(4),
        path: buffered.subarray(16, 16 + pathBytes).toString('utf8'), bytes: dataBytes };
      buffered = buffered.subarray(16 + pathBytes + dataBytes);
      received.push(request);
      const replies = answer(request);
      if (replies === 'end') output.end();
      else for (const reply of replies) send(reply);
    }
  });
  return { input, output, received, send };
}

const options = (signal = new AbortController().signal) => ({ signal, quotas: {}, chunkBytes: 65536 });
const path = parseSandboxRelativePath('notes.txt');

async function* bytes(text: string) { yield new TextEncoder().encode(text); }

test('a ready helper publishes one staged write and closes only with its exact receipt', { timeout: 5000 }, async () => {
  const helper = scriptedHelper((request) => {
    if (request.operation === 'write') return [{ kind: 3, body: terminal('ready', 'staged', '0') }];
    if (request.operation === 'append') return [{ kind: 3, body: terminal('ready', 'staged', String(request.bytes)) }];
    if (request.operation === 'commit') return [{ kind: 3, body: terminal('complete', 'published', '5', 0o644) }];
    if (request.operation === 'close') { queueMicrotask(() => helper.output.end()); return [{ kind: 3, body: terminal('closed', 'none', '0') }]; }
    return [];
  });
  const client = createNodeFilesystemHelperClient({ input: helper.input, output: helper.output, user: { uid: 1000, gid: 1000 } });
  helper.send({ kind: 4, body: READY });
  await client.ready;

  const written = await client.writeFile(path, bytes('hello'), { ...options(), mode: 'create' });
  assert.deepEqual(written, { kind: 'completed', effect: 'published', bytes: 5n, permissions: 0o644 });
  assert.deepEqual(helper.received.map(({ operation, flags, path: name }) => [operation, flags, name]),
    [['write', 1, 'notes.txt'], ['append', 0, ''], ['commit', 0, '']]);

  const closed = await client.close();
  assert.deepEqual(closed, { kind: 'closed' });
  assert.equal(await client.close(), closed);
  assert.equal(helper.received.at(-1)?.operation, 'close');
});

test('a changed publication and a lost commit acknowledgement remain distinct exact receipts', { timeout: 5000 }, async () => {
  let commits = 0;
  const helper = scriptedHelper((request) => {
    if (request.operation === 'write') return [{ kind: 3, body: terminal('ready', 'staged', '0') }];
    if (request.operation === 'append') return [{ kind: 3, body: terminal('ready', 'staged', String(request.bytes)) }];
    if (request.operation === 'commit') {
      commits += 1;
      return commits === 1 ? [{ kind: 3, body: terminal('changed', 'published', '2', 0o600) }] : 'end';
    }
    return [];
  });
  const client = createNodeFilesystemHelperClient({ input: helper.input, output: helper.output, user: { uid: 1000, gid: 1000 } });
  helper.send({ kind: 4, body: READY });
  await client.ready;

  assert.deepEqual(await client.writeFile(path, bytes('ab'), { ...options(), mode: 'replace' }),
    { kind: 'changed', effect: 'published', bytes: 2n, permissions: 0o600 });
  assert.deepEqual(await client.writeFile(path, bytes('cd'), { ...options(), mode: 'replace' }),
    { kind: 'uncertain', effect: 'unknown', bytes: 2n });
  await assert.rejects(client.stat(path, options()), { name: 'SandboxStateError' });
  const closed = await client.close();
  assert.equal(closed.kind, 'failed');
});

test('readiness must attest the selected user before any operation is admitted', { timeout: 5000 }, async () => {
  const helper = scriptedHelper(() => []);
  const client = createNodeFilesystemHelperClient({ input: helper.input, output: helper.output, user: { uid: 1000, gid: 1000 } });
  helper.send({ kind: 4, body: { ...READY, uid: 1001 } });
  await assert.rejects(client.ready, { name: 'SandboxOperationError', code: 'driver_failure' });
  await assert.rejects(client.stat(path, options()));
  assert.deepEqual(helper.received, []);
  assert.equal(helper.input.destroyed, true);
});

test('an unsolicited or oversized reply fails the transport instead of being buffered', { timeout: 5000 }, async () => {
  const unsolicited = scriptedHelper(() => []);
  const first = createNodeFilesystemHelperClient({ input: unsolicited.input, output: unsolicited.output, user: { uid: 1000, gid: 1000 } });
  unsolicited.send({ kind: 4, body: READY });
  await first.ready;
  unsolicited.send({ kind: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unsolicited.input.destroyed, true);
  assert.equal((await first.close()).kind, 'failed');

  const oversized = scriptedHelper(() => []);
  const second = createNodeFilesystemHelperClient({ input: oversized.input, output: oversized.output, user: { uid: 1000, gid: 1000 } });
  const header = Buffer.alloc(8);
  header.writeUInt32BE(3, 0);
  header.writeUInt32BE(4096, 4);
  oversized.output.write(header);
  await assert.rejects(second.ready);
  assert.equal(oversized.output.destroyed, true);
});

test('a read stops at its byte quota and cancels the entered helper stream', { timeout: 5000 }, async () => {
  const helper = scriptedHelper((request) => {
    if (request.operation === 'read') return [{ kind: 3, body: terminal('ready', 'none', '0', null, { kind: 'file', byteLength: 8, mode: 0o644 }) }];
    if (request.operation === 'next') return [{ kind: 1, body: 'abcdef' }];
    if (request.operation === 'cancel') return [{ kind: 3, body: terminal('cancelled', 'none', '0') }];
    return [];
  });
  const client = createNodeFilesystemHelperClient({ input: helper.input, output: helper.output, user: { uid: 1000, gid: 1000 } });
  helper.send({ kind: 4, body: READY });
  await client.ready;
  const chunks: number[] = [];
  const result = await client.readFile(path, async ({ chunks: stream }) => {
    for await (const chunk of stream) chunks.push(chunk.byteLength);
  }, { ...options(), quotas: { maxBytes: 4n } });
  assert.deepEqual(result, { kind: 'rejected', reason: 'quota_exceeded', bytes: 0n });
  assert.deepEqual(chunks, []);
  assert.deepEqual(helper.received.map(({ operation }) => operation), ['read', 'next', 'cancel']);
});

test('invalid chunk sizes are refused before read admission and a valid read remains usable', { timeout: 5000 }, async () => {
  let sent = false;
  const helper = scriptedHelper((request) => {
    if (request.operation === 'read') {
      sent = false;
      return [{ kind: 3, body: terminal('ready', 'none', '0', null, { kind: 'file', byteLength: 1, mode: 0o644 }) }];
    }
    if (request.operation === 'next') {
      if (sent) return [{ kind: 3, body: terminal('complete', 'none', '1') }];
      sent = true;
      return [{ kind: 1, body: 'x' }];
    }
    if (request.operation === 'cancel') return [{ kind: 3, body: terminal('cancelled', 'none', '0') }];
    if (request.operation === 'close') { queueMicrotask(() => helper.output.end()); return [{ kind: 3, body: terminal('closed', 'none', '0') }]; }
    return [];
  });
  const client = createNodeFilesystemHelperClient({ input: helper.input, output: helper.output, user: { uid: 1000, gid: 1000 } });
  helper.send({ kind: 4, body: READY });
  await client.ready;
  try {
    for (const chunkBytes of [0, -1, 0.5, NaN, Infinity, 65_537]) {
      await assert.rejects(async () => client.readFile(path, async ({ chunks }) => {
        // Bound the consumer so the zero-size regression fails instead of hanging the test runner.
        let count = 0;
        for await (const _chunk of chunks) if (++count === 5) break;
      }, { ...options(), chunkBytes }));
    }
    assert.deepEqual(helper.received, []);
    const chunks: Uint8Array[] = [];
    const result = await client.readFile(path, async ({ chunks: stream }) => {
      for await (const chunk of stream) chunks.push(chunk);
    }, { ...options(), chunkBytes: 1 });
    assert.deepEqual(result, { kind: 'completed', bytes: 1n });
    assert.equal(Buffer.concat(chunks).toString(), 'x');
  } finally { await client.close(); }
});

test('an idle client renews the helper lease with heartbeats', { timeout: 5000 }, async () => {
  const helper = scriptedHelper((request) => request.operation === 'heartbeat' ? [{ kind: 5 }] : []);
  const client = createNodeFilesystemHelperClient({ input: helper.input, output: helper.output, user: { uid: 1000, gid: 1000 },
    limits: { heartbeatMs: 10 } });
  helper.send({ kind: 4, body: READY });
  await client.ready;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(helper.received.length >= 2);
  assert.ok(helper.received.every(({ operation }) => operation === 'heartbeat'));
  helper.output.destroy();
});
