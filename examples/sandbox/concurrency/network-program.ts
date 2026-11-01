import { CONCURRENT_PROTOCOL } from './protocol.js';

/** Fixed guest module; all destinations and response bounds come from the caller's explicit fixtures. */
export const CONCURRENT_NETWORK_PROGRAM = String.raw`
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';

const sockets = new Set();
const lifecycle = new WeakMap();
const boundedText = (value, maximum) => String(value).replace(/[^\x20-\x7e]|["\\]/gu, '?').slice(0, maximum);
const failureFacts = (error) => ({ name: boundedText(error?.name ?? 'ThrownValue', 24),
  code: typeof error?.code === 'string' ? boundedText(error.code, 64) : null, message: boundedText(error?.message ?? error, 64) });
function track(socket) {
  sockets.add(socket);
  const facts = { error: null, end: null, close: null, ownerCloseRequestedAt: null }; lifecycle.set(socket, facts);
  socket.on('error', (error) => { facts.error ??= { at: new Date().toISOString(), ...failureFacts(error) }; });
  socket.once('end', () => { facts.end = new Date().toISOString(); });
  socket.once('close', (hadError) => { facts.close = { at: new Date().toISOString(), hadError }; sockets.delete(socket); });
  return socket;
}
async function close(socket) {
  if (!socket || lifecycle.get(socket).close) return;
  if (!socket.destroyed) lifecycle.get(socket).ownerCloseRequestedAt ??= new Date().toISOString();
  await new Promise((resolve) => { socket.once('close', resolve); socket.destroy(); });
}
function header(socket, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const failed = (error) => { detach(); reject(error); };
    const ended = () => failed(new Error('Peer closed before a complete response header.'));
    const timer = setTimeout(() => failed(new Error('Explicit response-header deadline.')), timeoutMs);
    function detach() {
      clearTimeout(timer); socket.off('data', receive); socket.off('error', failed); socket.off('end', ended); socket.off('close', ended);
    }
    function receive(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 32 * 1024) { failed(new Error('Response header exceeded 32 KiB.')); return; }
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      detach(); socket.pause();
      if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4));
      resolve(bytes.subarray(0, end + 4).toString('latin1'));
    }
    socket.on('data', receive); socket.once('error', failed); socket.once('end', ended); socket.once('close', ended);
    socket.resume();
    socket.write(request, (error) => { if (error) failed(error); });
  });
}
async function connect(hostname, port, timeoutMs) {
  const socket = track(net.connect({ host: '127.0.0.1', port: 3128 }));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { detach(); reject(new Error('Explicit proxy connection deadline.')); }, timeoutMs);
      const connected = () => { detach(); resolve(); };
      const failed = (error) => { detach(); reject(error); };
      const ended = () => failed(new Error('Proxy closed before establishment.'));
      function detach() { clearTimeout(timer); socket.off('connect', connected); socket.off('error', failed); socket.off('close', ended); }
      socket.once('connect', connected); socket.once('error', failed); socket.once('close', ended);
    });
    const response = await header(socket, 'CONNECT ' + hostname + ':' + port + ' HTTP/1.1\r\nHost: ' + hostname + ':' + port + '\r\n\r\n', timeoutMs);
    assert.match(response, /^HTTP\/1\.1 [0-9]{3} /u);
    return { socket, status: Number(response.slice(9, 12)) };
  } catch (error) { await close(socket); throw error; }
}
async function secure(input, timeoutMs) {
  const proxy = await connect(input.hostname, input.port, timeoutMs);
  let stream;
  try {
    assert.equal(proxy.status, 200);
    stream = track(tls.connect({ socket: proxy.socket, servername: input.hostname, rejectUnauthorized: true }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { detach(); reject(new Error('Explicit certificate-verification deadline.')); }, timeoutMs);
      const connected = () => { detach(); resolve(); };
      const failed = (error) => { detach(); reject(error); };
      const ended = () => failed(new Error('TLS closed before certificate verification.'));
      function detach() { clearTimeout(timer); stream.off('secureConnect', connected); stream.off('error', failed); stream.off('close', ended); }
      stream.once('secureConnect', connected); stream.once('error', failed); stream.once('close', ended);
    });
    assert.equal(stream.authorized, true);
    const certificateFingerprint256 = stream.getPeerCertificate().fingerprint256;
    assert.match(certificateFingerprint256, /^(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}$/u);
    return { stream, proxySocket: proxy.socket, certificateFingerprint256, connection: randomUUID() };
  } catch (error) { await close(stream); await close(proxy.socket); throw error; }
}
export async function denied(input, timeoutMs) {
  const opened = await connect(input.hostname, input.port, timeoutMs);
  try { assert.equal(opened.status, 403); return { hostname: input.hostname, port: input.port, proxyStatus: 403 }; }
  finally { await close(opened.socket); }
}
export async function forbidden(input, timeoutMs) {
  const bound = Math.min(timeoutMs, 750);
  const diagnostic = (error) => ({ code: typeof error.code === 'string' ? error.code.slice(0, ${CONCURRENT_PROTOCOL.diagnosticCodeChars}) : null,
    message: String(error.message).slice(0, ${CONCURRENT_PROTOCOL.diagnosticMessageChars}) });
  const direct = input.transport === 'tcp' ? await new Promise((resolve, reject) => {
    const socket = track(net.connect({ host: input.address, port: input.port }));
    const timer = setTimeout(() => socket.destroy(new Error('Explicit forbidden TCP deadline.')), bound);
    socket.once('error', (error) => { clearTimeout(timer); resolve({ kind: 'tcp', connected: false, ...diagnostic(error) }); });
    socket.once('connect', () => {
      clearTimeout(timer); socket.end(input.probe);
      reject(new Error('Forbidden TCP target was reachable: ' + input.marker));
    });
  }) : await new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => { socket.close(); resolve({ kind: 'udp', received: false, code: null, message: 'Explicit forbidden UDP observation deadline.' }); }, bound);
    socket.once('message', () => { clearTimeout(timer); socket.close(); reject(new Error('Forbidden UDP target replied: ' + input.marker)); });
    socket.once('error', (error) => { clearTimeout(timer); socket.close(); resolve({ kind: 'udp', received: false, ...diagnostic(error) }); });
    socket.send(input.probe, input.port, input.address);
  });
  const proxy = await denied(input, timeoutMs);
  return { fixture: input, direct, proxyStatus: proxy.proxyStatus };
}
export async function fresh(input, timeoutMs) {
  const opened = await secure(input, timeoutMs);
  try {
    let bytes = 0; const hash = createHash('sha256');
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: input.hostname, port: input.port, path: input.path,
        createConnection: () => opened.stream, headers: { host: input.hostname, connection: 'close', 'accept-encoding': 'identity' } }, (message) => {
        message.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > input.bodyBytes) message.destroy(new Error('HTTPS body exceeded the explicit byte bound.'));
          else hash.update(chunk);
        });
        message.once('error', reject); message.once('aborted', () => reject(new Error('HTTPS body interrupted.')));
        message.once('end', () => resolve({ status: message.statusCode }));
      });
      const timer = setTimeout(() => request.destroy(new Error('Explicit HTTPS response deadline.')), timeoutMs);
      request.once('close', () => clearTimeout(timer)); request.once('error', reject); request.end();
    });
    const bodySha256 = hash.digest('hex');
    assert.equal(response.status, input.status); assert.equal(bytes, input.bodyBytes); assert.equal(bodySha256, input.bodySha256);
    return { ...response, bodyBytes: bytes, bodySha256, authorized: true, certificateFingerprint256: opened.certificateFingerprint256 };
  } finally { await close(opened.stream); }
}
export async function openHeld(input, timeoutMs) {
  const opened = await secure(input, timeoutMs);
  const openedAt = new Date().toISOString();
  const tlsIdentity = { authorized: true, servername: boundedText(input.hostname, 253), certificateFingerprint256: opened.certificateFingerprint256,
    protocol: opened.stream.getProtocol(), cipher: boundedText(opened.stream.getCipher().name, 48), alpn: boundedText(opened.stream.alpnProtocol, 16) };
  const proxyIdentity = { localAddress: opened.proxySocket.localAddress, localPort: opened.proxySocket.localPort,
    remoteAddress: opened.proxySocket.remoteAddress, remotePort: opened.proxySocket.remotePort };
  const snapshot = (socket) => ({ ...lifecycle.get(socket), state: { destroyed: socket.destroyed, closed: socket.closed,
    readableEnded: socket.readableEnded, writableEnded: socket.writableEnded, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten } });
  let sequence = 0; let firstSuccessfulAt = null; let lastSuccessfulHead = null;
  return {
    async probe() {
      const startedAt = new Date().toISOString();
      try {
        assert(!opened.stream.destroyed && !opened.stream.readableEnded, 'The original held TLS socket closed.');
        const response = await header(opened.stream, 'HEAD ' + input.path + ' HTTP/1.1\r\nHost: ' + input.hostname +
          '\r\nConnection: keep-alive\r\nAccept-Encoding: identity\r\n\r\n', timeoutMs);
        assert.match(response, /^HTTP\/1\.[01] [0-9]{3} /u);
        const status = Number(response.slice(9, 12)); assert.equal(status, input.status);
        assert(!/\r\nconnection:\s*close\s*\r\n/iu.test(response), 'Held TLS endpoint refused keep-alive.');
        const headers = {}; const truncatedHeaders = [];
        for (const [name, limit] of [['connection', 32], ['keep-alive', 48], ['server', 32], ['date', 32], ['content-length', 20], ['x-github-request-id', 96]]) {
          const value = response.split('\r\n').slice(1).find((line) => line.slice(0, line.indexOf(':')).toLowerCase() === name);
          if (value === undefined) continue;
          const original = value.slice(value.indexOf(':') + 1).trim(); headers[name] = boundedText(original, limit);
          if (original.length > limit) truncatedHeaders.push(name);
        }
        const completedAt = new Date().toISOString(); firstSuccessfulAt ??= completedAt;
        lastSuccessfulHead = { sequence: ++sequence, status, startedAt, completedAt, headers, truncatedHeaders,
          headerBytes: Buffer.byteLength(response, 'latin1'), headerSha256: createHash('sha256').update(Buffer.from(response, 'latin1')).digest('hex') };
        return { connection: opened.connection, sequence, status, authorized: true,
          certificateFingerprint256: opened.certificateFingerprint256 };
      } catch (error) {
        const failure = failureFacts(error);
        await Promise.all([close(opened.stream), close(opened.proxySocket)]);
        const diagnostic = { format: 'agenai.concurrent-held-tls-failure.v1', terminationAttribution: 'unattributed',
          textPolicy: 'bounded_printable_ascii', connection: opened.connection, openedAt, firstSuccessfulAt,
          successfulReplies: sequence, lastSuccessfulHead, failedProbe: { startedAt, failure }, tlsIdentity, proxyIdentity,
          streams: { tls: snapshot(opened.stream), proxy: snapshot(opened.proxySocket) } };
        const encoded = JSON.stringify(diagnostic); assert(Buffer.byteLength(encoded) <= 3072, 'Held TLS diagnostic exceeded its fixed byte bound.');
        throw new Error('Held TLS observation failed: ' + encoded);
      }
    },
  };
}
export async function closeNetwork() { await Promise.all([...sockets].map(close)); }
`;
