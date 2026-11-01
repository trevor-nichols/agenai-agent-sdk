import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConcurrencyEvidence, createPhaseCollector, createConcurrencyCapture } from './evidence.mjs';
import { concurrencyScenarioBudget } from './budget.mjs';
import { capabilityManifest, platformManifest } from '../test-fixtures.mjs';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';

async function setup(t, requiredPhases = ['before', 'after'], maximumObservations = 128, prepare, onFailure) {
  const parent = await mkdtemp(join(tmpdir(), 'concurrency-capture-')), directory = join(parent, 'attempt');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const evidence = new ConcurrencyEvidence(directory, 16 * 1024 ** 2); await evidence.initialize('{}');
  await prepare?.(directory);
  const budget = { maximumPhases: 8, maximumObservations: 5 * maximumObservations, maximumEngineResponses: maximumObservations,
    maximumEngineTerminals: 2 * maximumObservations,
    maximumVmFrames: maximumObservations, maximumVmControlFrames: maximumObservations, maximumObserverAttachments: 4,
    maximumNativeWireBytes: maximumObservations * (65_536 + 4104), maximumObservationMetadataBytes: 16 * 1024,
    maximumObservationIndexBytes: 5 * maximumObservations * 16 * 1024, maximumPhaseIndexBytes: 2 * 1024 ** 2,
    proxy: { maxActiveRequests: 16, maxRequestLifecycles: 16 }, networkTopology: { maximumNetworks: 8 } };
  const collector = createPhaseCollector({ evidence, budget, responseBytes: 65_536, requiredPhases, onFailure });
  const id = 'a'.repeat(64);
  const capture = createConcurrencyCapture({ collector, budget, observerIds: new Map([[id, { label: 'a' }]]), maxResponseBytes: 65_536 });
  return { directory, evidence, collector, capture, id };
}

async function phaseCapture(result) {
  const report = JSON.parse(await readFile(result.index.path, 'utf8'));
  assert.equal(report.format, 'agenai.sandbox-concurrency-phase-capture.v6');
  const bytes = await readFile(report.observationIndex.path, 'utf8');
  return { ...report, observations: bytes.trim() ? bytes.trim().split('\n').map(JSON.parse) : [] };
}

