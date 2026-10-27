import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNoOverlap, createFixtures } from './fixtures.mjs';

test('fixture allocation census accepts exact local unallocated builtins and rejects unavailable allocated coverage', async (t) => {
  const builtin = (name, driver) => ({ Id: (name === 'host' ? 'a' : 'b').repeat(64), Name: name, Driver: driver, Scope: 'local',
    IPAM: { Driver: 'default', Options: null, Config: null }, Containers: {} });
  const bridge = { Id: 'c'.repeat(64), Name: 'owned-bridge', Driver: 'bridge', Scope: 'local',
    IPAM: { Driver: 'default', Options: null, Config: [{ Subnet: '172.18.0.0/16', Gateway: '172.18.0.1' }] }, Containers: {} };
  const original = [builtin('host', 'host'), builtin('none', 'null'), bridge];
  const retained = structuredClone(original);
  await t.test('native builtin null remains raw while finite allocated coverage is checked', () => {
    assert.doesNotThrow(() => assertNoOverlap('11.199.231.0/24', ['192.168.65.0/24'], original));
    assert.deepEqual(original, retained);
  });
  for (const [name, mutate] of [
    ['null allocated bridge', (value) => { value.IPAM.Config = null; }],
    ['missing IPAM', (value) => { delete value.IPAM; }],
    ['missing allocation field', (value) => { delete value.IPAM.Config; }],
    ['empty allocated bridge', (value) => { value.IPAM.Config = []; }],
    ['unknown driver without coverage', (value) => { value.Driver = 'unknown'; value.IPAM.Config = null; }],
    ['unknown driver with empty coverage', (value) => { value.Driver = 'unknown'; value.IPAM.Config = []; }],
    ['missing allocated subnet', (value) => { value.IPAM.Config = [{ Gateway: '172.18.0.1' }]; }],
    ['invalid allocated subnet', (value) => { value.IPAM.Config[0].Subnet = 'invalid/24'; }],
    ['invalid allocated prefix', (value) => { value.IPAM.Config[0].Subnet = '172.18.0.0/33'; }],
    ['extra allocated CIDR separator', (value) => { value.IPAM.Config[0].Subnet = '172.18.0.0/16/ignored'; }],
    ['wrong gateway family', (value) => { value.IPAM.Config[0].Gateway = '::1'; }],
  ]) await t.test(name, () => {
    const invalid = structuredClone(bridge); mutate(invalid);
    assert.throws(() => assertNoOverlap('11.199.231.0/24', [], [invalid]));
  });
  for (const [name, mutate] of [
    ['wrong builtin name', (value) => { value.Name = 'custom-host'; }],
    ['wrong builtin driver', (value) => { value.Driver = 'bridge'; }],
    ['wrong builtin scope', (value) => { value.Scope = 'global'; }],
  ]) await t.test(name, () => {
    const invalid = builtin('host', 'host'); mutate(invalid);
    assert.throws(() => assertNoOverlap('11.199.231.0/24', [], [invalid]));
  });
  await t.test('observed allocation and explicit exclusion still reject overlaps', () => {
    const overlapping = structuredClone(bridge); overlapping.IPAM.Config[0] = { Subnet: '11.199.231.0/24', Gateway: '11.199.231.1' };
    assert.throws(() => assertNoOverlap('11.199.231.0/24', [], [overlapping]), /overlaps/u);
    assert.throws(() => assertNoOverlap('11.199.231.0/24', ['0.0.0.0/0'], [bridge]), /overlaps/u);
  });
});

