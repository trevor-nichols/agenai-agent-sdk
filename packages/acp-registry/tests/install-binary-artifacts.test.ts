import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { open, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquireArtifact } from '../src/node/install/artifacts/acquire.js';
import { AcpInstallationError } from '../src/node/install/errors.js';
import type { AcpInstallPreparationContext } from '../src/node/install/internal.js';
import { binaryContext, digestBytes, fixturePath } from './fixtures/install-binary/index.js';

const installationError = (code: AcpInstallationError['code']) => (error: unknown) => error instanceof AcpInstallationError && error.code === code;

async function fixtureServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture server address.');
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}

function networkContext(context: AcpInstallPreparationContext, allowedOrigins: readonly string[], overrides: Partial<AcpInstallPreparationContext> = {}): AcpInstallPreparationContext {
  return { ...context, ...overrides, localArtifacts: [], plan: { ...context.plan,
    policy: { ...context.plan.policy, network: 'allow', allowInsecureHttp: true, allowedOrigins } } };
}

test('local acquisition binds exact caller URL or expected digest and never treats registry paths as local authority', async () => {
  const fixture = await binaryContext();
  try {
    const { context } = fixture;
    const url = context.plan.distribution.kind === 'binary' ? context.plan.distribution.archive : '';
    const expectedSha256 = context.plan.expectedIntegrity.sha256!;
    const artifact = await acquireArtifact({ url, expectedSha256, context: { ...context,
      localArtifacts: [{ path: fixturePath('valid.tar.gz'), sha256: expectedSha256 }] } });
    assert.equal(artifact.origin, 'local');
    assert.equal(artifact.measuredSha256, expectedSha256);
    assert.equal(artifact.expectedSha256, expectedSha256);
    assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
    await assert.rejects(acquireArtifact({ url: `${url}?other`, expectedSha256, context }), installationError('artifact_unavailable'));
    await assert.rejects(acquireArtifact({ url: 'file:///tmp/catalog-is-not-authority', expectedSha256, context }), installationError('invalid_input'));
    await assert.rejects(acquireArtifact({ url, expectedSha256, context: { ...context, localArtifacts: [context.localArtifacts[0]!, context.localArtifacts[0]!] } }), installationError('invalid_input'));
  } finally { await fixture.cleanup(); }
});

test('local artifact symlinks are refused and aggregate budgets retain earlier owned artifacts', async () => {
  const fixture = await binaryContext();
  try {
    const { context } = fixture;
    const source = context.localArtifacts[0]!;
    const alias = join(context.workRoot, 'alias');
    await symlink(source.path, alias);
    await assert.rejects(acquireArtifact({ url: source.url!, context: { ...context, localArtifacts: [{ ...source, path: alias }] } }), installationError('io_failure'));
    const size = (await stat(source.path)).size;
    const bounded = { ...context, limits: { ...context.limits, maxTotalArtifactBytes: size * 2 - 1 } };
    const first = await acquireArtifact({ url: source.url!, context: bounded });
    await assert.rejects(acquireArtifact({ url: source.url!, context: bounded }), installationError('limit_exceeded'));
    assert.deepEqual(await readFile(first.path), await readFile(source.path));
    assert.equal((await readdir(context.workRoot)).filter((name) => name.startsWith('artifact-')).length, 1);
  } finally { await fixture.cleanup(); }
});

test('a caller-supplied FIFO fails without waiting for a writer', { skip: process.platform === 'win32' }, async () => {
  const fixture = await binaryContext();
  const fifo = join(fixture.context.workRoot, 'caller-fifo');
  execFileSync('/usr/bin/mkfifo', [fifo]);
  const source = fixture.context.localArtifacts[0]!;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const pending = acquireArtifact({ url: source.url!, context: { ...fixture.context, localArtifacts: [{ ...source, path: fifo }] } });
  const observed = pending.then(() => undefined, (error: unknown) => error);
  try {
    const result = await Promise.race([observed, new Promise<Error>((resolve) => {
      deadline = setTimeout(() => { timedOut = true; resolve(new Error('Artifact FIFO waited for a writer.')); }, 100);
    })]);
    assert.equal(installationError('invalid_input')(result), true);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (timedOut) { const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK); await writer.close(); }
    await observed;
    await fixture.cleanup();
  }
});