test('an original queued GET cancelled before dispatch retains its exact local terminal without earning Engine-body phase coverage', { timeout: 5000 }, async (t) => {
  const { directory, evidence, collector, capture } = await setup(t, ['active', 'queued', 'cleanup']);
  const bodyCaptured = Promise.withResolvers(), bodyRelease = Promise.withResolvers(), queued = Promise.withResolvers(), cancelled = Promise.withResolvers();
  const forwarded = [], upstreamPath = join(directory, 'u.sock'), tracePath = join(directory, 'queue-trace.jsonl');
  const server = http.createServer((request, response) => {
    forwarded.push(request.url); const bytes = Buffer.from(JSON.stringify({ target: request.url, original: true }));
    response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes);
  });
  server.listen(upstreamPath); await once(server, 'listening');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'p.sock'), upstreamEndpoint: `unix://${upstreamPath}`, tracePath,
    maxConnections: 4, maxActiveRequests: 1, maxPendingRequests: 1,
    observeRequest(value) { capture.observeRequest(value); if (value.target === '/queued') queued.resolve(); },
    observeResponseBody(value) {
      const owner = capture.observeResponseBody(value); if (!owner) return;
      return { body: owner.body, async complete(result) {
        await owner.complete(result);
        if (value.target === '/active') { bodyCaptured.resolve(); await bodyRelease.promise; }
      } };
    },
    async observeRequestSettled(receipt) {
      await capture.observeRequestSettled(receipt);
      if (JSON.parse(receipt.bytes).target === '/queued') cancelled.resolve();
    },
  });
  t.after(async () => { await proxy.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const get = (path) => {
    const request = http.request({ socketPath: proxy.endpoint.slice(7), method: 'GET', path, agent: false });
    const response = new Promise((resolve, reject) => {
      request.once('error', reject); request.once('response', async (incoming) => {
        try { const chunks = []; for await (const bytes of incoming) chunks.push(bytes); resolve(Buffer.concat(chunks)); } catch (error) { reject(error); }
      });
    });
    request.end(); return { request, response };
  };
  try {
    await collector.phase('active', { captureRequired: true });
    assert.deepEqual(JSON.parse(await get('/active').response), { target: '/active', original: true }); await bodyCaptured.promise;
    await collector.phase('queued', { captureRequired: true });
    const pending = get('/queued'); void pending.response.catch(() => {}); await queued.promise;
    pending.request.destroy(); await assert.rejects(pending.response); await cancelled.promise;
    await collector.phase('cleanup', { captureRequired: true, originalCleanup: { path: '/original/settled.json' } });
    bodyRelease.resolve(); assert.deepEqual(JSON.parse(await get('/cleanup').response), { target: '/cleanup', original: true });
    await proxy.idle(); await proxy.close();
    const captured = await capture.close(), result = await phaseCapture(await collector.close()); await evidence.close();
    assert.equal(captured.completeness, 'complete'); assert.equal(captured.notForwardedRequests, 1); assert.equal(captured.responseAbsent, 0);
    assert.equal(captured.enteredRequests, 3); assert.equal(captured.terminalRequests, 3);
    assert.equal(result.completeness, 'incomplete'); assert.deepEqual(result.uncovered, [{ sequence: 2, name: 'queued' }]);
    assert.deepEqual(forwarded, ['/active', '/cleanup']);
    const terminal = result.observations.find(({ identity }) => identity.outcome === 'not_forwarded');
    assert.equal(terminal.phaseName, 'queued'); assert.equal(terminal.failure, null); assert.equal(terminal.identity.body, null);
    assert.equal(terminal.identity.requestFailure.name, 'QualificationPreDispatchCancellation');
    const bytes = await readFile(terminal.original.path), originalTrace = await readFile(tracePath), reference = terminal.identity.trace;
    assert.deepEqual(bytes, originalTrace.subarray(reference.offset, reference.offset + reference.bytes));
    assert.equal(reference.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(JSON.parse(bytes).terminal, { kind: 'http_not_forwarded', upstreamAcquisition: 'not_entered', downstreamResponseClosed: true, reason: 'downstream_closed' });
    assert.equal(proxy.capacity().pendingRequests.current, 0); assert.equal(proxy.capacity().pendingRequests.retiring, 0);
  } finally { bodyRelease.resolve(); }
});

for (const { requireBody, hook } of [
  { requireBody: false, hook: 'original' }, { requireBody: true, hook: 'original' },
  { requireBody: false, hook: 'missing' }, { requireBody: false, hook: 'inconsistent' },
]) test(`a joined no-response GET cancellation ${hook === 'original' ? requireBody ? 'cannot cover a required Engine-body phase' : 'settles capture before exact cleanup forwarding' : `with a ${hook} terminal remains incomplete`}`, async (t) => {
  const { directory, evidence, collector, capture } = await setup(t, ['before', 'during', 'cleanup']);
  const socketPath = join(directory, 'u.sock'), entered = Promise.withResolvers(), peerClosed = Promise.withResolvers();
  const forwarded = [];
  const server = http.createServer((request, response) => {
    forwarded.push(request.url);
    if (request.url === '/v1.52/containers/held-relay/json') {
      request.socket.once('close', () => peerClosed.resolve()); entered.resolve(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ target: request.url, original: true }));
  });
  server.listen(socketPath); await once(server, 'listening');
  const tracePath = join(directory, 'terminal-trace.jsonl');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'p.sock'), upstreamEndpoint: `unix://${socketPath}`,
    tracePath, observeRequest: capture.observeRequest, observeResponseBody: capture.observeResponseBody,
    observeRequestSettled: hook === 'missing' ? undefined : hook === 'inconsistent' ? (receipt) => {
      const record = JSON.parse(receipt.bytes);
      return capture.observeRequestSettled(record.target === '/v1.52/containers/held-relay/json'
        ? { ...receipt, original: { ...receipt.original, sha256: 'f'.repeat(64) } } : receipt);
    } : capture.observeRequestSettled });
  t.after(async () => { await proxy.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const get = (path) => {
    const request = http.request({ socketPath: proxy.endpoint.slice(7), method: 'GET', path, agent: false });
    const response = new Promise((resolve, reject) => {
      request.once('error', reject); request.once('response', async (incoming) => {
        try { const chunks = []; for await (const chunk of incoming) chunks.push(chunk); resolve(Buffer.concat(chunks)); } catch (error) { reject(error); }
      });
    });
    request.end(); return { request, response };
  };
  await collector.phase('before', { captureRequired: true });
  assert.deepEqual(JSON.parse(await get('/v1.52/positive-before').response), { target: '/v1.52/positive-before', original: true });
  const delayed = get('/v1.52/containers/held-relay/json'); void delayed.response.catch(() => {});
  await entered.promise;
  await collector.phase('during', { captureRequired: requireBody });
  delayed.request.destroy(new Error('Original downstream cancellation before response headers.'));
  await assert.rejects(delayed.response, /Original downstream cancellation/u);
  await peerClosed.promise; await proxy.idle();
  await collector.phase('cleanup', { captureRequired: true, originalCleanup: { path: '/original/settled.json' } });
  assert.deepEqual(JSON.parse(await get('/v1.52/original-cleanup').response), { target: '/v1.52/original-cleanup', original: true });
  await proxy.idle(); await proxy.close();
  const captured = await capture.close(), result = await phaseCapture(await collector.close()); await evidence.close();
  assert.deepEqual(forwarded, ['/v1.52/positive-before', '/v1.52/containers/held-relay/json', '/v1.52/original-cleanup']);
  assert.equal(proxy.capacity().connections.current, 0); assert.equal(proxy.capacity().requests.current, 0);
  if (hook !== 'original') {
    assert.equal(captured.completeness, 'incomplete'); assert.equal(result.completeness, 'incomplete');
    if (hook === 'missing') {
      assert.match(result.failures[0].message, /without a captured terminal/u);
      assert.equal(result.counts['engine-terminal'], 0);
    } else {
      const unconfirmed = result.observations.find(({ kind, identity }) => kind === 'engine-terminal' && identity.outcome === 'unconfirmed');
      assert.equal(unconfirmed.completeness, 'incomplete'); assert.match(unconfirmed.failure.message, /identity does not match/u);
      assert.equal(JSON.parse(await readFile(unconfirmed.original.path, 'utf8')).status, null);
    }
    return;
  }
  assert.equal(captured.completeness, 'complete');
  assert.equal(result.completeness, requireBody ? 'incomplete' : 'complete');
  assert.deepEqual(result.uncovered, requireBody ? [{ sequence: 2, name: 'during' }] : []);
  const terminal = result.observations.find(({ kind, identity }) => kind === 'engine-terminal' && identity.outcome === 'response_absent');
  assert.equal(terminal.phaseName, 'before'); assert.equal(terminal.completionPhase, 2);
  assert.equal(terminal.identity.scope, 'local_request_lifecycle'); assert.equal(terminal.identity.status, null);
  assert.equal(terminal.failure, null); assert.equal(terminal.identity.requestFailure.name, 'AbortError');
  const bytes = await readFile(terminal.original.path), originalTrace = await readFile(tracePath), reference = terminal.identity.trace;
  assert.deepEqual(bytes, originalTrace.subarray(reference.offset, reference.offset + reference.bytes));
  assert.equal(reference.sha256, createHash('sha256').update(bytes).digest('hex'));
  const record = JSON.parse(bytes);
  assert.equal(record.status, null); assert.equal(record.upstreamBodyBytes, 0); assert.equal(record.forwardedBodyBytes, 0);
  assert.deepEqual(record.terminal, { kind: 'http', upstreamRequestClosed: true, downstreamResponseClosed: true, downstreamAbandoned: true });
  assert.equal(result.observations.filter(({ kind }) => kind === 'engine').length, 2);
  assert.equal(captured.terminalRequests, 3); assert.equal(captured.responseAbsent, 1);
});

