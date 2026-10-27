import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { lstat, readFile, readlink } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

const timeoutMs = Number(process.argv[2]);
assert(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30_000);
const sockets = new Set(); const held = new Map();
const track = (socket) => {
  assert(sockets.size < 16); sockets.add(socket); socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket)); return socket;
};
async function connect(host, port) {
  const socket = track(net.connect({ host, port }));
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Network operation deadline.')));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject);
    socket.once('close', () => reject(new Error('Connection closed before establishment.'))); });
  return socket;
}
async function closeTcp(socket) {
  if (socket.closed) return;
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.destroy(); await closed;
}
async function tcpAdmission(command) {
  const socket = track(net.connect({ host: command.host, port: command.port }));
  socket.setTimeout(timeoutMs, () => socket.destroy(Object.assign(new Error('TCP admission observation deadline.'), { code: 'QUALIFICATION_DEADLINE' })));
  let peer;
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
      socket.once('close', () => reject(new Error('TCP closed before connection admission.')));
    });
    peer = { connected: true, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort };
  } finally { await closeTcp(socket); }
  return { ...peer, closed: true };
}
async function udpSubmission(command) {
  const socket = dgram.createSocket(net.isIP(command.host) === 6 ? 'udp6' : 'udp4');
  socket.on('error', () => {});
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('UDP submission observation deadline.'), { code: 'QUALIFICATION_DEADLINE' })), timeoutMs);
      socket.once('error', reject);
      socket.send(command.probe, command.port, command.host, (error) => error ? reject(error) : resolve());
    });
  } finally {
    clearTimeout(timer);
    await new Promise((resolve, reject) => {
      try { socket.close(resolve); }
      catch (error) { if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve(); else reject(error); }
    });
  }
  return { submitted: true, bytes: Buffer.byteLength(command.probe), closed: true };
}
async function proxy(wire) {
  const socket = await connect('127.0.0.1', 3128);
  let bytes = Buffer.alloc(0);
  const header = await new Promise((resolve, reject) => {
    const receive = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 16 * 1024) { socket.destroy(new Error('Proxy response bound.')); return; }
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', receive); socket.pause();
      if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4));
      resolve(bytes.subarray(0, end + 4).toString('ascii'));
    };
    socket.on('data', receive); socket.once('error', reject);
    socket.once('close', () => reject(new Error('Proxy closed before its response.')));
    socket.write(wire);
  });
  assert.match(header, /^HTTP\/1\.1 [0-9]{3} /u);
  return { socket, header, status: Number(header.slice(9, 12)) };
}
async function secure(command) {
  let socket;
  if (command.direct) socket = await connect(command.hostname, command.port);
  else {
    const tunnel = await proxy(`CONNECT ${command.hostname}:${command.port} HTTP/1.1\r\nHost: ${command.hostname}:${command.port}\r\n\r\n`);
    assert.equal(tunnel.status, 200); socket = tunnel.socket;
  }
  const stream = track(tls.connect({ socket, servername: command.hostname, rejectUnauthorized: true }));
  stream.setTimeout(timeoutMs, () => stream.destroy(new Error('TLS operation deadline.')));
  await new Promise((resolve, reject) => { stream.once('secureConnect', resolve); stream.once('error', reject);
    stream.once('close', () => reject(new Error('TLS closed before verification.'))); });
  assert.equal(stream.authorized, true);
  return stream;
}
async function perform(command) {
  if (command.kind === 'tcp-connect') return tcpAdmission(command);
  if (command.kind === 'udp-send') return udpSubmission(command);
  if (command.kind === 'facts') {
    let socketVisible;
    try { socketVisible = (await lstat('/run/agenai-egress/connect.sock')).isSocket(); }
    catch (error) { socketVisible = error.code; }
    return { platform: process.platform, architecture: process.arch, node: process.version,
      uid: process.getuid(), gid: process.getgid(), proxyEnvironment: Object.keys(process.env).filter((name) => /proxy/iu.test(name)),
      socketVisible, route: await readFile('/proc/net/route', 'utf8'), ipv6Route: await readFile('/proc/net/ipv6_route', 'utf8'),
      networkNamespace: await readlink('/proc/self/ns/net'), pidNamespace: await readlink('/proc/self/ns/pid') };
  }
  if (command.kind === 'proxy') {
    const result = await proxy(command.header); result.socket.destroy(); return { status: result.status, header: result.header };
  }
  if (command.kind === 'tcp') {
    const socket = await connect(command.host, command.port); const chunks = []; let bytes = 0;
    try {
      await new Promise((resolve, reject) => {
        socket.on('data', (chunk) => { bytes += chunk.length; if (bytes > 4096) socket.destroy(new Error('Marker response bound.')); else chunks.push(chunk); });
        socket.once('end', resolve); socket.once('error', reject);
        socket.once('close', () => reject(new Error('Marker connection closed before EOF.'))); socket.write(command.probe);
      });
      return { bytes: Buffer.concat(chunks).toString('utf8'), remoteAddress: socket.remoteAddress };
    } finally { socket.destroy(); }
  }
  if (command.kind === 'udp') {
    const socket = dgram.createSocket(net.isIP(command.host) === 6 ? 'udp6' : 'udp4');
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('UDP marker response deadline.')), timeoutMs);
        socket.once('error', reject); socket.once('message', (bytes, peer) => {
          assert(bytes.length <= 4096); resolve({ bytes: bytes.toString('utf8'), remoteAddress: peer.address });
        });
        socket.send(command.probe, command.port, command.host, (error) => { if (error) reject(error); });
      });
    } finally { clearTimeout(timer); try { socket.close(); } catch (error) { if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error; } }
  }
  if (command.kind === 'lookup') {
    const resolver = new Resolver({ timeout: Math.min(timeoutMs, 2000), tries: 1 });
    try {
      const read = async (family) => {
        try { return await (family === 4 ? resolver.resolve4(command.hostname) : resolver.resolve6(command.hostname)); }
        catch (error) { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error; }
      };
      const [ipv4, ipv6] = await Promise.all([read(4), read(6)]); return { ipv4, ipv6 };
    } finally { resolver.cancel(); }
  }
  if (command.kind === 'tls') {
    const stream = await secure(command); const hash = createHash('sha256'); let bytes = 0;
    const verified = { authorized: stream.authorized, tls: stream.getProtocol(), certificateFingerprint256: stream.getPeerCertificate().fingerprint256 };
    assert.equal(typeof verified.certificateFingerprint256, 'string');
    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.request({ host: command.hostname, port: command.port, path: command.path,
          createConnection: () => stream, headers: { host: command.hostname, connection: 'close', 'accept-encoding': 'identity' } }, (message) => {
          message.on('data', (chunk) => { bytes += chunk.length; if (bytes > 262_144) message.destroy(new Error('TLS body bound.')); else hash.update(chunk); });
          message.once('error', reject); message.once('aborted', () => reject(new Error('TLS body interrupted.')));
          message.once('end', () => resolve({ status: message.statusCode }));
        });
        request.once('error', reject); request.end();
      });
      return { ...response, ...verified, bodyBytes: bytes, bodySha256: hash.digest('hex') };
    } finally { stream.destroy(); }
  }
  if (command.kind === 'hold') {
    assert(held.size < 2 && !held.has(command.key));
    const stream = await secure(command); stream.setTimeout(0);
    const observation = { accepted: true, authorized: stream.authorized, closed: false,
      certificateFingerprint256: stream.getPeerCertificate().fingerprint256 };
    stream.once('close', () => { observation.closed = true; observation.closedAt = new Date().toISOString(); });
    stream.resume(); held.set(command.key, { stream, observation }); return { ...observation };
  }
  if (command.kind === 'held-status') { assert(held.has(command.key)); return { ...held.get(command.key).observation }; }
  throw new Error('Unknown fixed network guest operation.');
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
emit({ ready: true });
let pending = Buffer.alloc(0);
try {
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]); assert(pending.length <= 32 * 1024);
    for (;;) {
      const end = pending.indexOf(10); if (end < 0) break;
      const command = JSON.parse(pending.subarray(0, end).toString('utf8')); pending = pending.subarray(end + 1);
      try { emit({ id: command.id, ok: true, result: await perform(command) }); }
      catch (error) { emit({ id: command.id, ok: false, error: { name: error.name, code: error.code ?? null, message: error.message.slice(0, 2048) } }); }
    }
  }
  assert.equal(pending.length, 0);
} finally { for (const socket of sockets) socket.destroy(); }
