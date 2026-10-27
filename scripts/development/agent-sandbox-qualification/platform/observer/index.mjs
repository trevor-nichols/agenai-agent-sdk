// ------------------------------------------------------------------------------------------------
//                index.mjs - Exact workload kernel registry, private reader port and diagnostic cleanup
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { failure, physicalDirectory } from '../../scalability/configuration.mjs';
import { ObserverContainer } from './container.mjs';
import { Engine } from '../../engine.mjs';
import { createObserverCheckpoint } from './checkpoint.mjs';
import { admitObservedContainer, observerPolicy } from './admission.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function scopeLimit(value) {
  const selected = value === undefined ? 128 : value;
  assert(selected === 128 || selected === 256, 'Observer maxScopes must explicitly select 128 or 256.');
  return selected;
}

function validateRegistry(record) {
  const maximum = scopeLimit(record.maxScopes);
  assert(Array.isArray(record.scopes) && record.scopes.length <= maximum, 'Observer record exceeds its admitted scope capacity.');
  const ids = record.scopes.map((scope) => {
    assert(scope && /^[a-f0-9]{64}$/u.test(scope.computeId), 'Observer record has an invalid scope identity.');
    return scope.computeId;
  });
  assert.equal(new Set(ids).size, ids.length, 'Observer record repeats a scope identity.');
  if (record.observerRemoved && record.containerId !== null) {
    assert.equal(record.finalCensus?.kernelEmpty, true);
    assert.equal(record.finalCensus.scopes, record.scopes.length, 'Disposed observer census must cover every retained scope.');
  }
}