for (const unmatched of [false, true]) test(`${unmatched ? 'unmatched request-phase' : 'response-count'} exhaustion notifies the original owner once and preserves exact cleanup responses through the Unix proxy`, async (t) => {
  const stopped = [];
  const { directory, evidence, collector, capture } = await setup(t, ['before', 'cleanup'], unmatched ? 128 : 1, undefined,
    (error) => stopped.push(error.message));
  const socketPath = join(directory, 'u.sock'), forwarded = [];
  const server = http.createServer((request, response) => {
    forwarded.push(request.url);
    if (request.url.startsWith('/v1.52/unmatched/')) { request.socket.destroy(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url === '/v1.52/networks' ? '[{"Id":"original"}]' : JSON.stringify({ Id: 'original-owner', target: request.url }));
  });
  server.listen(socketPath); await once(server, 'listening');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'p.sock'), upstreamEndpoint: `unix://${socketPath}`,
    tracePath: join(directory, 'trace.jsonl'), observeRequest: capture.observeRequest, observeResponseBody: capture.observeResponseBody,
    ...(unmatched ? {} : { observeRequestSettled: capture.observeRequestSettled }) });
  t.after(async () => { await proxy.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const get = (path) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath: proxy.endpoint.slice(7), method: 'GET', path, agent: false }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject); request.end();
  });
  await collector.phase('before');
  assert.deepEqual(await get('/v1.52/networks'), { status: 200, bytes: '[{"Id":"original"}]' });
  await proxy.idle();
  const unmatchedPaths = unmatched ? Array.from({ length: 16 }, (_, index) => `/v1.52/unmatched/${index}`) : [];
  for (const path of unmatchedPaths) {
    await assert.rejects(get(path), (error) => ['ECONNRESET', 'EPIPE'].includes(error.code));
    // Join the original forwarding lifecycle before entering the next collector census slot.
    await proxy.idle();
  }
  assert.deepEqual(await get('/v1.52/containers/entered-before-exhaustion/json'), {
    status: 200, bytes: '{"Id":"original-owner","target":"/v1.52/containers/entered-before-exhaustion/json"}',
  });
  await collector.phase('cleanup', { originalCleanup: { path: '/original/settled.json' } });
  assert.deepEqual(await get('/v1.52/containers/original-cleanup/json'), {
    status: 200, bytes: '{"Id":"original-owner","target":"/v1.52/containers/original-cleanup/json"}',
  });
  await proxy.idle(); await proxy.close();
  const captured = await capture.close(), result = await phaseCapture(await collector.close()); await evidence.close();
  assert.deepEqual(forwarded, ['/v1.52/networks', ...unmatchedPaths, '/v1.52/containers/entered-before-exhaustion/json', '/v1.52/containers/original-cleanup/json']);
  assert.equal(captured.completeness, 'incomplete'); assert.equal(captured.uncapturedResponses, 2);
  assert.equal(result.completeness, 'incomplete'); assert.equal(result.counts.engine, 1);
  const message = unmatched ? 'Original Engine request phase census exceeded forwarding capacity.' : 'Original Engine response lifetime exceeded its calculated capacity.';
  assert.deepEqual(stopped, [message]); assert.equal(result.failures[0].message, message);
  assert.deepEqual(result.phases.at(-1).originalCleanup, { path: '/original/settled.json' });
  assert.equal(proxy.capacity().requests.current, 0); assert.equal(proxy.capacity().connections.current, 0);
  assert.equal(proxy.capacity().requests.rejected, 0); assert.equal(proxy.capacity().connections.rejected, 0);
});

