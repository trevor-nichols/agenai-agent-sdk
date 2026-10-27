import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function bounded(operation, description) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(description)), 3000);
  })]); }
  finally { clearTimeout(timer); }
}

async function guest(t) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./guest.mjs', import.meta.url)), '1000'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  void completion.catch(() => {});
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; assert(stderr.length <= 4096); });
  const output = createInterface({ input: child.stdout });
  const lines = output[Symbol.asyncIterator]();
  t.after(async () => {
    child.stdin.end();
    try { assert.deepEqual(await bounded(completion, 'Guest child did not join.'), { code: 0, signal: null }); }
    finally { child.kill('SIGKILL'); await completion.catch(() => {}); output.close(); }
    assert.equal(stderr, '');
  });
  const line = async () => {
    const result = await bounded(lines.next(), 'Guest response did not arrive.');
    assert.equal(result.done, false); assert(Buffer.byteLength(result.value) <= 32 * 1024);
    return JSON.parse(result.value);
  };
  assert.deepEqual(await line(), { ready: true });
  let sequence = 0;
  return async (command) => {
    const id = ++sequence;
    await new Promise((resolve, reject) => child.stdin.write(JSON.stringify({ ...command, id }) + '\n', (error) => error ? reject(error) : resolve()));
    const result = await line(); assert.equal(result.id, id); return result;
  };
}

for (const mode of ['silent peer', 'non-marker peer']) {
  test(`guest reports a successful IPv6 TCP connection to a ${mode} and joins its socket`, { timeout: 12_000 }, async (t) => {
    const peers = new Set(); let receivedBytes = 0;
    const accepted = Promise.withResolvers(); const peerClosed = Promise.withResolvers();
    const server = createServer((peer) => {
      peers.add(peer); peer.on('error', () => {}); accepted.resolve();
      peer.on('data', (chunk) => { receivedBytes += chunk.length; });
      peer.once('close', () => { peers.delete(peer); peerClosed.resolve(); });
      if (mode === 'non-marker peer') peer.end('NOT-A-MARKER\n');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '::1', resolve); });
    t.after(async () => { for (const peer of peers) peer.destroy(); if (server.listening) await new Promise((resolve) => server.close(resolve)); });
    const port = server.address().port;
    const request = await guest(t);
    const response = await request({ kind: 'tcp-connect', host: '::1', port });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.deepEqual(response.result, { connected: true, remoteAddress: '::1', remotePort: port, closed: true });
    await bounded(accepted.promise, 'No real TCP connection was accepted.');
    await bounded(peerClosed.promise, 'Guest TCP peer remained entered.');
    assert.equal(receivedBytes, 0); assert.equal(peers.size, 0);
    if (mode === 'silent peer') {
      await new Promise((resolve) => server.close(resolve));
      const refused = await request({ kind: 'tcp-connect', host: '::1', port });
      assert.equal(refused.ok, false); assert.equal(refused.error.code, 'ECONNREFUSED');
    }
  });
}

test('guest reports an IPv6 UDP submission without waiting for a reply and joins its socket', { timeout: 12_000 }, async (t) => {
  const server = createSocket('udp6');
  const received = Promise.withResolvers();
  server.once('message', (bytes, peer) => received.resolve({ bytes, address: peer.address }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.bind(0, '::1', resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = await guest(t);
  const probe = 'EXACT-OWNED-UDP-SUBMISSION\n';
  const response = await request({ kind: 'udp-send', host: '::1', port: server.address().port, probe });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(response.result, { submitted: true, bytes: Buffer.byteLength(probe), closed: true });
  const observed = await bounded(received.promise, 'No real UDP datagram was observed.');
  assert.equal(observed.bytes.toString(), probe); assert.equal(observed.address, '::1');
});
