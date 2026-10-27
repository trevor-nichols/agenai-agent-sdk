// One bounded, credential-free network operation in an explicitly selected container.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { lstat, readFile, readlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

export async function runGuest(command) {
  const sockets = new Set();
  const datagrams = new Set();
  const resolvers = new Set();
  let expired = false;
  const track = (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
  const timer = setTimeout(() => {
    expired = true;
    for (const socket of sockets) socket.destroy(new Error('Guest operation deadline.'));
    for (const socket of datagrams) socket.close();
    for (const resolver of resolvers) resolver.cancel();
  }, command.timeoutMs);
  const connect = async (host, port) => {
    const socket = track(net.connect({ host, port }));
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
      socket.once('close', () => reject(new Error('Connection closed before establishment.')));
    });
    return socket;
  };
  const proxy = async (header) => {
    const socket = await connect('127.0.0.1', 3128);
    let bytes = Buffer.alloc(0);
    const response = await new Promise((resolve, reject) => {
      const receive = (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 16384) { reject(new Error('Proxy response header exceeds its byte bound.')); socket.destroy(); return; }
        const end = bytes.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.removeListener('data', receive); socket.pause();
        if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4));
        resolve(bytes.subarray(0, end + 4).toString('ascii'));
      };
      socket.on('data', receive); socket.once('error', reject);
      socket.once('close', () => reject(new Error('Proxy closed before its response.')));
      socket.write(header);
    });
    const status = /^HTTP\/1\.1 ([0-9]{3}) /u.exec(response);
    assert(status, 'Proxy returned an invalid response status.');
    return { socket, header: response, status: Number(status[1]) };
  };
  const secureTunnel = async () => {
    const result = await proxy(`CONNECT ${command.hostname}:${command.port} HTTP/1.1\r\nHost: ${command.hostname}:${command.port}\r\n\r\n`);
    assert.equal(result.status, 200, 'CONNECT was not accepted.');
    const socket = track(tls.connect({ socket: result.socket, servername: command.hostname, rejectUnauthorized: true }));
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve); socket.once('error', reject);
      socket.once('close', () => reject(new Error('TLS closed before peer verification.')));
    });
    assert.equal(socket.authorized, true);
    return socket;
  };
  try {
    let result;
    if (command.kind === 'facts') {
      let socketVisible;
      try { socketVisible = (await lstat('/run/agenai-egress/connect.sock')).isSocket(); }
      catch (error) { socketVisible = error.code; }
      result = { node: process.version, architecture: process.arch, uid: process.getuid(), gid: process.getgid(),
        route: await readFile('/proc/net/route', 'utf8'), ipv6Route: await readFile('/proc/net/ipv6_route', 'utf8'),
        networkNamespace: await readlink('/proc/self/ns/net'), pidNamespace: await readlink('/proc/self/ns/pid'),
        proxyEnvironment: Object.keys(process.env).filter((key) => /^(?:https?|all|no)_proxy$/iu.test(key)), socketVisible };
    } else if (command.kind === 'tcp') {
      const socket = await connect(command.host, command.port);
      const chunks = []; let bytes = 0;
      await new Promise((resolve, reject) => {
        socket.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 4096) { reject(new Error('Marker response exceeds its byte bound.')); socket.destroy(); }
          else chunks.push(chunk);
        });
        socket.once('error', reject); socket.once('end', resolve);
        socket.once('close', () => reject(new Error('Marker connection closed before its response ended.')));
        socket.write(command.probe);
      });
      result = { connected: true, bytes: Buffer.concat(chunks).toString('utf8'), remoteAddress: socket.remoteAddress };
    } else if (command.kind === 'udp') {
      const socket = dgram.createSocket(net.isIP(command.host) === 6 ? 'udp6' : 'udp4'); datagrams.add(socket);
      socket.once('close', () => datagrams.delete(socket));
      result = await new Promise((resolve, reject) => {
        socket.once('error', reject); socket.once('close', () => reject(new Error('UDP operation closed before its marker response.')));
        if (command.reply) socket.once('message', (bytes) => {
          if (bytes.length > 4096) reject(new Error('UDP marker exceeds its byte bound.'));
          else resolve({ sent: true, bytes: bytes.toString('utf8') });
        });
        socket.send(command.probe, command.port, command.host, (error) => {
          if (error) reject(error); else if (!command.reply) resolve({ sent: true });
        });
      });
    } else if (command.kind === 'lookup') {
      const resolver = new Resolver({ timeout: Math.min(command.timeoutMs, 2000), tries: 1 }); resolvers.add(resolver);
      const read = async (family) => {
        try { return await (family === 4 ? resolver.resolve4(command.hostname) : resolver.resolve6(command.hostname)); }
        catch (error) { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error; }
      };
      const [ipv4, ipv6] = await Promise.all([read(4), read(6)]); result = { ipv4, ipv6 };
    } else if (command.kind === 'proxy') {
      const response = await proxy(command.header); result = { header: response.header, status: response.status };
    } else if (command.kind === 'tls') {
      const secure = await secureTunnel();
      const certificateFingerprint256 = secure.getPeerCertificate().fingerprint256, tlsVersion = secure.getProtocol();
      const hash = createHash('sha256'); let bytes = 0;
      const response = await new Promise((resolve, reject) => {
        const request = http.request({ host: command.hostname, port: command.port, method: 'GET', path: command.path,
          createConnection: () => secure, headers: { host: command.hostname, connection: 'close', 'accept-encoding': 'identity' } }, (message) => {
          message.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) message.destroy(new Error('HTTPS response body exceeds its byte bound.'));
            else hash.update(chunk);
          });
          message.once('error', reject); message.once('end', () => resolve({ status: message.statusCode }));
          message.once('aborted', () => reject(new Error('HTTPS response body was interrupted.')));
        });
        request.once('error', reject); request.end();
      });
      result = { ...response, authorized: secure.authorized, certificateFingerprint256,
        tls: tlsVersion, bodyBytes: bytes, bodySha256: hash.digest('hex') };
    } else if (command.kind === 'hold') {
      const secure = await secureTunnel();
      const ready = { accepted: true, authorized: secure.authorized, certificateFingerprint256: secure.getPeerCertificate().fingerprint256 };
      let ended = secure.destroyed;
      const closed = new Promise((resolve) => { if (ended) resolve(); else secure.once('close', () => { ended = true; resolve(); }); });
      await writeFile(command.readyPath, JSON.stringify(ready), { flag: 'wx', mode: 0o600 });
      assert(!ended, 'Held TLS tunnel closed before its readiness was published.');
      secure.resume(); await closed;
      result = { ...ready, closed: true };
    } else if (command.kind === 'held-ready') {
      try {
        const bytes = await readFile(command.readyPath); assert(bytes.length <= 4096); result = JSON.parse(bytes.toString('utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; result = { accepted: false }; }
    } else if (command.kind === 'marker-census') {
      result = await new Promise((resolve, reject) => {
        const request = http.get('http://127.0.0.1:9901/census', (response) => {
          const chunks = []; let bytes = 0;
          response.on('data', (chunk) => { bytes += chunk.length; if (bytes > 4096) response.destroy(new Error('Marker census exceeds its byte bound.')); else chunks.push(chunk); });
          response.once('error', reject); response.once('end', () => {
            try { assert.equal(response.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (error) { reject(error); }
          });
        });
        request.on('socket', track); request.once('error', reject);
      });
    } else throw new Error('Unsupported mechanism guest operation.');
    if (expired) throw new Error('Guest operation deadline.');
    return result;
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    for (const socket of datagrams) {
      try { socket.close(); } catch (error) { if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error; }
    }
    for (const resolver of resolvers) resolver.cancel();
  }
}
