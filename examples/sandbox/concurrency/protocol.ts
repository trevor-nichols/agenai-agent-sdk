import type { ConcurrentForbiddenFixture, ConcurrentHttpsFixture } from './types.js';

export const CONCURRENT_PROTOCOL = Object.freeze({
  commandBytes: 16 * 1024,
  frameBytes: 32 * 1024,
  commands: 192,
  diagnosticCodeChars: 64,
  diagnosticMessageChars: 256,
});

export function networkCommand(positive: ConcurrentHttpsFixture, peer: ConcurrentHttpsFixture,
  forbidden: readonly ConcurrentForbiddenFixture[]) {
  return { kind: 'network', positive, denied: { hostname: peer.hostname, port: peer.port }, forbidden };
}

/** Conservative diagnostic strings use the largest JSON encoding of each admitted character. */
export function maximumNetworkReply(positive: ConcurrentHttpsFixture, peer: ConcurrentHttpsFixture,
  forbidden: readonly ConcurrentForbiddenFixture[]) {
  const diagnostic = { code: '\0'.repeat(CONCURRENT_PROTOCOL.diagnosticCodeChars),
    message: '\0'.repeat(CONCURRENT_PROTOCOL.diagnosticMessageChars) };
  return { kind: 'reply', id: CONCURRENT_PROTOCOL.commands, result: {
    fresh: { status: positive.status, bodyBytes: positive.bodyBytes, bodySha256: positive.bodySha256,
      authorized: true, certificateFingerprint256: 'FF:'.repeat(31) + 'FF' },
    denied: { hostname: peer.hostname, port: peer.port, proxyStatus: 403 },
    forbidden: forbidden.map((fixture) => ({ fixture, proxyStatus: 403, direct: fixture.transport === 'tcp'
      ? { kind: 'tcp', connected: false, ...diagnostic } : { kind: 'udp', received: false, ...diagnostic } })),
  } };
}
