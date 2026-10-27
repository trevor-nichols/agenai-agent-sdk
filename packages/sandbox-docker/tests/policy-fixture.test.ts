// ------------------------------------------------------------------------------------------------
//                policy-fixture.test.ts - Host discovery validation and real listener ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { desktopHostRoute, linuxBridgeRoute, withPolicyHostListener } from './integration/support/policy-network.js';

function probe(target: string, method = 'GET'): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(target, { method, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    sent.setTimeout(2000, () => sent.destroy(new Error('Local policy fixture probe exceeded its deadline.')));
    sent.once('error', reject);
    sent.end();
  });
}

test('policy host discovery requires observed numeric IPv4 before constructing either reachability target', () => {
  const desktop = { mode: 'resolve-host', hostname: 'host.docker.internal', family: 4, address: '192.168.65.254' };
  assert.deepEqual(desktopHostRoute(desktop), {
    kind: 'desktop-host-route', targetAddress: '192.168.65.254', bindAddress: '0.0.0.0',
  });
  assert.deepEqual(linuxBridgeRoute({ IPAM: { Config: [{ Gateway: '172.19.0.1' }] } }), {
    kind: 'linux-owned-bridge', targetAddress: '172.19.0.1', bindAddress: '172.19.0.1',
  });
  for (const address of ['host.docker.internal', '999.1.2.3', '::1', '', undefined]) {
    assert.throws(() => desktopHostRoute({ ...desktop, address }), /numeric IPv4/u);
    assert.throws(() => linuxBridgeRoute({ IPAM: { Config: [{ Gateway: address }] } }), /numeric IPv4/u);
  }
  assert.throws(() => desktopHostRoute({ mode: 'resolve-host', hostname: 'host.docker.internal', error: 'ENOTFOUND' }));
  assert.throws(() => desktopHostRoute({ ...desktop, hostname: 'different-host.invalid' }));
  assert.throws(() => linuxBridgeRoute({ IPAM: { Config: [] } }));
});

test('temporary wildcard listener serves only its fresh exact GET marker and retains the actual request census', { timeout: 5000 }, async () => {
  const observed = await withPolicyHostListener('0.0.0.0', async (listener) => {
    assert.match(listener.marker, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    const target = `http://127.0.0.1:${listener.port}${listener.path}`;
    assert.deepEqual(await probe(target), { status: 200, body: listener.marker });
    assert.deepEqual(await probe(target, 'POST'), { status: 404, body: 'missing' });
    assert.deepEqual(await probe(`${target}?unexpected=1`), { status: 404, body: 'missing' });
    assert.deepEqual(await probe(`http://127.0.0.1:${listener.port}/unowned`), { status: 404, body: 'missing' });
    assert.deepEqual(listener.requests, [
      { method: 'GET', path: listener.path, matched: true },
      { method: 'POST', path: listener.path, matched: false },
      { method: 'GET', path: `${listener.path}?unexpected=1`, matched: false },
      { method: 'GET', path: '/unowned', matched: false },
    ]);
    assert.equal(listener.census.total, 4);
    assert.deepEqual(listener.cleanup, { state: 'pending' });
    return { target, cleanup: listener.cleanup };
  });
  assert.deepEqual(observed.cleanup, { state: 'complete' });
  await assert.rejects(probe(observed.target), { code: 'ECONNREFUSED' });
});

test('host listener closes its real socket when an entered policy observation fails', { timeout: 5000 }, async () => {
  let target = '';
  const failure = new Error('intentional entered policy failure');
  await assert.rejects(withPolicyHostListener('127.0.0.1', async (listener) => {
    target = `http://127.0.0.1:${listener.port}${listener.path}`;
    assert.deepEqual(await probe(target), { status: 200, body: listener.marker });
    throw failure;
  }), (error: unknown) => error === failure);
  await assert.rejects(probe(target), { code: 'ECONNREFUSED' });
});