function nativeFrame(sequence) {
  const bytes = Buffer.from(JSON.stringify({ protocol: 'agenai.sandbox.desktop-route-observer.v1', kind: 'observation', sequence,
    document: { format: 'agenai.desktop-vm-network.v1', complete: true } }) + '\n');
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(bytes.length, 4); return Buffer.concat([header, bytes]);
}

test('a full paired-workflow collector retains Engine bodies and both native directions beyond the original 9800-record ceiling', { timeout: 30_000 }, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'concurrency-lifetime-')), directory = join(parent, 'attempt');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const manifest = capabilityManifest('combined', 'a'.repeat(64), platformManifest('desktop-apple-virtualization-native-arm64'));
  manifest.limits = { ...manifest.limits, startupMs: 60_000, cleanupMs: 30_000, scenarioMs: 600_000 };
  manifest.concurrency = { caseId: 'joint-ab', evidence: { maxAttemptBytes: 96 * 1024 ** 3, maxResponseBytes: 1024 ** 2, maxEngineNetworks: 8 } };
  const budget = concurrencyScenarioBudget(manifest);
  const evidence = new ConcurrencyEvidence(directory, manifest.concurrency.evidence.maxAttemptBytes, budget); await evidence.initialize('{}');
  const collector = createPhaseCollector({ evidence, budget, responseBytes: 1024 ** 2, requiredPhases: ['retained'] });
  const id = 'a'.repeat(64), capture = createConcurrencyCapture({ collector, budget, observerIds: new Map([[id, { label: 'a' }]]), maxResponseBytes: 1024 ** 2 });
  await collector.phase('retained', { captureRequired: true, vmCandidates: [id] });
  const body = Buffer.from('[{"Id":"original-network","complete":true}]');
  for (let traceId = 1; traceId <= 8101; traceId++) {
    const response = capture.observeResponseBody({ method: 'GET', target: '/v1.52/networks', status: 200, traceId });
    await response.body(body); await response.complete({ complete: true });
  }
  const attachment = capture.observeUpgrade({ method: 'POST', target: `/v1.52/containers/${id}/attach?stream=1`, status: 101, record: { id: 8102 },
    connection: () => ({ downstream: { destroyed: true }, upstream: { destroyed: true } }) });
  for (let sequence = 1; sequence <= 951; sequence++) {
    await attachment.input(Buffer.from(JSON.stringify({ protocol: 'agenai.sandbox.desktop-route-observer.v1', kind: 'observe', sequence }) + '\n'));
    await attachment.response(nativeFrame(sequence), async (bytes) => assert.deepEqual(bytes, nativeFrame(sequence)));
  }
  assert.equal(collector.hasNativeForCurrent([id]), true);
  const captured = await capture.close(), result = await collector.close(); await evidence.close();
  assert.equal(captured.completeness, 'complete'); assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.counts, { engine: 8101, 'engine-terminal': 0, vm: 951, 'vm-control': 951 });
  const ledger = await readFile(result.observationIndex.path);
  assert.equal(ledger.length, result.observationIndex.bytes);
  assert.equal(createHash('sha256').update(ledger).digest('hex'), result.observationIndex.sha256);
  const records = ledger.toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 10_003);
  assert.deepEqual(await readFile(records[8100].original.path), body);
  const last = records.findLast(({ kind }) => kind === 'vm');
  assert.equal(last.identity.sequence, 951);
  const lastBytes = await readFile(last.original.path);
  assert.deepEqual(lastBytes, nativeFrame(951).subarray(8));
  assert.equal(last.original.bytes, lastBytes.length);
  assert.equal(last.original.sha256, createHash('sha256').update(lastBytes).digest('hex'));
});

