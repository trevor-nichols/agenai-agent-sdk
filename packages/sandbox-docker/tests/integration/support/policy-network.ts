// ------------------------------------------------------------------------------------------------
//                policy-network.ts - Owned host route observations and exact-marker listener
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';

export function desktopHostRoute(observed: unknown) {
  assert(observed !== null && typeof observed === 'object');
  assert('mode' in observed && observed.mode === 'resolve-host');
  assert('hostname' in observed && observed.hostname === 'host.docker.internal');
  assert('family' in observed && observed.family === 4);
  assert('address' in observed && typeof observed.address === 'string' && isIPv4(observed.address),
    'Desktop host discovery must return a numeric IPv4 address from the outbound guest.');
  return { kind: 'desktop-host-route', targetAddress: observed.address, bindAddress: '0.0.0.0' } as const;
}

export function linuxBridgeRoute(observed: unknown) {
  assert(observed !== null && typeof observed === 'object' && 'IPAM' in observed);
  const ipam = observed.IPAM;
  assert(ipam !== null && typeof ipam === 'object' && 'Config' in ipam && Array.isArray(ipam.Config));
  const entry: unknown = ipam.Config[0];
  assert(entry !== null && typeof entry === 'object' && 'Gateway' in entry
    && typeof entry.Gateway === 'string' && isIPv4(entry.Gateway),
    'Linux host discovery must return the owned bridge numeric IPv4 gateway.');
  return { kind: 'linux-owned-bridge', targetAddress: entry.Gateway, bindAddress: entry.Gateway } as const;
}

interface PolicyRequestObservation {
  readonly method: string | null;
  readonly path: string | null;
  readonly matched: boolean;
}

interface PolicyHostListener {
  readonly bindAddress: string;
  readonly port: number;
  readonly marker: string;
  readonly path: string;
  readonly requests: readonly PolicyRequestObservation[];
  readonly census: { total: number };
  readonly cleanup: { state: 'pending' | 'entered' | 'complete' };
}

export async function withPolicyHostListener<T>(bindAddress: string,
  observe: (listener: PolicyHostListener) => Promise<T>): Promise<T> {
  assert(isIPv4(bindAddress), 'The policy listener requires an explicit numeric IPv4 bind address.');
  const marker = randomUUID();
  const pathname = `/${marker}`;
  const requests: PolicyRequestObservation[] = [];
  const census = { total: 0 };
  const cleanup: PolicyHostListener['cleanup'] = { state: 'pending' };
  const server = createServer({ maxHeaderSize: 1024, headersTimeout: 2000, requestTimeout: 2000, keepAliveTimeout: 1 }, (request, response) => {
    const matched = request.method === 'GET' && request.url === pathname;
    census.total += 1;
    if (requests.length < 16) requests.push({ method: request.method ?? null, path: request.url ?? null, matched });
    response.writeHead(matched ? 200 : 404, { 'content-type': 'text/plain', connection: 'close' });
    response.end(matched ? marker : 'missing');
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, bindAddress, resolve); });
    const address = server.address();
    assert(address !== null && typeof address === 'object');
    return await observe({ bindAddress, port: address.port, marker, path: pathname, requests, census, cleanup });
  } finally {
    cleanup.state = 'entered';
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error && 'code' in error && error.code !== 'ERR_SERVER_NOT_RUNNING'
      ? reject(error) : resolve()));
    cleanup.state = 'complete';
  }
}