test('original fixture cleanup deletes its exact container and joins attachment after lost close acknowledgement', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'network-fixture-close-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const id = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`; let actual; let joined = false;
  const network = 'c'.repeat(64);
  const defaultEndpoint = { NetworkID: 'd'.repeat(64), EndpointID: 'e'.repeat(64), MacAddress: '02:42:ac:11:00:02',
    Gateway: '172.17.0.1', IPAddress: '172.17.0.2', IPPrefixLen: 16,
    IPv6Gateway: '', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0, DNSNames: null };
  const requests = []; const completion = Promise.withResolvers();
  const stream = { stdout: Buffer.from(JSON.stringify({ ready: true, ports: [443, 8080], udpPort: 8080,
    facts: { platform: 'linux', architecture: 'arm64', node: 'v24.18.0', uid: 1000, gid: 1000, pid: 1 } }) + '\n'),
    stderr: Buffer.alloc(0), closed: false, completion: completion.promise,
    socket: { write(_bytes, callback) { callback(new Error('Native marker acknowledgement transport lost.')); }, destroy() {} },
    async close() { joined = true; stream.closed = true; completion.resolve(); } };
  const engine = {
    async request(method, target, body) {
      requests.push({ method, target, ...(body === undefined ? {} : { body }) });
      if (method === 'POST' && target.startsWith('/containers/create?')) {
        actual = { Id: id, Name: `/${new URL(target, 'http://engine').searchParams.get('name')}`, Image: image,
          Config: body, HostConfig: body.HostConfig, Mounts: [], State: { Running: true },
          NetworkSettings: { Networks: { bridge: structuredClone(defaultEndpoint) } } };
        return { status: 201, data: { Id: id } };
      }
      if (method === 'POST' && target === `/networks/${network}/connect`) {
        assert.deepEqual(body, { Container: id });
        actual.NetworkSettings.Networks.tested = { NetworkID: network, EndpointID: 'f'.repeat(64), IPAddress: '172.18.0.2' };
        return { status: 200 };
      }
      if (method === 'POST' && target === `/networks/${network}/disconnect`) {
        assert.deepEqual(body, { Container: id, Force: false });
        delete actual.NetworkSettings.Networks.tested;
        return { status: 200 };
      }
      if (method === 'GET') return { status: actual ? 200 : 404, data: actual };
      if (method === 'DELETE') { actual = null; stream.closed = true; completion.resolve(); return { status: 204 }; }
      return { status: 204 };
    },
    async hijack() { return stream; },
  };
  const fixtures = await createFixtures({ engine, config: { output, guestNodeVersion: '24.18.0', fixtureOwner: '12345678-1234-4123-8123-123456789abc',
    capabilities: { network: { fixtures: { imageDigest: image } }, limits: { requestMs: 1000 } } } });
  const run = { beforeCleanup: [], async observe() {} };
  const foreign = await fixtures.prepareForeign(run);
  await fixtures.foreignMember(run, { owner: { recoveryRecord: { resources: [{ role: 'network', identity: { kind: 'identified', id: network } }] } } }, foreign);
  for (const action of [...run.beforeCleanup].reverse()) await action();
  assert(actual, 'The foreign marker must remain row-owned after temporary endpoint cleanup.');
  assert.equal(actual.State.Running, true);
  assert.deepEqual(actual.NetworkSettings.Networks, { bridge: defaultEndpoint });
  assert.deepEqual(requests.filter(({ method }) => method === 'DELETE'), []);
  assert.deepEqual(requests.filter(({ target }) => target.endsWith('/disconnect')), [
    { method: 'POST', target: `/networks/${network}/disconnect`, body: { Container: id, Force: false } },
  ]);
  await fixtures.close();
  assert.equal(actual, null); assert.equal(joined, true); assert.equal(fixtures.record.closed, true);
  assert.deepEqual(requests.filter(({ method }) => method === 'DELETE'), [{ method: 'DELETE', target: `/containers/${id}?force=true&v=false` }]);
  assert.equal(fixtures.record.resources[0].state, 'removed');
  assert.equal(fixtures.record.resources[0].controlSettlement[0].status, 'rejected');
  assert.match(fixtures.record.resources[0].controlSettlement[0].failure.message, /acknowledgement transport lost/u);
});
