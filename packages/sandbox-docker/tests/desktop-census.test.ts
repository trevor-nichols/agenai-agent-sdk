// ------------------------------------------------------------------------------------------------
//                desktop-census.test.ts - Complete selected Engine inspection over actual Unix HTTP
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi, DockerResponseByteBudget } from '../src/resources/api.js';
import { readDesktopEngineNetworks } from '../src/network/desktop/observation/engine.js';
import { engineFixture } from './fixtures/engine.js';

const networkId = '1'.repeat(64);
function network() {
  return { Id: networkId, Name: 'external-public-network', Created: '2026-10-26T00:00:00Z', Driver: 'bridge', Scope: 'local',
    Internal: false, Attachable: false, Ingress: false, EnableIPv6: false, ConfigOnly: false,
    IPAM: { Driver: 'default', Options: null, Config: [{ Subnet: '11.7.0.0/16', Gateway: '11.7.0.1' }] },
    Options: {}, Labels: {}, Containers: {} };
}

test('Desktop census retains publicly numbered Engine coverage and rejects incomplete inspection data', async (context) => {
  let value: unknown = network();
  const fixture = await engineFixture({ async handleRequest({ path, response }) {
    const body = path === '/v1.52/networks' ? [{ Id: networkId }] : path === `/v1.52/networks/${networkId}` ? value : undefined;
    if (body === undefined) return false;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); return true;
  } });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 1000);
  try {
    const census = await readDesktopEngineNetworks(api);
    assert.equal(census.networks.length, 1); assert(census.excludedCidrs.includes('11.7.0.0/16'));
    const endpointId = '2'.repeat(64);
    const endpoint = { Name: 'retiring', EndpointID: endpointId, MacAddress: '02:42:0b:07:00:02', IPv4Address: '11.7.0.2/16', IPv6Address: '' };
    value = { ...network(), Containers: { [`ep-${endpointId}`]: endpoint } };
    assert.deepEqual(Object.keys((await readDesktopEngineNetworks(api)).networks[0].Containers), [`ep-${endpointId}`],
      'Moby lists an endpoint that left its sandbox before deletion under its endpoint identity.');
    for (const [name, invalid] of [
      ['foreign membership key', () => ({ ...network(), Containers: { [`sb-${endpointId}`]: endpoint } })],
      ['abbreviated detached key', () => ({ ...network(), Containers: { [`ep-${endpointId.slice(12)}`]: endpoint } })],
      ['missing membership', () => { const result = network(); Reflect.deleteProperty(result, 'Containers'); return result; }],
      ['null membership', () => ({ ...network(), Containers: null })],
      ['empty allocated IPAM', () => ({ ...network(), IPAM: { Driver: 'default', Options: null, Config: [] } })],
      ['missing allocated subnet', () => ({ ...network(), IPAM: { Driver: 'default', Options: null, Config: [{ Gateway: '11.7.0.1' }] } })],
    ] as const) await context.test(name, async () => {
      value = invalid();
      await assert.rejects(readDesktopEngineNetworks(api), { name: 'SandboxOperationError', code: 'driver_failure' });
    });
  } finally { await fixture.close(); }
});

test('one raw response budget spans info, both network lists and inspections across complete censuses', async () => {
  const info = { ID: 'engine', Name: 'host', KernelVersion: 'kernel' };
  const list = [{ Id: networkId }];
  const inspection = network();
  const bodies = new Map([
    ['/info', JSON.stringify(info)], ['/v1.52/networks', JSON.stringify(list)],
    [`/v1.52/networks/${networkId}`, JSON.stringify(inspection)],
  ]);
  const fixture = await engineFixture({ async handleRequest({ path, response }) {
    const body = bodies.get(path);
    if (body === undefined) return false;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(body); return true;
  } });
  const censusBytes = Buffer.byteLength(JSON.stringify(info)) + 2 * Buffer.byteLength(JSON.stringify(list))
    + Buffer.byteLength(JSON.stringify(inspection));
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 1000);
  const budget = new DockerResponseByteBudget(2 * censusBytes - 1);
  try {
    assert.equal((await readDesktopEngineNetworks(api, undefined, budget)).networks.length, 1);
    await assert.rejects(readDesktopEngineNetworks(api, undefined, budget), { name: 'SandboxOperationError', code: 'output_limit' });
    const censusPaths = ['/info', '/v1.52/networks', `/v1.52/networks/${networkId}`, '/v1.52/networks'];
    assert.deepEqual(fixture.requests.map((request) => request.path), [...censusPaths, ...censusPaths]);
  } finally { await fixture.close(); }
});

test('normalized network retention rejects a UTF-8 census above sixteen MiB before reading later networks', async () => {
  const ids = Array.from({ length: 18 }, (_, index) => (index + 1).toString(16).padStart(64, '0'));
  const padding = 'é'.repeat(511 * 1024);
  const fixture = await engineFixture({ async handleRequest({ path, response }) {
    const selected = path.startsWith('/v1.52/networks/') ? path.slice('/v1.52/networks/'.length) : undefined;
    const body = path === '/v1.52/networks' ? ids.map((Id) => ({ Id }))
      : selected !== undefined ? { ...network(), Id: selected, Padding: padding } : undefined;
    if (body === undefined) return false;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); return true;
  } });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 1000);
  try {
    await assert.rejects(readDesktopEngineNetworks(api), {
      name: 'SandboxOperationError', code: 'output_limit', message: 'Docker normalized network census exceeds its 16-MiB byte bound.',
    });
    assert.deepEqual(fixture.requests.map((request) => request.path), ['/info', '/v1.52/networks',
      ...ids.slice(0, 17).map((selected) => `/v1.52/networks/${selected}`)]);
  } finally { await fixture.close(); }
});
