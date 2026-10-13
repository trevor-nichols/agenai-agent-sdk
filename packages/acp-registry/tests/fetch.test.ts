import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';

import { AcpRegistryValidationError } from '../src/shared/errors.js';
import { AcpRegistryFetchError, fetchAcpRegistrySnapshot, type AcpRegistryFetchErrorCode } from '../src/node/index.js';
import type { AcpRegistrySource } from '../src/catalog/contracts.js';

const content = '{"version":"1.0.0","agents":[],"extensions":[]}\n';
const source = (location: string): AcpRegistrySource => ({ namespace: 'fixture', kind: 'remote', channel: 'stable', profile: 'published-v1', location });
const hasCode = (code: AcpRegistryFetchErrorCode) => (error: unknown) => error instanceof AcpRegistryFetchError && error.code === code;

async function server(t: TestContext, handler: RequestListener): Promise<string> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('explicitly trusted redirects preserve original source identity and exact accepted bytes', async (t) => {
  const requests: { url: string | undefined; authorization: string | undefined; cookie: string | undefined }[] = [];
  const destination = await server(t, (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
    response.end(content);
  });
  const origin = await server(t, (_request, response) => {
    response.writeHead(302, { location: `${destination}/catalog` });
    response.end();
  });
  const result = await fetchAcpRegistrySnapshot({ source: source(`${origin}/initial`), trustedOrigins: [origin, destination], allowInsecureHttp: true });
  assert.equal(result.content, content);
  assert.equal(result.snapshot.rawDigest, `sha256:${createHash('sha256').update(content).digest('hex')}`);
  assert.equal(result.snapshot.source.location, `${origin}/initial`);
  assert.equal(result.finalUrl, `${destination}/catalog`);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.deepEqual(requests, [{ url: '/catalog', authorization: undefined, cookie: undefined }]);
  assert.ok(Object.isFrozen(result));
});

test('transport and origin policy reject requests before contacting unapproved endpoints', async (t) => {
  let destinationRequests = 0;
  const destination = await server(t, (_request, response) => { destinationRequests += 1; response.end(content); });
  const origin = await server(t, (_request, response) => {
    response.writeHead(302, { location: `${destination}/catalog` });
    response.end();
  });
  await assert.rejects(fetchAcpRegistrySnapshot({ source: source(destination), trustedOrigins: [destination] }), hasCode('insecure_transport'));
  await assert.rejects(fetchAcpRegistrySnapshot({ source: source(destination), trustedOrigins: [origin], allowInsecureHttp: true }), hasCode('untrusted_origin'));
  await assert.rejects(fetchAcpRegistrySnapshot({ source: source(origin), trustedOrigins: [origin], allowInsecureHttp: true }), hasCode('untrusted_origin'));
  await assert.rejects(fetchAcpRegistrySnapshot({ source: source(origin), trustedOrigins: [origin, destination], allowInsecureHttp: true, maxRedirects: 0 }), hasCode('redirect_limit'));
  assert.equal(destinationRequests, 0);
});

test('response handling bounds declared and streamed bytes and preserves parse failures', async (t) => {
  const origin = await server(t, (request, response) => {
    switch (request.url) {
      case '/declared': response.writeHead(200, { 'content-length': '1000' }); response.end('x'); break;
      case '/streamed': response.write('x'.repeat(40)); response.end('y'.repeat(40)); break;
      case '/compressed': {
        const body = gzipSync('x'.repeat(1000));
        response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.byteLength });
        response.end(body);
        break;
      }
      case '/utf8': response.end(Buffer.from([0xc0, 0xaf])); break;
      case '/status': response.writeHead(503); response.end('private upstream diagnostic'); break;
      case '/json': response.end('{invalid'); break;
      case '/redirect': response.writeHead(302, { location: 'https://user:secret@example.test/catalog' }); response.end(); break;
      default: response.end(content);
    }
  });
  const input = { trustedOrigins: [origin], allowInsecureHttp: true, limits: { maxSnapshotBytes: 64 } };
  for (const path of ['declared', 'streamed', 'compressed']) {
    await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: source(`${origin}/${path}`) }), hasCode('response_too_large'));
  }
  await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: source(`${origin}/utf8`) }), hasCode('invalid_utf8'));
  await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: source(`${origin}/status`) }), (error: unknown) => {
    assert.ok(error instanceof AcpRegistryFetchError);
    assert.equal(error.code, 'http_status');
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /private upstream/u);
    return true;
  });
  await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: source(`${origin}/json`) }), AcpRegistryValidationError);
  await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: source(`${origin}/redirect`) }), hasCode('invalid_redirect'));
});

test('cancellation and total deadlines terminate an incomplete response without returning a snapshot', async (t) => {
  const cancellation = new AbortController();
  let requests = 0;
  const origin = await server(t, (request, response) => {
    requests += 1;
    response.write('{');
    if (request.url === '/cancel') cancellation.abort();
  });
  const input = { trustedOrigins: [origin], allowInsecureHttp: true };
  const alreadyCanceled = AbortSignal.abort();
  await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: source(origin), signal: alreadyCanceled }), hasCode('aborted'));
  assert.equal(requests, 0);
  await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: source(`${origin}/cancel`), signal: cancellation.signal }), hasCode('aborted'));
  await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: source(`${origin}/timeout`), timeoutMs: 100 }), hasCode('timeout'));
  assert.equal(requests, 2);
});

test('invalid fetch configuration and local sources fail before network admission', async (t) => {
  let requests = 0;
  const origin = await server(t, (_request, response) => { requests += 1; response.end(content); });
  const input = { source: source(origin), trustedOrigins: [origin], allowInsecureHttp: true };
  for (const change of [{ trustedOrigins: [] }, { trustedOrigins: [`${origin}/`] }, { timeoutMs: 0 }, { maxRedirects: 9 }]) {
    await assert.rejects(fetchAcpRegistrySnapshot({ ...input, ...change }), hasCode('invalid_fetch_policy'));
  }
  await assert.rejects(fetchAcpRegistrySnapshot({ ...input, source: { ...input.source, kind: 'local', location: 'fixture.json' } }), hasCode('invalid_fetch_policy'));
  assert.equal(requests, 0);
});

test('fetch policy uses the same captured transport decision for validation and network admission', async (t) => {
  let requests = 0;
  const origin = await server(t, (_request, response) => { requests += 1; response.end(content); });
  let observations = 0;
  const input = {
    source: source(origin), trustedOrigins: [origin],
    get allowInsecureHttp() { observations += 1; return observations > 2; },
  };
  await assert.rejects(fetchAcpRegistrySnapshot(input), hasCode('insecure_transport'));
  assert.equal(requests, 0);
});