async function openObserver(options, retained) {
  const maxScopes = scopeLimit((retained ?? options).maxScopes);
  const output = options.output;
  if (!retained) await physicalDirectory(output);
  const recordPath = retained ? options.recordPath : join(output, 'record.json');
  const policy = observerPolicy(retained ?? options);
  const record = retained ?? { ...ObserverContainer.planned(options), ...policy, maxScopes,
    observationsPath: join(output, 'observations.jsonl') };
  validateRegistry(record);
  const checkpoint = createObserverCheckpoint(recordPath);
  const persist = () => checkpoint.write(record);
  const container = new ObserverContainer(record, persist);
  const events = await open(record.observationsPath, retained ? 'a' : 'wx', 0o600);
  let pendingEvents = Promise.resolve();
  let server;
  let kernelSocket;
  let socketIdentity;
  let serverClosure;
  let closed = false;
  const activeReads = new Set();
  const note = (kind, value) => {
    const bytes = `${JSON.stringify({ observedAt: new Date().toISOString(), kind, ...value })}\n`;
    assert(Buffer.byteLength(bytes) <= 64 * 1024);
    const actual = pendingEvents.then(() => events.writeFile(bytes));
    pendingEvents = actual; return actual;
  };
  const find = (id) => record.scopes.find((scope) => scope.computeId === id);
  const capture = async (id) => {
    const inspection = await container.engine.request('GET', `/containers/${id}/json`, undefined, { allowed: [200, 404] });
    assert.equal(inspection.status, 200, 'Started container disappeared before kernel capture.');
    const actual = inspection.data;
    const identity = admitObservedContainer(policy, actual, id);
    if (identity === null) return;
    let scope = find(id);
    if (!scope) {
      assert(record.scopes.length < maxScopes, 'Kernel registry exceeds its finite qualification budget.');
      scope = { ...identity,
        relativePath: null, knownPids: [], captureFailure: null, emptyObservations: 0 };
      record.scopes.push(scope); await persist();
    }
    try {
      const observed = await container.call({ operation: 'capture', computeId: id, keeperPid: actual.State.Pid });
      if (scope.relativePath !== null) assert.equal(scope.relativePath, observed.relativePath);
      Object.assign(scope, observed); scope.captureFailure = null; await persist(); await note('capture', { scope });
    } catch (error) { scope.captureFailure = failure(error); await persist(); throw error; }
  };
  const empty = async (scope, checkpoint) => {
    assert(scope.relativePath !== null && scope.captureFailure === null, 'Entered compute lacks a successful independent kernel capture.');
    const observed = await container.call({ operation: 'empty', scope });
    assert.equal(observed.kernelEmpty, true); scope.emptyObservations += 1;
    await persist(); await note('kernel-empty', { checkpoint, ...observed }); return observed;
  };
  const readKernel = async (path) => {
    assert(typeof path === 'string' && path.length <= 8192);
    const observed = await container.call({ operation: 'read', path, maxScopes, scopes: record.scopes
      .filter((scope) => typeof scope.relativePath === 'string' && scope.captureFailure === null).map((scope) => ({
      computeId: scope.computeId, relativePath: scope.relativePath, knownPids: [],
    })) });
    assert(typeof observed.text === 'string' && Buffer.byteLength(observed.text) <= 16 * 1024);
    const scope = find(observed.computeId); assert(scope);
    if (observed.identity && !scope.knownPids.some((entry) => entry.pid === observed.identity.pid && entry.startClockTicks === observed.identity.startClockTicks)) {
      assert(scope.knownPids.length < 512); scope.knownPids.push(observed.identity); await persist();
    }
    await note('kernel-read', { computeId: scope.computeId, path, bytes: Buffer.byteLength(observed.text),
      sha256: createHash('sha256').update(observed.text).digest('hex') });
    return observed.text;
  };
  const assertAllEmpty = async () => {
    const results = [];
    const failures = [];
    for (const scope of record.scopes) {
      try {
        results.push(await empty(scope, 'final-before-observer-disposal'));
        assert.equal((await container.inspect(scope.computeId)).status, 404, 'Workload container remains present before observer disposal.');
      }
      catch (error) { failures.push({ computeId: scope.computeId, error: failure(error) }); }
    }
    await note('final-census', { scopes: record.scopes.length, failures });
    if (failures.length) throw new AggregateError(failures, 'Kernel workload cleanup remains unproven; diagnostic observer is retained.');
    record.finalCensus = { kernelEmpty: true, scopes: results.length, observedAt: new Date().toISOString() }; await persist();
    return { scopes: results.length, kernelEmpty: true, observationsPath: record.observationsPath };
  };
  const closeServer = async () => {
    if (server && !serverClosure) serverClosure = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    while (activeReads.size) await Promise.allSettled([...activeReads]);
    await serverClosure;
    if (kernelSocket) {
      try {
        const current = await lstat(kernelSocket, { bigint: true });
        assert(current.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino);
        await unlink(kernelSocket);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const owner = {
    get record() { return record; }, recordPath,
    async observeResponse({ method, target, status }) {
      assert(!closed);
      const path = new URL(target, 'http://engine.invalid').pathname;
      const start = /^\/v1\.52\/containers\/([a-f0-9]{64})\/start$/u.exec(path);
      if (method === 'POST' && status === 204 && start) await capture(start[1]);
      const deleted = /^\/v1\.52\/containers\/([a-f0-9]{64})$/u.exec(path);
      if (method === 'DELETE' && [204, 404].includes(status) && deleted) {
        const scope = find(deleted[1]); if (scope) await empty(scope, 'before-forwarding-cleanup-acknowledgement');
      }
    },
    async listenKernel(socketPath) {
      assert(!server); kernelSocket = socketPath;
      server = http.createServer({ maxHeaderSize: 16 * 1024, highWaterMark: 16 * 1024 }, (request, response) => {
        if (activeReads.size >= 16) { response.destroy(new Error('Kernel read concurrency exceeds its bound.')); return; }
        const work = (async () => {
          assert.equal(request.method, 'POST'); assert.equal(request.url, '/read');
          let bytes = 0; const chunks = [];
          for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 16 * 1024); chunks.push(chunk); }
          const query = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert.deepEqual(Object.keys(query), ['path']);
          const text = await readKernel(query.path);
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ text }));
        })().catch((error) => { if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: failure(error) })); });
        activeReads.add(work); void work.finally(() => activeReads.delete(work));
      });
      server.requestTimeout = 30_000;
      server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
      socketIdentity = await lstat(socketPath, { bigint: true });
      return { endpoint: `unix://${socketPath}` };
    },
    assertAllEmpty,
    async close() {
      if (closed) {
        if (!record.observerRemoved) Object.assign(record, await cleanupDaemonObserver({ endpoint: record.endpoint, recordPath }));
        return;
      }
      let primary;
      try { await assertAllEmpty(); await container.destroy(); }
      catch (error) { primary = error; record.failures.push(failure(error)); await persist(); }
      const cleanup = [];
      try { await closeServer(); } catch (error) { cleanup.push(error); }
      try { await checkpoint.join(); } catch (error) { cleanup.push(error); }
      try { await pendingEvents; } catch (error) { cleanup.push(error); }
      try { await events.close(); } catch (error) { cleanup.push(error); }
      closed = cleanup.length === 0;
      if (primary || cleanup.length) throw Object.assign(new AggregateError([...(primary === undefined ? [] : [primary]), ...cleanup],
        'Diagnostic cleanup retains exact observer ownership; use its persisted record after workload cleanup.'), { recordPath,
        async retryCleanup() { Object.assign(record, await cleanupDaemonObserver({ endpoint: record.endpoint, recordPath })); } });
    },
  };
  if (!retained) {
    try { await persist(); await container.start(); }
    catch (error) {
      record.failures.push(failure(error)); await persist();
      try { await owner.close(); } catch (cleanupError) { throw Object.assign(new AggregateError([error, cleanupError], 'Observer acquisition and cleanup failed.'), { recordPath }); }
      throw error;
    }
  } else {
    assert.equal(record.endpoint, options.endpoint);
    assert.equal((await container.engine.request('GET', '/info')).data.ID, record.daemonId);
    if (!record.observerRemoved) container.verify((await container.inspect()).data);
  }
  return owner;
}

export async function createDaemonObserver(options) {
  const maxScopes = scopeLimit(options.maxScopes);
  const policy = observerPolicy(options);
  await mkdir(options.output, { mode: 0o700 });
  return openObserver({ ...options, ...policy, maxScopes });
}

export async function cleanupDaemonObserver({ endpoint, recordPath }) {
  const bytes = await readFile(recordPath); assert(bytes.length <= 1024 * 1024);
  const record = JSON.parse(bytes.toString('utf8'));
  assert.equal(record.format, 'agenai.sandbox-daemon-observer.v1'); assert.equal(record.endpoint, endpoint);
  assert(uuid.test(record.operationId) && record.name === `agenai-kernel-observer-${record.operationId}`);
  assert.equal(record.observationsPath, join(dirname(recordPath), 'observations.jsonl'));
  validateRegistry(record);
  if (record.observerRemoved) {
    if (record.containerId !== null) {
      assert(/^[a-f0-9]{64}$/u.test(record.containerId));
      const engine = new Engine(endpoint.slice(7), '1.52', { requestMs: 30_000 });
      assert.equal((await engine.request('GET', '/info')).data.ID, record.daemonId);
      assert.equal((await engine.request('GET', `/containers/${record.containerId}/json`, undefined, { allowed: [404] })).status, 404);
      assert(record.finalCensus?.kernelEmpty === true);
    }
    return record;
  }
  const owner = await openObserver({ endpoint, recordPath }, record); await owner.close(); return owner.record;
}
