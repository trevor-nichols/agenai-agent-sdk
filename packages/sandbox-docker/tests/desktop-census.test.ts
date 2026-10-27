// ------------------------------------------------------------------------------------------------
//                desktop-census.test.ts - Complete selected Engine inspection over actual Unix HTTP
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';
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
    for (const [name, invalid] of [
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