test('phase capture preserves complete original bodies and native frames after the former sixteen-frame prefix', async (t) => {
  const { evidence, collector, capture, id } = await setup(t);
  await collector.phase('before', { captureRequired: true });
  const response = capture.observeResponseBody({ method: 'GET', target: '/v1.52/networks', status: 200, traceId: 1 });
  await response.body(Buffer.from('[{"Id":"original"}]')); await response.complete({ complete: true });
  let destroyed = false;
  const attachment = capture.observeUpgrade({ method: 'POST', target: `/v1.52/containers/${id}/attach?stream=1`, status: 101, record: { id: 2 },
    connection: () => ({ downstream: { destroyed }, upstream: { destroyed } }) });
  const forwarded = [];
  for (let sequence = 1; sequence <= 20; sequence++) {
    if (sequence === 17) await collector.phase('after');
    await attachment.input(Buffer.from(JSON.stringify({ protocol: 'agenai.sandbox.desktop-route-observer.v1', kind: 'observe', sequence }) + '\n'));
    const frame = nativeFrame(sequence);
    await attachment.response(frame.subarray(0, 5), async (bytes) => forwarded.push(Buffer.from(bytes)));
    await attachment.response(frame.subarray(5), async (bytes) => forwarded.push(Buffer.from(bytes)));
  }
  destroyed = true;
  const captured = await capture.close(), result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(captured.completeness, 'complete'); assert.equal(captured.attachments[0].frames, 20);
  assert.equal(result.completeness, 'complete');
  const last = result.observations.filter(({ kind }) => kind === 'vm').at(-1);
  assert.equal(last.phaseName, 'after'); assert.equal(last.identity.sequence, 20);
  assert.deepEqual(JSON.parse(await readFile(last.original.path, 'utf8')),
    { protocol: 'agenai.sandbox.desktop-route-observer.v1', kind: 'observation', sequence: 20,
      document: { format: 'agenai.desktop-vm-network.v1', complete: true } });
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat(Array.from({ length: 20 }, (_, index) => nativeFrame(index + 1))));
  assert.equal(await readFile(result.observations.find(({ kind }) => kind === 'engine').original.path, 'utf8'), '[{"Id":"original"}]');
});

test('phase coverage follows original control entry and accepts the actual eligible shared-graph observer', async (t) => {
  const { evidence, collector, capture, id } = await setup(t);
  await collector.phase('before');
  const response = capture.observeResponseBody({ method: 'GET', target: '/v1.52/networks', status: 200, traceId: 9 });
  let destroyed = false;
  const attachment = capture.observeUpgrade({ method: 'POST', target: `/v1.52/containers/${id}/attach?stream=1`, status: 101, record: { id: 2 },
    connection: () => ({ downstream: { destroyed }, upstream: { destroyed } }) });
  const command = (sequence) => Buffer.from(JSON.stringify({ protocol: 'agenai.sandbox.desktop-route-observer.v1', kind: 'observe', sequence }) + '\n');
  await attachment.input(command(1));
  await collector.phase('after', { vmCandidates: [id, 'b'.repeat(64)] });
  await response.body(Buffer.from('[]')); await response.complete({ complete: true });
  await attachment.response(nativeFrame(1), async () => {});
  assert.equal(collector.hasNativeForCurrent([id, 'b'.repeat(64)]), false, 'A response entered in the preceding phase earns no new phase coverage.');
  await attachment.input(command(2)); await attachment.response(nativeFrame(2), async () => {});
  assert.equal(collector.hasNativeForCurrent([id, 'b'.repeat(64)]), true);
  destroyed = true; await capture.close(); const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(result.completeness, 'complete'); assert.deepEqual(result.missingNative, []);
  assert.equal(result.phases[1].selectedObserver.containerId, id); assert.equal(result.phases[1].selectedObserver.sequence, 2);
  assert.equal(result.observations.find(({ kind }) => kind === 'engine').phaseName, 'before');
  assert.equal(result.observations.find(({ kind }) => kind === 'engine').completionPhase, 2);
});

