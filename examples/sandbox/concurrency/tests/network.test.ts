import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import test from 'node:test';
import { CONCURRENT_NETWORK_PROGRAM } from '../network-program.js';
import { CERTIFICATE, PRIVATE_KEY } from './network-fixture.js';

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test('the original held TLS connection retains bounded termination facts without reconnecting and joins its sockets', { timeout: 15_000 }, async (t) => {
  for (const termination of ['tls_eof', 'proxy_reset'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'concurrent-held-tls-'));
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => {
      sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket;
    };
    let peer: TLSSocket | undefined;
    const response = 'HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nKeep-Alive: timeout=600, max=1000\r\nServer: ' + 's'.repeat(256)
      + '\r\nDate: Fri, 30 Oct 2026 00:00:00 GMT\r\nContent-Length: 0\r\nSet-Cookie: never-retained=private\r\n\r\n';
    let requests = 0; let connections = 0;
    let proxyClient: Socket | undefined;
    const endpoint = createTlsServer({ cert: CERTIFICATE, key: PRIVATE_KEY }, (socket) => {
      peer = socket; track(socket); let input = '';
      socket.on('data', (chunk: Buffer) => {
        input += chunk.toString('ascii');
        while (input.includes('\r\n\r\n')) {
          const end = input.indexOf('\r\n\r\n'); const request = input.slice(0, end + 4); input = input.slice(end + 4);
          assert.match(request, /^HEAD \/held HTTP\/1\.1\r\nHost: localhost\r\n/u); requests++;
          if (!socket.writableEnded) socket.write(response);
        }
      });
    });
    endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
    const address = endpoint.address(); assert(address !== null && typeof address !== 'string');
    const proxy = createServer((client) => {
      proxyClient = client; track(client); connections++; let input = Buffer.alloc(0);
      const receive = (chunk: Buffer) => {
        input = Buffer.concat([input, chunk]); const end = input.indexOf('\r\n\r\n'); if (end < 0) return;
        client.pause(); client.off('data', receive);
        assert.equal(input.subarray(0, end + 4).toString('ascii'), `CONNECT localhost:${address.port} HTTP/1.1\r\nHost: localhost:${address.port}\r\n\r\n`);
        const upstream = track(createConnection({ host: '127.0.0.1', port: address.port }));
        client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
        upstream.once('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (input.length > end + 4) upstream.write(input.subarray(end + 4));
          client.pipe(upstream); upstream.pipe(client); client.resume();
        });
      };
      client.on('data', receive);
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      proxy.listen(3128, '127.0.0.1'); await once(proxy, 'listening');
      await writeFile(join(directory, 'ca.pem'), CERTIFICATE);
      await writeFile(join(directory, 'network.mjs'), CONCURRENT_NETWORK_PROGRAM);
      await writeFile(join(directory, 'primary.mjs'), `import { createInterface } from 'node:readline';
  import { openHeld, closeNetwork } from './network.mjs';
  try {
    const held = await openHeld({ hostname: 'localhost', port: ${address.port}, path: '/held', status: 200 }, 3000);
    for await (const command of createInterface({ input: process.stdin })) {
      if (command !== 'probe') throw new Error('Unexpected fixture command.');
      console.log(JSON.stringify({ kind: 'held', value: await held.probe() }));
    }
  } catch (error) {
    process.stderr.write(String(error.stack ?? error).slice(0, 4096)); process.exitCode = 1; process.stdin.destroy();
    console.log(JSON.stringify({ kind: 'failure', message: String(error.message) }));
  } finally { await closeNetwork(); }
  `);
      const original = spawn(process.execPath, [join(directory, 'primary.mjs')], { stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_EXTRA_CA_CERTS: join(directory, 'ca.pem') } }); child = original;
      const stderr: Buffer[] = []; original.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
      const exited = once(original, 'close', { signal: t.signal }); void exited.catch(() => {});
      const lines = createInterface({ input: original.stdout })[Symbol.asyncIterator]();
      const next = async () => { const line = await lines.next(); assert.equal(line.done, false); return record(JSON.parse(String(line.value))); };
      original.stdin.write('probe\n'); const first = record((await next()).value);
      original.stdin.write('probe\n'); const second = record((await next()).value);
      assert.equal(first.authorized, true); assert.equal(second.connection, first.connection); assert.equal(first.sequence, 1); assert.equal(second.sequence, 2);
      assert.equal(second.certificateFingerprint256, new X509Certificate(CERTIFICATE).fingerprint256);
      if (termination === 'tls_eof') {
        const originalPeer = peer; assert(originalPeer); await new Promise<void>((resolve) => originalPeer.end(resolve));
      } else { assert(proxyClient); proxyClient.resetAndDestroy(); }
      original.stdin.write('probe\n'); const failure = await next();
      assert.equal(failure.kind, 'failure'); assert.equal(typeof failure.message, 'string');
      const message = String(failure.message); const prefix = 'Held TLS observation failed: ';
      assert(message.startsWith(prefix), 'The original held TLS termination facts were lost.');
      const diagnostic = record(JSON.parse(message.slice(prefix.length)));
      assert.equal(diagnostic.format, 'agenai.concurrent-held-tls-failure.v1'); assert.equal(diagnostic.terminationAttribution, 'unattributed');
      assert.equal(diagnostic.successfulReplies, 2); assert.equal(diagnostic.connection, first.connection);
      assert(Number.isFinite(Date.parse(String(diagnostic.firstSuccessfulAt))));
      const last = record(diagnostic.lastSuccessfulHead); assert.equal(last.sequence, 2); assert.equal(last.status, 200);
      assert(Number.isFinite(Date.parse(String(last.startedAt)))); assert(Number.isFinite(Date.parse(String(last.completedAt))));
      assert.equal(last.headerSha256, createHash('sha256').update(response).digest('hex'));
      const headers = record(last.headers); assert.equal(headers.connection, 'keep-alive'); assert.equal(headers.server, 's'.repeat(32));
      assert.deepEqual(last.truncatedHeaders, ['server']); assert.equal('set-cookie' in headers, false);
      const tls = record(diagnostic.tlsIdentity); assert.equal(tls.authorized, true); assert.equal(tls.servername, 'localhost');
      assert.equal(tls.certificateFingerprint256, second.certificateFingerprint256);
      const transport = record(diagnostic.proxyIdentity); assert.equal(transport.remoteAddress, '127.0.0.1'); assert.equal(transport.remotePort, 3128);
      const streams = record(diagnostic.streams); const secure = record(streams.tls); const raw = record(streams.proxy);
      if (termination === 'tls_eof') assert.equal(typeof secure.end, 'string');
      else {
        assert(secure.error !== null || raw.error !== null, JSON.stringify(diagnostic));
        const reset = record(secure.error ?? raw.error);
        assert.match(String(reset.code), /^(?:ECONNRESET|EPIPE)$/u, 'Reset may be observed by the original read or the next original write.');
        assert.match(String(reset.message), /^[\x20-\x7e]{1,64}$/u); assert(Number.isFinite(Date.parse(String(reset.at))));
        t.diagnostic(`Original proxy reset: ${String(reset.code)} (${secure.error !== null ? 'TLS' : 'raw proxy'}).`);
      }
      assert(secure.close !== null && raw.close !== null, JSON.stringify(diagnostic));
      assert.equal(typeof record(secure.close).hadError, 'boolean');
      assert.equal(typeof record(raw.close).at, 'string'); assert.equal(record(secure.state).closed, true); assert.equal(record(raw.state).closed, true);
      assert(Buffer.byteLength(message) <= 3072 + prefix.length);
      const [code, signal] = await exited; assert.equal(code, 1); assert.equal(signal, null);
      assert(Buffer.concat(stderr).length <= 4096); assert(Buffer.concat(stderr).toString().includes(message));
      await Promise.all([...sockets].map((socket) => once(socket, 'close', { signal: AbortSignal.timeout(3000) })));
      assert.equal(sockets.size, 0); assert.equal(connections, 1); assert(requests >= 2);
    } finally {
      child?.stdin?.end();
      for (const socket of sockets) socket.destroy();
      if (child && child.exitCode === null && child.signalCode === null) await once(child, 'close');
      await Promise.all([proxy, endpoint].map((server) => new Promise<void>((resolve, reject) => server.close((error) => {
        if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error); else resolve();
      }))));
      await rm(directory, { recursive: true, force: true });
    }
  }
});
