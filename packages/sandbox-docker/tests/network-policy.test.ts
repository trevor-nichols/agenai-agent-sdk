// ------------------------------------------------------------------------------------------------
//                network-policy.test.ts - Wire admission and independently meaningful denied coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { addressAdmission, deniedCoverage, parseConnect } from '../src/network/policy.js';
import { parseRouteCensus } from '../src/network/census.js';
import { EGRESS_PROTOCOL, parseEgressHelperConfiguration } from '../src/helpers/protocol.js';

const destinations = [{ hostname: 'example.com', port: 443 }];
const connect = (authority: string, fields = '') => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${fields}\r\n`;

test('helper wire admits the exact DNS endpoint and rejects HTTP/authority escape routes', () => {
  assert.deepEqual(parseConnect(connect('example.com:443'), destinations), { hostname: 'example.com', port: 443 });
  for (const authority of ['example.com:444', 'example.com.:443', 'xn--example.com:443', 'EXAMPLE.com:443', '2130706433:443',
    '127.1:443', '0177.0.0.1:443', '0x7f000001:443', '[::ffff:127.0.0.1]:443', 'user@example.com:443', 'example.com:0443', 'example.com:443/path']) {
    assert.throws(() => parseConnect(connect(authority), destinations), TypeError);
  }
  for (const fields of ['Host: example.com:443\r\n', 'Content-Length: 1\r\n', 'Transfer-Encoding: chunked\r\n', `X: ${'a'.repeat(8192)}\r\n`]) {
    assert.throws(() => parseConnect(connect('example.com:443', fields), destinations), TypeError);
  }
});

test('a Host without the default HTTPS port is admitted only for port 443 and never selects another destination', () => {
  const wire = (authority: string, host: string) => `CONNECT ${authority} HTTP/1.1\r\nhost: ${host}\r\nconnection: keep-alive\r\n\r\n`;
  const both = [...destinations, { hostname: 'example.com', port: 8443 }];
  assert.deepEqual(parseConnect(wire('example.com:443', 'example.com'), both), { hostname: 'example.com', port: 443 });
  for (const [authority, host] of [['example.com:8443', 'example.com'], ['example.com:443', 'other.example'], ['example.com:443', 'EXAMPLE.com'],
    ['example.com:443', 'example.com:8443'], ['example.com:443', 'example.com.']]) {
    assert.throws(() => parseConnect(wire(authority, host), both), TypeError);
  }
});

test('effective denied coverage ignores private bridge additions but changes for public local/VPN routes', () => {
  const before = parseRouteCensus([{ dst: '192.168.1.0/24', gateway: '192.168.1.1' }], [{ dst: 'fe80::/64' }], []);
  const privateBridge = parseRouteCensus([{ dst: '192.168.1.0/24', gateway: '192.168.1.1' }, { dst: '172.21.0.0/16' }],
    [{ dst: 'fe80::/64' }, { dst: 'fe80::1234' }], [{ addr_info: [{ family: 'inet', local: '172.21.0.1', prefixlen: 16 }] }]);
  assert.deepEqual(privateBridge, before);
  const changed = deniedCoverage([...before, '11.230.251.2/32', '2606:4700:1234::/48']);
  assert.notDeepEqual(changed, before);
  const permitted = addressAdmission(changed);
  assert.equal(permitted('104.20.23.154'), true);
  assert.equal(permitted('2606:4700:10::1'), true);
  for (const address of ['11.230.251.2', '2606:4700:1234::1', '10.0.0.1', '100.115.145.9', '127.0.0.1', '169.254.169.254',
    '172.18.0.1', '192.168.1.56', '2001:db8::1', '3fff::1', '::1', 'fd12::1', 'fe80::1234', '::ffff:104.20.23.154']) {
    assert.equal(permitted(address), false, address);
  }
});

test('helper configuration has one closed immutable role and cannot smuggle extra authority', () => {
  const parsed = parseEgressHelperConfiguration({ protocol: EGRESS_PROTOCOL, role: 'broker', destinations, excludedCidrs: ['11.230.251.0/24'], leaseTimeoutMs: 1000 });
  assert.equal(parsed.role, 'broker');
  if (parsed.role !== 'broker') throw new Error('Expected broker configuration.');
  assert.deepEqual(parsed.destinations, [{ hostname: 'example.com', port: 443 }]);
  assert.equal(addressAdmission(parsed.excludedCidrs)('11.230.251.2'), false);
  for (const extra of [{ admin: true }, { destinations: [...destinations, ...destinations] }, { excludedCidrs: ['invalid/32'] }]) {
    assert.throws(() => parseEgressHelperConfiguration({ protocol: EGRESS_PROTOCOL, role: 'broker', destinations, excludedCidrs: [], leaseTimeoutMs: 1000, ...extra }), TypeError);
  }
  assert.throws(() => parseEgressHelperConfiguration({ protocol: EGRESS_PROTOCOL, role: 'relay', leaseTimeoutMs: 1000, destinations }), TypeError);
});