test('concurrent original-byte writes reserve capacity before disk completion', async (t) => {
  const { evidence, collector } = await setup(t, ['before'], 2);
  await collector.phase('before');
  const first = collector.bytes('engine', { target: '/first' }, Buffer.from('first'));
  const second = collector.bytes('engine', { target: '/second' }, Buffer.from('second'));
  assert.throws(() => collector.bytes('engine', { target: '/third' }, Buffer.from('third')), /calculated capacity/u);
  await Promise.all([first, second]); const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(result.completeness, 'incomplete'); assert.deepEqual(result.observations.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(await readFile(result.observations[0].original.path, 'utf8'), 'first');
  assert.equal(await readFile(result.observations[1].original.path, 'utf8'), 'second');
});

test('a phase metadata-capacity failure remains failed after the original cleanup reference is recorded', async (t) => {
  const { evidence, collector } = await setup(t, ['before', 'cleanup']);
  await assert.rejects(collector.phase('before', { payload: 'x'.repeat(65_536) }), { code: 'ERR_ASSERTION' });
  await collector.phase('cleanup', { originalCleanup: { path: '/original/settled-record.json', sha256: 'c'.repeat(64) } });
  const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(result.completeness, 'incomplete'); assert.equal(result.failures[0].code, 'ERR_ASSERTION');
  assert.equal(result.phases[0].payload.length, 65_536);
  assert.deepEqual(result.phases.at(-1).originalCleanup, { path: '/original/settled-record.json', sha256: 'c'.repeat(64) });
});

test('an observation-index append failure stays fatal after raw capture and successful cleanup', async (t) => {
  const { directory, evidence, collector, capture } = await setup(t, ['before', 'cleanup'], 128,
    (path) => mkdir(join(path, 'observation-index.jsonl')));
  await collector.phase('before', { captureRequired: true });
  const body = Buffer.from('[{"Id":"original"}]');
  await assert.rejects(collector.bytes('engine', { target: '/v1.52/networks', complete: true }, body), { code: 'EEXIST' });
  await collector.phase('cleanup', { complete: true, originalCleanup: { path: '/original/settled-record.json', sha256: 'b'.repeat(64) } });
  const result = await collector.close(); await capture.close(); await assert.rejects(evidence.close(), { code: 'EEXIST' });
  assert.equal(result.completeness, 'incomplete'); assert.equal(result.counts.engine, 1);
  assert.deepEqual(await readFile(join(directory, 'raw-00001.bin')), body);
  const index = JSON.parse(await readFile(result.index.path, 'utf8'));
  assert.equal(index.failures.some(({ code }) => code === 'EEXIST'), true);
  assert.deepEqual(index.uncovered, [{ sequence: 1, name: 'before' }]);
  assert.deepEqual(index.phases.at(-1).originalCleanup, { path: '/original/settled-record.json', sha256: 'b'.repeat(64) });
});

test('a rejected observation ledger still joins every entered raw writer before publishing its final index', async (t) => {
  const { directory, evidence, collector } = await setup(t, ['before'], 128,
    (path) => mkdir(join(path, 'observation-index.jsonl')));
  await collector.phase('before');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), returned = Promise.withResolvers();
  const file = evidence.file.bind(evidence);
  evidence.file = async (name, value, maximum) => {
    if (name !== 'raw-00002.bin') return file(name, value, maximum);
    entered.resolve(); await release.promise;
    try { return await file(name, value, maximum); } finally { returned.resolve(); }
  };
  const first = collector.bytes('engine', { target: '/first' }, Buffer.from('first'));
  const second = collector.bytes('engine', { target: '/second' }, Buffer.from('original second body'));
  void first.catch(() => {}); void second.catch(() => {});
  await entered.promise; await assert.rejects(first, { code: 'EEXIST' });
  const closing = collector.close(); let timer;
  try {
    assert.equal(await Promise.race([closing.then(() => 'closed'), new Promise((resolve) => { timer = setTimeout(() => resolve('owned'), 100); })]), 'owned');
    release.resolve(); await returned.promise; await assert.rejects(second, { code: 'EEXIST' });
    const result = await closing;
    assert.equal(result.completeness, 'incomplete'); assert.equal(result.counts.engine, 2);
    assert.deepEqual(await readFile(join(directory, 'raw-00002.bin')), Buffer.from('original second body'));
  } finally {
    clearTimeout(timer); release.resolve(); await returned.promise; await Promise.allSettled([first, second, closing]);
    await assert.rejects(evidence.close(), { code: 'EEXIST' });
  }
});

test('sticky append failure releases the original Evidence file handle during close', async (t) => {
  const { directory, evidence, collector, id } = await setup(t, ['before']);
  await collector.phase('before');
  await collector.stream('vm-control-wire', { containerId: id }, Buffer.from('original control bytes'));
  const entry = evidence.handles.get(`vm-control-wire-${id}.bin`);
  assert(entry.handle.fd >= 0);
  await mkdir(join(directory, 'collision'));
  await assert.rejects(evidence.append('collision', Buffer.from('uncommitted')), { code: 'EEXIST' });
  const result = await collector.close();
  await assert.rejects(evidence.close(), { code: 'EEXIST' });
  assert.equal(entry.handle.fd, -1);
  assert.equal(result.completeness, 'incomplete');
  assert.deepEqual(await readFile(join(directory, `vm-control-wire-${id}.bin`)), Buffer.from('original control bytes'));
});

