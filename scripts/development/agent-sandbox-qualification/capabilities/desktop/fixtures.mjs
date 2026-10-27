// Owned marker listeners and exclusive fixture-range admission for the private mechanism probe.

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';

function interval(cidr) {
  const [address, prefixText] = cidr.split('/');
  assert.equal(net.isIP(address), 4, 'Fixture overlap checks require IPv4 CIDRs.');
  const prefix = Number(prefixText);
  assert(Number.isInteger(prefix) && prefix >= 0 && prefix <= 32);
  const value = address.split('.').reduce((result, part) => result * 256 + Number(part), 0);
  const size = 2 ** (32 - prefix), first = Math.floor(value / size) * size;
  return [first, first + size - 1];
}

export function assertFixtureSubnetAvailable(authority, subnet) {
  const [first, last] = interval(subnet);
  const cidrs = [...authority.excludedCidrs.filter((cidr) => !cidr.includes(':') && !cidr.endsWith('/0'))];
  for (const network of authority.networks) for (const config of network.IPAM?.Config ?? []) {
    if (config.Subnet && !config.Subnet.includes(':')) cidrs.push(config.Subnet);
  }
  for (const cidr of cidrs) {
    const [start, end] = interval(cidr);
    assert(first > end || start > last, `Fixture subnet ${subnet} overlaps observed coverage ${cidr}.`);
  }
}

export async function startMarkerServer({ host, ports, marker, probe, udpPort = null }) {
  const sockets = new Set();
  const servers = [];
  const counts = { connections: 0, requests: 0, invalidRequests: 0, datagrams: 0 };
  let udp;
  let closeActual;
  const close = () => {
    closeActual ??= (async () => {
      const socketClosures = [...sockets].map((socket) => new Promise((resolve) => socket.once('close', resolve)));
      for (const socket of sockets) socket.destroy();
      const results = await Promise.allSettled(servers.map((server) => new Promise((resolve, reject) => {
        server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      })));
      if (udp) await new Promise((resolve, reject) => {
        try { udp.close(resolve); } catch (error) { if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve(); else reject(error); }
      });
      await Promise.all(socketClosures);
      const failures = results.filter(({ status }) => status === 'rejected').map(({ reason }) => reason);
      if (failures.length) throw new AggregateError(failures, 'Marker TCP listeners did not close.');
    })();
    return closeActual;
  };
  try {
    const selectedPorts = [];
    for (const port of ports) {
      const server = net.createServer((socket) => {
        counts.connections += 1; sockets.add(socket);
        let bytes = Buffer.alloc(0), answered = false;
        const timer = setTimeout(() => socket.destroy(), 5000);
        socket.on('error', () => {});
        socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
        socket.on('data', (chunk) => {
          if (answered) return;
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > 1024) { counts.invalidRequests += 1; answered = true; socket.destroy(); return; }
          if (bytes.length >= Buffer.byteLength(probe)) {
            answered = true;
            if (bytes.toString('utf8') === probe) { counts.requests += 1; socket.end(marker); }
            else { counts.invalidRequests += 1; socket.destroy(); }
          }
        });
      });
      servers.push(server); server.maxConnections = 16;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      selectedPorts.push(server.address().port);
    }
    if (udpPort !== null) {
      udp = dgram.createSocket('udp4');
      udp.on('message', (bytes, peer) => {
        counts.datagrams += 1;
        if (bytes.length <= 1024 && bytes.toString('utf8') === probe) udp.send(marker, peer.port, peer.address, () => {});
      });
      await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(udpPort, host, resolve); });
    }
    return { host, ports: selectedPorts, udpPort: udp ? udp.address().port : null, marker, probe,
      snapshot() { return { ...counts, active: sockets.size }; }, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Marker acquisition and cleanup failed.'); }
    throw error;
  }
}

export async function runMarkerFixture(configuration) {
  const marker = await startMarkerServer({ ...configuration, host: '0.0.0.0', ports: [443, 8080], udpPort: 8080 });
  const sockets = new Set();
  const control = http.createServer({ maxHeaderSize: 4096, requestTimeout: 5000 }, (request, response) => {
    if (request.method !== 'GET' || request.url !== '/census') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify(marker.snapshot()));
  });
  control.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  try { await new Promise((resolve, reject) => { control.once('error', reject); control.listen(9901, '127.0.0.1', resolve); }); }
  catch (error) { await marker.close(); throw error; }
  let closing;
  const close = () => {
    closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => control.close((error) => error ? reject(error) : resolve()));
      await marker.close();
    })();
    return closing;
  };
  const stop = () => { void close().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  process.stdout.write(`${JSON.stringify({ ready: true, ports: marker.ports, udpPort: 8080 })}\n`);
}
