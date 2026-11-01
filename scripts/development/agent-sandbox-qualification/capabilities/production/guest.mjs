// ------------------------------------------------------------------------------------------------
//                guest.mjs - One installed-SDK primary with bounded JSONL commands and real sockets
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { readFile, readlink, writeFile } from 'node:fs/promises';

const sockets = new Set();
const held = new Map();
const timeoutMs = Number(process.argv[2]);
assert(Number.isInteger(timeoutMs) && timeoutMs >= 100);
const track = (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');

async function connect(host, port) {
  const socket = track(net.connect({ host, port }));
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('socket deadline')));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}

async function proxy(header) {
  const socket = await connect('127.0.0.1', 3128);
  let bytes = Buffer.alloc(0);
  const response = await new Promise((resolve, reject) => {
    const receive = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 16384) { socket.destroy(new Error('proxy header bound')); return; }
      const end = bytes.indexOf('\r\n\r\n');
      if (end >= 0) {
        socket.removeListener('data', receive); socket.pause();
        if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4));
        resolve(bytes.subarray(0, end + 4).toString('ascii'));
      }
    };
    socket.on('data', receive); socket.once('error', reject);
    socket.once('end', () => reject(new Error('proxy ended before response')));
    socket.write(header);
  });
  return { socket, header: response, status: Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1]) };
}

async function tunnel(command) {
  return proxy(`CONNECT ${command.hostname}:${command.port} HTTP/1.1\r\nHost: ${command.hostname}:${command.port}\r\n\r\n`);
}

async function perform(command) {
  if (command.kind === 'facts') return { route: await readFile('/proc/net/route', 'utf8'),
    ipv6: await readFile('/proc/net/ipv6_route', 'utf8'), resolv: await readFile('/etc/resolv.conf', 'utf8'),
    networkNamespace: await readlink('/proc/self/ns/net'), pidNamespace: await readlink('/proc/self/ns/pid'),
    proxyEnvironment: Object.keys(process.env).filter((key) => /proxy/iu.test(key)),
    socketVisible: await readFile('/run/agenai-egress/connect.sock').then(() => true, (error) => error.code) };
  if (command.kind === 'tcp') {
    const socket = await connect(command.host, command.port);
    const chunks = []; let bytes = 0;
    await new Promise((resolve, reject) => {
      socket.on('data', (chunk) => { bytes += chunk.length; if (bytes > 4096) socket.destroy(new Error('fixture marker bound')); else chunks.push(chunk); });
      socket.once('end', resolve); socket.once('error', reject);
    });
    socket.destroy(); return { connected: true, bytes: Buffer.concat(chunks).toString('utf8') };
  }
  if (command.kind === 'udp') {
    const socket = dgram.createSocket(command.family === 6 ? 'udp6' : 'udp4');
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.send(Buffer.from('qualification-dns-bypass'), command.port, command.host, (error) => error ? reject(error) : resolve());
      });
      return { sent: true };
    } finally { try { socket.close(); } catch (error) { if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error; } }
  }
  if (command.kind === 'proxy') {
    const result = await proxy(command.header); result.socket.destroy();
    return { status: result.status, header: result.header };
  }
  if (command.kind === 'hold') {
    const result = command.direct ? { status: 200, socket: await connect(command.hostname, command.port) } : await tunnel(command); assert.equal(result.status, 200);
    const state = { accepted: true, closed: false };
    held.set(command.key, state);
    result.socket.once('close', () => { state.closed = true; void writeFile(`hold-${command.key}.json`, JSON.stringify(state)); });
    result.socket.resume(); await writeFile(`hold-${command.key}.json`, JSON.stringify(state));
    return state;
  }
  if (command.kind === 'held') return held.get(command.key);
  if (command.kind === 'tls') {
    const result = command.direct ? { status: 200, socket: await connect(command.hostname, command.port) } : await tunnel(command); assert.equal(result.status, 200);
    const secure = track(tls.connect({ socket: result.socket, servername: command.hostname, rejectUnauthorized: true }));
    secure.setTimeout(timeoutMs, () => secure.destroy(new Error('TLS deadline')));
    await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    const certificateFingerprint256 = secure.getPeerCertificate().fingerprint256;
    const digest = createHash('sha256'); let bytes = 0;
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ host: command.hostname, port: command.port, method: 'GET', path: command.path,
        createConnection: () => secure, headers: { host: command.hostname, connection: 'close', 'accept-encoding': 'identity' } }, (message) => {
        message.on('data', (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) message.destroy(new Error('response body bound')); else digest.update(chunk); });
        message.once('error', reject);
        message.once('end', () => resolve({ status: message.statusCode, location: message.headers.location ?? null }));
      });
      request.once('error', reject); request.end();
    });
    const answer = { ...response, bodyBytes: bytes, bodySha256: digest.digest('hex'), authorized: secure.authorized,
      certificateFingerprint256 };
    secure.destroy(); return answer;
  }
  throw new Error('Unsupported guest operation');
}

let pending = Buffer.alloc(0);
let busy = false;
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  if (pending.length > 16384) { emit({ fatal: 'command byte bound' }); process.exitCode = 1; process.stdin.destroy(); return; }
  const end = pending.indexOf(10);
  if (end < 0) return;
  if (busy || end !== pending.length - 1) { emit({ fatal: 'overlapping guest commands' }); process.exitCode = 1; process.stdin.destroy(); return; }
  const command = JSON.parse(pending.subarray(0, end).toString('utf8')); pending = Buffer.alloc(0); busy = true;
  void perform(command).then((result) => emit({ id: command.id, ok: true, result }), (error) => emit({ id: command.id, ok: false,
    error: { name: error.name, code: error.code ?? null, message: error.message.slice(0, 512) } })).finally(() => { busy = false; });
});
process.stdin.on('end', () => { for (const socket of sockets) socket.destroy(); });
emit({ ready: true });
