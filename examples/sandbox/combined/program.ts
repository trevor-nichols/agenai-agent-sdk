/** A fixed, credential-free Node workload. Its controller supplies every network target and bound. */
export const COMBINED_GUEST_PROGRAM = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

const timeoutMs = Number(process.argv[2]);
assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
const sockets = new Set();
function track(socket) {
  sockets.add(socket); socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Explicit network observation deadline.')));
  return socket;
}
async function connected(host, port) {
  const socket = track(net.connect({ host, port }));
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
      socket.once('close', () => reject(new Error('Socket closed before connection.')));
    });
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}
async function tunnel(hostname, port) {
  const socket = await connected('127.0.0.1', 3128);
  try {
    const status = await new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      const receive = (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 16 * 1024) { socket.destroy(new Error('CONNECT header exceeded its bound.')); return; }
        const end = bytes.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.removeListener('data', receive); socket.pause();
        if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4));
        const header = bytes.subarray(0, end + 4).toString('ascii');
        const match = /^HTTP\/1\.1 ([0-9]{3}) /u.exec(header);
        if (!match) { reject(new Error('Malformed CONNECT response.')); return; }
        resolve(Number(match[1]));
      };
      socket.on('data', receive); socket.once('error', reject);
      socket.once('close', () => reject(new Error('CONNECT closed before response.')));
      socket.write('CONNECT ' + hostname + ':' + port + ' HTTP/1.1\r\nHost: ' + hostname + ':' + port + '\r\n\r\n');
    });
    return { socket, status };
  } catch (error) { socket.destroy(); throw error; }
}
async function positiveTls(input) {
  const proxy = await tunnel(input.hostname, input.port);
  assert.equal(proxy.status, 200);
  const stream = track(tls.connect({ socket: proxy.socket, servername: input.hostname, rejectUnauthorized: true }));
  try {
    await new Promise((resolve, reject) => {
      stream.once('secureConnect', resolve); stream.once('error', reject);
      stream.once('close', () => reject(new Error('TLS closed before verification.')));
    });
    assert.equal(stream.authorized, true);
    const certificateFingerprint256 = stream.getPeerCertificate().fingerprint256;
    assert.equal(typeof certificateFingerprint256, 'string');
    const hash = createHash('sha256'); let bodyBytes = 0;
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: input.hostname, port: input.port, path: input.path,
        createConnection: () => stream, headers: { host: input.hostname, connection: 'close', 'accept-encoding': 'identity' } }, (message) => {
        message.on('data', (chunk) => {
          bodyBytes += chunk.length;
          if (bodyBytes > input.bodyBytes) message.destroy(new Error('HTTPS body exceeded the selected byte count.'));
          else hash.update(chunk);
        });
        message.once('error', reject); message.once('aborted', () => reject(new Error('HTTPS body interrupted.')));
        message.once('end', () => resolve({ status: message.statusCode }));
      });
      request.once('error', reject); request.end();
    });
    const bodySha256 = hash.digest('hex');
    assert.equal(response.status, input.status); assert.equal(bodyBytes, input.bodyBytes); assert.equal(bodySha256, input.bodySha256);
    return { ...response, bodyBytes, bodySha256, authorized: true, certificateFingerprint256 };
  } finally { stream.destroy(); proxy.socket.destroy(); }
}
async function denied(input) {
  let direct;
  try {
    const socket = await connected(input.address, input.port);
    try {
      socket.write(input.probe);
      throw new Error('Forbidden direct TCP target was reachable.');
    } finally { socket.destroy(); }
  } catch (error) {
    if (error.message === 'Forbidden direct TCP target was reachable.') throw error;
    direct = { connected: false, code: typeof error.code === 'string' ? error.code : null, message: error.message.slice(0, 512) };
  }
  const proxy = await tunnel(input.hostname, input.port);
  try { assert.equal(proxy.status, 403); return { direct, proxyStatus: proxy.status }; }
  finally { proxy.socket.destroy(); }
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
assert.equal(await readlink('source-link.txt'), 'source.txt');
assert.equal(await readFile('source-link.txt', 'utf8'), 'combined source\n');
assert.equal((await lstat('tool.sh')).mode & 0o777, 0o700);
emit({ kind: 'ready' });
let pending = Buffer.alloc(0);
try {
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]); assert(pending.length <= 16 * 1024);
    for (;;) {
      const end = pending.indexOf(10); if (end < 0) break;
      const command = JSON.parse(pending.subarray(0, end).toString('utf8')); pending = pending.subarray(end + 1);
      if (command.kind === 'network') emit({ kind: 'network', positive: await positiveTls(command.positive), forbidden: await denied(command.forbidden) });
      else if (command.kind === 'verify') {
        assert.equal(await readFile('live.txt', 'utf8'), 'combined live replacement\n');
        assert.equal((await lstat('live.txt')).mode & 0o777, 0o600);
        assert.equal(await readFile('source-link.txt', 'utf8'), 'combined source\n');
        await writeFile('result.txt', 'combined verified\n', { mode: 0o644 });
        emit({ kind: 'verified' });
      } else throw new Error('Unknown combined program command.');
    }
  }
  assert.equal(pending.length, 0);
} finally {
  await Promise.all([...sockets].map((socket) => new Promise((resolve) => {
    if (socket.closed) resolve(); else { socket.once('close', resolve); socket.destroy(); }
  })));
}
`;

export const COMBINED_FILES = Object.freeze({
  source: 'combined source\n',
  initialLive: 'combined live initial\n',
  replacementLive: 'combined live replacement\n',
  tool: '#!/bin/sh\nprintf "combined tool\\n"\n',
  result: 'combined verified\n',
});