test('network-list capture retains exact bytes while an additional network beyond the selected census fails qualification', async (t) => {
  const { evidence, collector, capture } = await setup(t, ['before']);
  await collector.phase('before', { captureRequired: true });
  const networks = Array.from({ length: 9 }, (_, index) => ({ Id: String(index).repeat(64) }));
  const bodies = [Buffer.from(JSON.stringify(networks.slice(0, 8))), Buffer.from(JSON.stringify(networks))];
  for (const [index, body] of bodies.entries()) {
    const response = capture.observeResponseBody({ method: 'GET', target: '/v1.52/networks', status: 200, traceId: index + 1 });
    await response.body(body); await response.complete({ complete: true });
  }
  const captured = await capture.close(), result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(captured.completeness, 'incomplete'); assert.equal(captured.completed, 1); assert.equal(captured.incomplete, 1);
  assert.equal(result.completeness, 'incomplete'); assert.deepEqual(result.uncovered, []);
  assert.deepEqual(result.observations.map(({ completeness }) => completeness), ['complete', 'incomplete']);
  assert.match(result.observations[1].failure.message, /maxEngineNetworks/u);
  for (const [index, body] of bodies.entries()) assert.deepEqual(await readFile(result.observations[index].original.path), body);
});

test('later successful cleanup cannot conceal a missing phase or an incomplete original response', async (t) => {
  const { evidence, collector, capture } = await setup(t, ['before', 'fault-entered', 'cleanup']);
  await collector.phase('before');
  const response = capture.observeResponseBody({ method: 'GET', target: '/v1.52/networks', status: 200, traceId: 1 });
  await response.body(Buffer.from('[partial')); await response.complete({ complete: false });
  await collector.phase('cleanup');
  const result = await phaseCapture(await collector.close()); await capture.close(); await evidence.close();
  assert.equal(result.completeness, 'incomplete'); assert.deepEqual(result.missing, ['fault-entered']);
  assert.equal(result.observations[0].identity.complete, false);
  assert.equal(await readFile(result.observations[0].original.path, 'utf8'), '[partial');
  assert.match(result.failures[0].message, /Original Engine response incomplete/u);
});

test('a native wait ends on its selected cut without coverage, and still expires without one', async (t) => {
  const { evidence, collector, id } = await setup(t, ['observed']);
  await collector.phase('observed', { vmCandidates: [id] });
  const cut = new AbortController();
  const waiting = collector.awaitNative([id], { timeoutMs: 5000, signal: cut.signal });
  cut.abort();
  assert.equal(await waiting, false);
  assert.equal(await collector.awaitNative([id], { timeoutMs: 5000, signal: cut.signal }), false, 'A request handled after the cut is not awaited.');
  await assert.rejects(collector.awaitNative([id], { timeoutMs: 50, signal: new AbortController().signal }),
    /Required phase lacks complete original native observer bytes/u);
  await collector.close(); await evidence.close();
});

test('only observations outstanding at the verified cut become superseded native coverage', async (t) => {
  const { evidence, collector, capture, id } = await setup(t, ['in-flight', 'covered', 'checkpoint-only', 'later'], 128);
  const cut = { path: '/original/cut-report.json', bytes: 2, sha256: 'c'.repeat(64) };
  await collector.phase('in-flight', { requestId: 7, vmCandidates: [id] });
  let destroyed = false;
  const attachment = capture.observeUpgrade({ method: 'POST', target: `/v1.52/containers/${id}/attach?stream=1`, status: 101, record: { id: 2 },
    connection: () => ({ downstream: { destroyed }, upstream: { destroyed } }) });
  await collector.phase('covered', { requestId: 8, vmCandidates: [id] });
  await attachment.input(Buffer.from(JSON.stringify({ protocol: 'agenai.sandbox.desktop-route-observer.v1', kind: 'observe', sequence: 1 }) + '\n'));
  await attachment.response(nativeFrame(1), async () => {});
  await collector.phase('checkpoint-only', { requestId: 9, vmCandidates: [id] });
  await collector.phase('later', { requestId: 10, vmCandidates: [id] });
  collector.bindCut({ cut, outstanding: [{ id: 7, kind: 'observation' }, { id: 8, kind: 'observation' }, { id: 9, kind: 'checkpoint' }] });
  assert.throws(() => collector.bindCut({ cut, outstanding: [] }), /binds the phase collector once/u);
  destroyed = true; await capture.close(); const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.deepEqual(result.supersededNative, [{ phase: 1, name: 'in-flight', candidates: [id], requestId: 7, cut }]);
  assert.deepEqual(result.missingNative.map(({ name }) => name), ['checkpoint-only', 'later']);
  assert.equal(result.completeness, 'incomplete');
});

test('an unbound or malformed cut never supersedes missing native coverage', async (t) => {
  const { evidence, collector, id } = await setup(t, ['in-flight']);
  await collector.phase('in-flight', { requestId: 1, vmCandidates: [id] });
  assert.throws(() => collector.bindCut({ cut: {}, outstanding: [{ id: '1', kind: 'observation' }] }), /malformed/u);
  const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.deepEqual(result.supersededNative, []); assert.deepEqual(result.missingNative.map(({ name }) => name), ['in-flight']);
  assert.equal(result.completeness, 'incomplete');
});

