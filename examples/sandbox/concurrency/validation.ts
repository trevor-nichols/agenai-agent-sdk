import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { parseSandboxRequest } from '@agen-ai/sandbox';
import { CONCURRENT_PROTOCOL, maximumNetworkReply, networkCommand } from './protocol.js';
import type { ConcurrentHttpsFixture, ConcurrentWorkflowOptions } from './types.js';

function validateHttps(input: ConcurrentHttpsFixture): void {
  assert(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(input.hostname) && input.hostname.length <= 253);
  assert(Number.isInteger(input.port) && input.port >= 1 && input.port <= 65535);
  assert(/^\/[\u0021-\u007e]*$/u.test(input.path) && input.path.length <= 2048);
  assert(Number.isInteger(input.status) && input.status >= 200 && input.status <= 399);
  assert(Number.isSafeInteger(input.bodyBytes) && input.bodyBytes >= 0 && input.bodyBytes <= 262_144);
  assert(/^[a-f0-9]{64}$/u.test(input.bodySha256));
}

export function validateConcurrentOptions(options: ConcurrentWorkflowOptions): void {
  assert(options.startMode === 'prepare_both' || options.startMode === 'staged_addition');
  assert.deepEqual([...options.removalOrder].sort(), ['a', 'b']);
  assert(Number.isSafeInteger(options.operationTimeoutMs) && options.operationTimeoutMs >= 1000 && options.operationTimeoutMs <= 30_000);
  assert.equal(options.members.length, 2);
  const inputs = [...options.members, options.replacement];
  assert.equal(new Set(inputs.map(({ backend }) => backend)).size, 3, 'Prepare three independent backend instances.');
  assert.equal(new Set(inputs.map(({ destination }) => resolve(destination))).size, 3, 'Exports require independent destinations.');
  for (const input of inputs) {
    validateHttps(input.positive);
    assert(isAbsolute(input.destination));
    assert(Array.isArray(input.forbidden) && input.forbidden.length <= 12);
    for (const forbidden of input.forbidden) {
      assert(/^[a-z0-9.-]{1,253}$/u.test(forbidden.hostname));
      assert.equal(isIP(forbidden.address), 4);
      assert(Number.isInteger(forbidden.port) && forbidden.port >= 1 && forbidden.port <= 65535);
      assert(forbidden.transport === 'tcp' || forbidden.transport === 'udp');
      for (const value of [forbidden.probe, forbidden.marker]) assert(value.length > 0 && Buffer.byteLength(value) <= 4096);
    }
    const request = parseSandboxRequest(input.request);
    assert.equal(request.policy.files.kind, 'read_write');
    assert.equal(request.policy.network.kind, 'restricted_https');
    if (request.policy.network.kind !== 'restricted_https') throw new Error('Explicit restricted HTTPS policy required.');
    assert(request.policy.network.destinations.some(({ hostname, port }) => hostname === input.positive.hostname && port === input.positive.port));
    for (const forbidden of input.forbidden) {
      assert(!request.policy.network.destinations.some(({ hostname, port }) => hostname === forbidden.hostname && port === forbidden.port));
    }
    const peer = input === options.replacement
      ? options.members[options.removalOrder[0] === 'a' ? 1 : 0]
      : input === options.members[1] ? options.members[0] : options.members[1];
    assert(Buffer.byteLength(JSON.stringify({ ...networkCommand(input.positive, peer.positive, input.forbidden), id: CONCURRENT_PROTOCOL.commands }))
      + 1 <= CONCURRENT_PROTOCOL.commandBytes, 'Concurrent network command exceeds the aggregate 16 KiB protocol bound.');
    assert(Buffer.byteLength(JSON.stringify(maximumNetworkReply(input.positive, peer.positive, input.forbidden))) + 1 <= CONCURRENT_PROTOCOL.frameBytes,
      'Concurrent network observation exceeds the aggregate 32 KiB protocol bound.');
    assert(!request.policy.network.destinations.some(({ hostname, port }) => hostname === peer.positive.hostname && port === peer.positive.port),
      'Each member must omit the other member\'s allowed CONNECT destination.');
  }
  assert.equal(options.coordinator.state.kind, 'active', 'Explicitly activate the original coordinator before this workflow.');
}
