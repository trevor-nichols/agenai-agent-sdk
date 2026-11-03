import assert from 'node:assert/strict';
import { denied, destinations, restricted } from './connectivity.mjs';
import { positive } from './installed.mjs';

const capturedHostname = 'cli-chat-proxy.grok.com';
const capturedUserAgent = 'grok-shell/1.0.70 (linux; aarch64)';
export const capturedConnectHeader = `CONNECT ${capturedHostname}:443 HTTP/1.1\r\nHost: ${capturedHostname}:443\r\nuser-agent: ${capturedUserAgent}\r\n\r\n`;
const genericUserAgent = 'ExampleClient/2.3 libsample/4.5 (system; architecture; +https://client.example)';
const metadataHeader = (hostname, agent = capturedUserAgent, host = `${hostname}:443`) =>
  `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${agent}\r\n\r\n`;

async function expectConnect(run, opened, wire, status, label) {
  const response = await opened.session.request({ kind: 'proxy', header: wire });
  await run.observe({ kind: 'connect-compatibility-wire', label, header: wire, headerBytes: Buffer.byteLength(wire), expectedStatus: status, response });
  assert.equal(response.ok, true, JSON.stringify(response)); assert.equal(response.result.status, status);
}

export function compatibilityCases(context, selection) {
  return [
    ['captured-native-connect-header', async (run) => {
      const admitted = destinations(context).filter(({ hostname }) => hostname !== capturedHostname);
      const opened = await restricted(run, context, { destinations: [...admitted, { hostname: capturedHostname, port: 443 }] });
      await expectConnect(run, opened, capturedConnectHeader, selection.capturedConnectStatus,
        selection.kind === 'legacy-connect-baseline' ? 'old-helper-exact-capture-rejection' : 'candidate-exact-capture-admission');
    }],
    ['connect-user-agent-clients-and-tls', async (run) => {
      const opened = await restricted(run, context); const expected = context.config.capabilities.network.positive;
      for (const [label, wire] of [
        ['generic-client-metadata', metadataHeader(expected.hostname, genericUserAgent)],
        ['default-443-host-with-captured-user-agent', metadataHeader(expected.hostname, capturedUserAgent, expected.hostname)],
        ['case-varied-field-and-surrounding-spaces', metadataHeader(expected.hostname, ` ${genericUserAgent} `).replace('User-Agent:', 'uSeR-aGeNt:')],
      ]) await expectConnect(run, opened, wire, 200, label);
      const node = await opened.session.request({ kind: 'node-connect', hostname: expected.hostname, port: 443, userAgent: genericUserAgent });
      await run.observe({ kind: 'node-http-connect-default-port-host', response: node });
      assert.equal(node.ok, true, JSON.stringify(node)); assert.deepEqual(node.result, { status: 200, closed: true });
      const proxyHeader = metadataHeader(expected.hostname);
      await run.observe({ kind: 'captured-user-agent-verified-tls-exact-body', proxyHeader,
        result: await positive(opened, context, proxyHeader) });
    }],
    ['connect-user-agent-denials-and-bounds', async (run) => {
      const opened = await restricted(run, context); const hostname = context.config.capabilities.network.positive.hostname;
      const admitted = metadataHeader(hostname);
      const beforeEnd = (fields) => admitted.slice(0, -2) + fields + '\r\n';
      for (const [label, wire] of [
        ['unlisted-target', metadataHeader('unlisted.invalid')],
        ['wrong-host', metadataHeader(hostname, capturedUserAgent, 'unlisted.invalid:443')],
        ['duplicate-user-agent', beforeEnd('uSeR-aGeNt: OtherClient/1\r\n')],
        ['proxy-credentials', beforeEnd('Proxy-Authorization: Basic synthetic\r\n')],
        ['origin-credentials', beforeEnd('Authorization: Basic synthetic\r\n')],
        ['content-length', beforeEnd('Content-Length: 0\r\n')],
        ['transfer-encoding', beforeEnd('Transfer-Encoding: chunked\r\n')],
        ['folded-field', beforeEnd(' continued\r\n')],
        ['bare-lf-framing', admitted.replaceAll('\r\n', '\n') + '\r\n\r\n'],
        ['empty-user-agent', metadataHeader(hostname, ' ')],
      ]) await denied(run, context, opened, { scope: 'CONNECT metadata remains inert', label }, { kind: 'proxy', header: wire }, 403);
      const prefix = `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nUser-Agent: `;
      const suffix = '\r\n\r\n'; const value = 'a'.repeat(8192 - Buffer.byteLength(prefix + suffix));
      await expectConnect(run, opened, prefix + value + suffix, 200, 'inclusive-8192-byte-header');
      await denied(run, context, opened, { scope: 'Whole-header intake bound', headerBytes: 8193 },
        { kind: 'proxy', header: prefix + value + 'a' + suffix }, 431);
    }],
  ];
}