test('a fully superseded cut capture is complete while recording each superseded phase', async (t) => {
  const { evidence, collector, id } = await setup(t, ['in-flight']);
  const cut = { path: '/original/cut-report.json', bytes: 2, sha256: 'd'.repeat(64) };
  await collector.phase('in-flight', { requestId: 3, vmCandidates: [id] });
  collector.bindCut({ cut, outstanding: [{ id: 3, kind: 'observation' }] });
  const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(result.completeness, 'complete'); assert.deepEqual(result.missingNative, []);
  assert.deepEqual(result.supersededNative.map(({ requestId, cut: bound }) => ({ requestId, bound })), [{ requestId: 3, bound: cut }]);
});

test('an outstanding observation handled after the cut binding is still superseded by that cut', async (t) => {
  const { evidence, collector, id } = await setup(t, ['fault-entered', 'late']);
  const cut = { path: '/original/cut-report.json', bytes: 2, sha256: 'e'.repeat(64) };
  await collector.phase('fault-entered', { originalCut: cut });
  collector.bindCut({ cut, outstanding: [{ id: 12, kind: 'observation' }] });
  await collector.phase('late', { requestId: 12, vmCandidates: [id] });
  const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.deepEqual(result.supersededNative.map(({ name, requestId }) => ({ name, requestId })), [{ name: 'late', requestId: 12 }]);
  assert.equal(result.completeness, 'complete');
});

async function severedAttachment(t, { bind = true, awaited = true } = {}) {
  const selected = await setup(t, ['fault-entered']);
  const { collector, capture, id } = selected;
  await collector.phase('fault-entered');
  let destroyed = false;
  const attachment = capture.observeUpgrade({ method: 'POST', target: `/v1.52/containers/${id}/attach?stream=1`, status: 101, record: { id: 296 },
    connection: () => ({ downstream: { destroyed }, upstream: { destroyed } }) });
  const command = (sequence) => Buffer.from(JSON.stringify({ protocol: 'agenai.sandbox.desktop-route-observer.v1', kind: 'observe', sequence }) + '\n');
  await attachment.input(command(1)); await attachment.response(nativeFrame(1), async () => {});
  if (awaited) await attachment.input(command(2));
  const reply = nativeFrame(2);
  await attachment.response(reply.subarray(0, 20), async () => {});
  if (bind) collector.bindCut({ cut: { path: '/original/cut-report.json', bytes: 2, sha256: 'f'.repeat(64) }, outstanding: [] });
  const severed = attachment.response(reply.subarray(20, 40), async () => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); });
  return { ...selected, severed, end() { destroyed = true; } };
}

test('a reader killed by the selected cut mid-reply settles its attachment once the observer is exactly absent', async (t) => {
  const { evidence, collector, capture, id, severed, end } = await severedAttachment(t);
  assert.equal(await severed, 'close', 'The severed tunnel closes instead of failing original capture.');
  end(); const captured = await capture.close({ absentContainers: new Set([id]) });
  const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(captured.completeness, 'complete'); assert.equal(captured.attachments[0].complete, true);
  assert.deepEqual(captured.attachments[0].partial, { multiplex: 40, line: 0, control: 0 });
  assert.equal(captured.attachments[0].severed.failure.message, 'write EPIPE');
  assert.deepEqual(captured.attachments[0].severed.pendingControls, [2]);
  assert.equal(result.completeness, 'complete'); assert.deepEqual(result.failures, []);
});

test('a cut-severed reply stays incomplete while its observer container is not proven absent', async (t) => {
  const { evidence, collector, capture, severed, end } = await severedAttachment(t);
  assert.equal(await severed, 'close');
  end(); const captured = await capture.close({ absentContainers: new Set(['b'.repeat(64)]) });
  const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(captured.completeness, 'incomplete');
  assert.deepEqual(result.failures.map(({ message }) => message), ['Original native observer stream is incomplete or remains unjoined.']);
});

test('partial bytes without an awaited reply stay incomplete after a cut', async (t) => {
  const { evidence, collector, capture, id, severed, end } = await severedAttachment(t, { awaited: false });
  assert.equal(await severed, 'close');
  end(); const captured = await capture.close({ absentContainers: new Set([id]) });
  await collector.close(); await evidence.close();
  assert.deepEqual(captured.attachments[0].severed.pendingControls, []);
  assert.equal(captured.completeness, 'incomplete');
});

test('a reader delivery failure before any selected cut remains a capture failure', async (t) => {
  const { evidence, collector, capture, id, severed, end } = await severedAttachment(t, { bind: false });
  await assert.rejects(severed, /write EPIPE/u);
  end(); const captured = await capture.close({ absentContainers: new Set([id]) });
  const result = await phaseCapture(await collector.close()); await evidence.close();
  assert.equal(Object.hasOwn(captured.attachments[0], 'severed'), false); assert.equal(captured.completeness, 'incomplete');
  assert(result.failures.some(({ message }) => message === 'write EPIPE')); assert.equal(result.completeness, 'incomplete');
});
