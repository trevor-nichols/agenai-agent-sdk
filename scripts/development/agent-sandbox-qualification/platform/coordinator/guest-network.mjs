import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

const admittedHosts = new Set(['github.com', 'example.com']);

async function closed(socket) {
  if (socket.closed) return;
  await new Promise((resolve) => { socket.once('close', resolve); socket.destroy(); });
}

async function header(socket, request, maximum = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const failed = (error) => { detach(); reject(error); };
    const ended = () => failed(new Error('Network peer closed before a complete response header.'));
    const receive = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > maximum) { failed(new Error('Network response header exceeded its bound.')); return; }
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      detach(); socket.pause();
      if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4));
      resolve(bytes.subarray(0, end + 4).toString('ascii'));
    };
    const detach = () => { socket.off('data', receive); socket.off('error', failed); socket.off('close', ended); };
    socket.on('data', receive); socket.once('error', failed); socket.once('close', ended);
    socket.resume(); socket.write(request, (error) => { if (error) failed(error); });
  });
}

export async function networkProbe(kind, hostname, timeoutMs) {
  assert(admittedHosts.has(hostname));
  assert(kind === 'tls' || kind === 'connect');
  const socket = net.connect({ host: '127.0.0.1', port: 3128 });
  socket.on('error', () => {});
  const deadline = setTimeout(() => socket.destroy(new Error('Fixed network probe deadline.')), timeoutMs);
  let secure;
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
      socket.once('close', () => reject(new Error('Proxy closed before establishment.')));
    });
    const response = await header(socket, `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 [0-9]{3} /u);
    const proxyStatus = Number(response.slice(9, 12));
    if (kind === 'connect') return { hostname, proxyStatus, responseLine: response.split('\r\n')[0] };
    assert.equal(proxyStatus, 200);
    secure = tls.connect({ socket, servername: hostname, rejectUnauthorized: true });
    secure.on('error', () => {});
    const secureDeadline = setTimeout(() => secure.destroy(new Error('Fixed TLS probe deadline.')), timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        secure.once('secureConnect', resolve); secure.once('error', reject);
        secure.once('close', () => reject(new Error('TLS closed before certificate verification.')));
      });
      assert.equal(secure.authorized, true);
      const identity = { hostname, proxyStatus, authorized: secure.authorized, protocol: secure.getProtocol(),
        certificateFingerprint256: secure.getPeerCertificate().fingerprint256, remoteAddress: socket.remoteAddress };
      assert.equal(typeof identity.certificateFingerprint256, 'string');
      const path = hostname === 'github.com' ? '/robots.txt' : '/';
      const responseHeader = await header(secure, `HEAD ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\nUser-Agent: AgenAI-SDK-MS004-qualification\r\n\r\n`);
      assert.match(responseHeader, /^HTTP\/1\.[01] [0-9]{3} /u);
      return { ...identity, status: Number(responseHeader.slice(9, 12)), responseLine: responseHeader.split('\r\n')[0] };
    } finally { clearTimeout(secureDeadline); await closed(secure); }
  } finally { clearTimeout(deadline); await closed(socket); }
}
