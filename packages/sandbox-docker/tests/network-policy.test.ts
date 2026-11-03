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
const userAgent = 'User-Agent: ExampleClient/2.3 libsample/4.5 (system; architecture; +https://client.example)\r\n';

test('helper wire admits the exact DNS endpoint and rejects HTTP/authority escape routes', () => {
  assert.deepEqual(parseConnect(connect('example.com:443'), destinations), { hostname: 'example.com', port: 443 });
  for (const authority of ['example.com:444', 'example.com.:443', 'xn--example.com:443', 'EXAMPLE.com:443', '2130706433:443',
    '127.1:443', '0177.0.0.1:443', '0x7f000001:443', '[::ffff:127.0.0.1]:443', 'user@example.com:443', 'example.com:0443', 'example.com:443/path']) {
    assert.throws(() => parseConnect(connect(authority, userAgent), destinations), TypeError);
  }
  for (const fields of ['hOsT: example.com:443\r\n', 'Content-Length: 0\r\n', 'Content-Length: 1\r\n', 'Transfer-Encoding: chunked\r\n',
    'Authorization: Basic synthetic\r\n', 'Proxy-Authorization: Basic synthetic\r\n', 'X-Trace: ignored\r\n',
    'Connection: upgrade\r\n', 'Connection: close, keep-alive\r\n', 'Connection:  close\r\n', 'Proxy-Connection: keep-alive \r\n',
    'Connection: close\r\ncOnNeCtIoN: keep-alive\r\n', 'Proxy-Connection: close\r\nproxy-connection: close\r\n']) {
    assert.throws(() => parseConnect(connect('example.com:443', userAgent + fields), destinations), TypeError, JSON.stringify(fields));
  }
});

test('CONNECT admits the captured native User-Agent without changing its destination', () => {
  const wire = 'CONNECT cli-chat-proxy.grok.com:443 HTTP/1.1\r\n'
    + 'Host: cli-chat-proxy.grok.com:443\r\n'
    + 'user-agent: grok-shell/1.0.70 (linux; aarch64)\r\n'
    + '\r\n';
  assert.deepEqual(parseConnect(wire, [{ hostname: 'cli-chat-proxy.grok.com', port: 443 }]),
    { hostname: 'cli-chat-proxy.grok.com', port: 443 });
});

test('CONNECT admits generic User-Agent metadata with field casing, punctuation and surrounding spaces', () => {
  for (const fields of [userAgent,
    'uSeR-aGeNt:  OtherClient/9.8 (different system; +https://other.example) \r\nConnection: ClOsE\r\nProxy-Connection: KeEp-AlIvE\r\n']) {
    assert.deepEqual(parseConnect(connect('example.com:443', fields), destinations), { hostname: 'example.com', port: 443 });
  }
});

test('CONNECT rejects empty, duplicate and malformed User-Agent fields', () => {
  for (const fields of ['User-Agent:\r\n', 'User-Agent: \r\n', 'User-Agent:    \r\n',
    'User-Agent: Example/1\r\nuSeR-aGeNt: Other/2\r\n', 'User-Agent : Example/1\r\n', 'User-Agent:Example/1\r\n',
    'User-Agent:\tExample/1\r\n', 'User-Agent: Example\rname\r\n', 'User-Agent: Example\nname\r\n',
    'User-Agent: Example/1\r\n continued\r\n', 'User-Agent: Example/1\r\n\tcontinued\r\n',
    'User-Agent: Example\u0000\r\n', 'User-Agent: Example\u007f\r\n', 'User-Agent: Example\u0080\r\n', 'User-Agent: Exämple/1\r\n']) {
    assert.throws(() => parseConnect(connect('example.com:443', fields), destinations), TypeError, JSON.stringify(fields));
  }
});

test('CONNECT metadata does not relax the method, version, Host requirement or CRLF framing', () => {
  const wire = connect('example.com:443', userAgent);
  assert.deepEqual(parseConnect(wire.replace('HTTP/1.1', 'HTTP/1.0'), destinations), { hostname: 'example.com', port: 443 });
  for (const invalid of [wire.replace('CONNECT ', 'GET '), wire.replace('HTTP/1.1', 'HTTP/2.0'),
    wire.replace('Host: example.com:443\r\n', ''), wire.replaceAll('\r\n', '\n'), wire.slice(0, -2), `\r\n${wire}`,
    wire.replace('Host: example.com:443\r\n', 'Host: example.com:443\r\n\r\n')]) {
    assert.throws(() => parseConnect(invalid, destinations), TypeError, JSON.stringify(invalid));
  }
});

test('CONNECT User-Agent shares the inclusive 8192-byte whole-header budget', () => {
  const prefix = 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nUser-Agent: ';
  const suffix = '\r\n\r\n';
  const value = 'a'.repeat(8192 - Buffer.byteLength(prefix + suffix));
  assert.deepEqual(parseConnect(prefix + value + suffix, destinations), { hostname: 'example.com', port: 443 });
  assert.throws(() => parseConnect(prefix + value + 'a' + suffix, destinations), TypeError);
});

test('a Host without the default HTTPS port is admitted only for port 443 and never selects another destination', () => {
  const wire = (authority: string, host: string) => `CONNECT ${authority} HTTP/1.1\r\n${userAgent}host: ${host}\r\nconnection: keep-alive\r\n\r\n`;
  const both = [...destinations, { hostname: 'example.com', port: 8443 }];
  assert.deepEqual(parseConnect(wire('example.com:443', 'example.com'), both), { hostname: 'example.com', port: 443 });
  assert.deepEqual(parseConnect(wire('example.com:8443', 'example.com:8443'), both), { hostname: 'example.com', port: 8443 });
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