test('HTTP acquisition checks each redirect origin, records measured bytes, and sends no credentials', async () => {
  const bytes = await readFile(fixturePath('valid.tar.gz'));
  const seen: IncomingMessage['headers'][] = [];
  let forbiddenRequests = 0;
  const forbidden = await fixtureServer((_request, response) => { forbiddenRequests += 1; response.end(bytes); });
  const server = await fixtureServer((request, response) => {
    seen.push(request.headers);
    if (request.url === '/redirect') { response.writeHead(302, { location: '/archive' }); response.end(); }
    else if (request.url === '/forbidden') { response.writeHead(302, { location: `${forbidden.origin}/archive` }); response.end(); }
    else { response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes); }
  });
  const fixture = await binaryContext();
  try {
    const context = networkContext(fixture.context, [server.origin]);
    const result = await acquireArtifact({ url: `${server.origin}/redirect`, expectedSha256: digestBytes(bytes), context });
    assert.equal(result.sourceUrl, `${server.origin}/redirect`);
    assert.equal(result.finalUrl, `${server.origin}/archive`);
    assert.equal(result.origin, 'network');
    assert.equal(result.sizeBytes, bytes.length);
    assert.deepEqual(await readFile(result.path), bytes);
    await assert.rejects(acquireArtifact({ url: `${server.origin}/forbidden`, context }), installationError('policy_denied'));
    assert.equal(forbiddenRequests, 0);
    assert.equal(seen.length, 3);
    assert.equal(seen.some((headers) => headers.authorization !== undefined || headers.cookie !== undefined), false);
    await assert.rejects(acquireArtifact({ url: `${server.origin}/archive`, context: { ...context,
      plan: { ...context.plan, policy: { ...context.plan.policy, allowInsecureHttp: false } } } }), installationError('policy_denied'));
    assert.equal(seen.length, 3);
  } finally { await fixture.cleanup(); await server.close(); await forbidden.close(); }
});

test('streamed and declared HTTP byte limits, bad checksums, and redirect loops clean only their own partial artifacts', async () => {
  const bytes = await readFile(fixturePath('valid.tar.gz'));
  const server = await fixtureServer((request, response) => {
    if (request.url === '/declared') { response.writeHead(200, { 'content-length': bytes.length * 100 }); response.end(); }
    else if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); }
    else { response.writeHead(200); response.write(bytes); response.end(bytes); }
  });
  const fixture = await binaryContext();
  try {
    const context = networkContext(fixture.context, [server.origin], { limits: { ...fixture.context.limits, maxArtifactBytes: bytes.length } });
    for (const path of ['/declared', '/streamed', '/loop']) {
      await assert.rejects(acquireArtifact({ url: `${server.origin}${path}`, context }), installationError('limit_exceeded'));
      assert.deepEqual(await readdir(context.workRoot), []);
    }
    const larger = { ...context, limits: { ...context.limits, maxArtifactBytes: bytes.length * 2 } };
    await assert.rejects(acquireArtifact({ url: `${server.origin}/checksum`, expectedSha256: `sha256:${'0'.repeat(64)}`, context: larger }), installationError('integrity_mismatch'));
    assert.deepEqual(await readdir(context.workRoot), []);
  } finally { await fixture.cleanup(); await server.close(); }
});

test('canceling an active download and its referenced deadline both release every pending body and partial file', async () => {
  let reached: (() => void) | undefined;
  const server = await fixtureServer((_request, response) => { response.writeHead(200); response.write('partial'); reached?.(); });
  const fixture = await binaryContext();
  try {
    const abort = new AbortController();
    const context = networkContext(fixture.context, [server.origin], { signal: abort.signal });
    const admitted = new Promise<void>((resolve) => { reached = resolve; });
    const pending = acquireArtifact({ url: `${server.origin}/cancel`, context });
    await admitted;
    abort.abort(new Error('Caller cancellation.'));
    await assert.rejects(pending, installationError('aborted'));
    assert.deepEqual(await readdir(context.workRoot), []);
    reached = undefined;
    await assert.rejects(acquireArtifact({ url: `${server.origin}/timeout`, context: { ...context, signal: undefined,
      limits: { ...context.limits, artifactTimeoutMs: 25 } } }), installationError('timeout'));
    assert.deepEqual(await readdir(context.workRoot), []);
  } finally { await fixture.cleanup(); await server.close(); }
});
