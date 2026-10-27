import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { failure, json, jsonWriter } from '../live/evidence.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const limits = Object.freeze({ networks: 26, inspectionsPerNetwork: 16, bodyBytes: 1024 ** 2,
  rawBytes: 64 * 1024 ** 2, indexBytes: 4 * 1024 ** 2, failures: 64,
  candidateResponses: 26 * 16 * 256, activeResponses: 16, incompleteResponses: 26 * 16 });

export async function createEngineNetworkCapture({ directory, profile, namespacePrefix, workloadImage, source }) {
  await mkdir(directory, { mode: 0o700 });
  const indexPath = join(directory, 'index.json'); const writeIndex = jsonWriter(indexPath);
  const record = { format: 'agenai.sandbox-platform-engine-network-capture.v1', source, limits, indexPath,
    scope: 'First sixteen complete exact-ID inspection bodies per original SDK network; no route correctness or acceptance inference. Awaited diagnostic writes may perturb timing.',
    ownerCorrelation: 'Exact trace identity and inspected original labels; controller checkpoints require independent evidence correlation.',
    startedAt: new Date().toISOString(), networks: [], candidates: 0, incomplete: [], ignoredResponses: 0, skippedAfterPrefix: 0,
    rawBytes: 0, filesEntered: 0, filesClosed: 0, failures: [], failuresTruncated: false, joined: false, status: 'running' };
  const active = new Set(); let closing;
  const failed = (error, stage, networkId) => {
    if (record.failures.length < limits.failures) record.failures.push({ stage, networkId, failure: failure(error) });
    else record.failuresTruncated = true;
  };
  const save = async () => {
    try { assert(Buffer.byteLength(json(record)) <= limits.indexBytes, 'Engine capture index exceeds four MiB.'); await writeIndex(record); }
    catch (error) { failed(error, 'index-write', null); }
  };
  await save();
  return {
    indexPath,
    observeResponseBody({ method, target, status, traceId }) {
      const match = /^\/v1\.52\/networks\/([a-f0-9]{64})$/u.exec(target);
      if (method !== 'GET' || status !== 200 || !match) return;
      const networkId = match[1]; const known = record.networks.find(({ id }) => id === networkId);
      if (record.candidates >= limits.candidateResponses || active.size >= limits.activeResponses) {
        failed(new Error('Engine capture candidate response census is exhausted.'), 'response-entry', networkId); return;
      }
      record.candidates++;
      if (known?.inspections.length === limits.inspectionsPerNetwork) { record.skippedAfterPrefix++; return; }
      if (closing) { failed(new Error('Engine capture admitted a response after closure.'), 'response-entry', networkId); return; }
      const enteredAt = new Date().toISOString(); const joined = Promise.withResolvers(); active.add(joined.promise);
      let chunks = [], bytes = 0, disabled = false, completion;
      return {
        body(chunk) {
          if (disabled) return;
          try {
            bytes += chunk.length; assert(bytes <= limits.bodyBytes, 'Engine inspection response exceeds one MiB.');
            chunks.push(Buffer.from(chunk));
          } catch (error) { failed(error, 'body-read', networkId); disabled = true; chunks = []; }
        },
        complete({ complete }) {
          if (completion) return completion;
          completion = (async () => {
            try {
              if (disabled) return;
              const raw = Buffer.concat(chunks); chunks = [];
              if (!complete) {
                assert(record.incomplete.length < limits.incompleteResponses, 'Engine capture incomplete-response census is exhausted.');
                record.incomplete.push({ traceId, method, target, status, enteredAt, completedAt: new Date().toISOString(),
                  bytes: raw.length, sha256: sha(raw), disposition: 'incomplete_unconfirmed',
                  ownerIdentity: 'unconfirmed', retainedAsCompleteInspection: false });
                await save(); return;
              }
              const actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
              assert(actual && typeof actual === 'object' && !Array.isArray(actual)); assert.equal(actual.Id, networkId);
              const labels = actual.Labels ?? {};
              if (labels['ai.agen.sandbox.role'] !== 'network' || labels['ai.agen.sandbox.backend'] !== 'agenai-docker'
                || typeof labels['ai.agen.sandbox.namespace'] !== 'string' || !labels['ai.agen.sandbox.namespace'].startsWith(namespacePrefix)) {
                record.ignoredResponses++; return;
              }
              assert.equal(labels['ai.agen.sandbox.revision'], `engine-1.52-v6-${profile}`);
              assert.equal(labels['ai.agen.sandbox.image'], workloadImage); assert(uuid.test(labels['ai.agen.sandbox.operation']));
              for (const name of ['record', 'configuration', 'policy']) assert(digest.test(labels[`ai.agen.sandbox.${name}`]));
              assert(Buffer.byteLength(JSON.stringify(labels)) <= 16 * 1024, 'Original network label evidence exceeds its bounded index envelope.');
              let network = record.networks.find(({ id }) => id === networkId);
              if (!network) {
                assert(record.networks.length < limits.networks, 'Engine capture exceeds its original network-owner census.');
                network = { id: networkId, labels: structuredClone(labels), inspections: [], prefixLimitReached: false }; record.networks.push(network);
              } else assert.deepEqual(labels, network.labels, 'Original network labels changed between retained inspections.');
              if (network.inspections.length === limits.inspectionsPerNetwork) { record.skippedAfterPrefix++; return; }
              assert(record.rawBytes + raw.length <= limits.rawBytes, 'Engine capture exceeds its global raw-byte bound.');
              const ordinal = network.inspections.length + 1;
              const item = { ordinal, traceId, method, target, status, enteredAt, completedAt: new Date().toISOString(),
                path: join(directory, `${networkId}-${String(ordinal).padStart(2, '0')}.json`),
                bytes: raw.length, sha256: sha(raw), state: 'write-entered' };
              network.inspections.push(item); record.rawBytes += raw.length; record.filesEntered++; await save();
              let file;
              try { file = await open(item.path, 'wx', 0o600); await file.writeFile(raw); await file.sync(); item.state = 'written'; }
              finally { if (file) { await file.close(); record.filesClosed++; } }
              item.state = 'closed'; network.prefixLimitReached = ordinal === limits.inspectionsPerNetwork; await save();
            } catch (error) { failed(error, 'inspection-completion', networkId); }
            finally { chunks = []; joined.resolve(); active.delete(joined.promise); }
          })(); return completion;
        },
      };
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        while (active.size) await Promise.allSettled([...active]);
        record.joined = true; record.finishedAt = new Date().toISOString();
        record.status = record.failures.length || record.failuresTruncated ? 'failed' : 'captured'; await save();
        if (record.failures.length || record.failuresTruncated) { record.status = 'failed'; await save(); }
        const bytes = await readFile(indexPath);
        return { status: record.status, indexPath, bytes: bytes.length, sha256: sha(bytes), networks: record.networks.length,
          inspectionFiles: record.filesEntered, rawBytes: record.rawBytes, filesClosed: record.filesClosed,
          incompleteResponses: record.incomplete.length, joined: record.joined, failures: record.failures.length,
          limits, scope: record.scope, ownerCorrelation: record.ownerCorrelation };
      })(); return closing;
    },
  };
}
