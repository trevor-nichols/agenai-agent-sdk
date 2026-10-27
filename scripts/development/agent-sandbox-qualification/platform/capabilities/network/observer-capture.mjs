import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../../../engine.mjs';
import { failure, json, jsonWriter } from '../live/evidence.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const protocol = 'agenai.sandbox.desktop-route-observer.v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const limits = Object.freeze({ observers: 26, observationsPerObserver: 16, lineBytes: 4 * 1024 ** 2,
  observationBytes: 64 * 1024 ** 2, indexBytes: 4 * 1024 ** 2, inspectionBytes: 64 * 1024,
  controlCommands: 128, controlLineBytes: 4096, attachmentCandidates: 128, failures: 64 });

export async function createRouteObserverCapture({ directory, endpoint, profile, namespacePrefix, workloadImage,
  observerImage, observerUser, configuration, requestMs, source }) {
  await mkdir(directory, { mode: 0o700 });
  const indexPath = join(directory, 'index.json'); const writeIndex = jsonWriter(indexPath);
  const engine = new Engine(endpoint.slice(7), '1.52', { requestMs, outputBytes: limits.inspectionBytes });
  const record = { format: 'agenai.sandbox-platform-route-observer-capture.v1', source, limits, indexPath,
    scope: 'First sixteen complete observation lines per identified observer; no continuous capture or acceptance inference. Awaited disk capture may perturb timing.',
    startedAt: new Date().toISOString(), attachments: [], ignoredAttachments: 0, observationBytes: 0,
    filesEntered: 0, filesClosed: 0, failures: [], failuresTruncated: false, joined: false, status: 'running' };
  const candidates = []; const active = new Set(); let closing; let receipt;
  const failed = (error, stage, attachment) => {
    if (attachment) attachment.captureDisabled = true;
    if (record.failures.length < limits.failures) record.failures.push({ stage, containerId: attachment?.containerId ?? null, failure: failure(error) });
    else record.failuresTruncated = true;
  };
  const save = async () => {
    try { assert(Buffer.byteLength(json(record)) <= limits.indexBytes, 'Observer capture index exceeds its bounded size.'); await writeIndex(record); }
    catch (error) { failed(error, 'index-write'); }
  };
  const inspect = async (candidate) => {
    try {
      const actual = (await engine.request('GET', `/containers/${candidate.containerId}/json`)).data;
      assert.equal(actual.Id, candidate.containerId);
      const labels = actual.Config?.Labels ?? {};
      if (labels['ai.agen.sandbox.role'] !== 'route_observer') { record.ignoredAttachments++; return null; }
      assert.equal(actual.Image, observerImage); assert.equal(actual.Config.Image, observerImage);
      assert.equal(actual.Config.User, `${observerUser.uid}:${observerUser.gid}`);
      assert.equal(labels['ai.agen.sandbox.backend'], 'agenai-docker');
      assert.equal(labels['ai.agen.sandbox.revision'], `engine-1.52-v6-${profile}`);
      assert.equal(labels['ai.agen.sandbox.image'], workloadImage);
      assert(typeof labels['ai.agen.sandbox.namespace'] === 'string' && labels['ai.agen.sandbox.namespace'].startsWith(namespacePrefix));
      assert(uuid.test(labels['ai.agen.sandbox.operation']));
      const configured = actual.Config.Env.filter((value) => value.startsWith('AGENAI_DESKTOP_ROUTE_CONFIG='));
      assert.equal(configured.length, 1); assert(Buffer.byteLength(configured[0]) <= limits.controlLineBytes);
      assert.deepEqual(JSON.parse(configured[0].slice('AGENAI_DESKTOP_ROUTE_CONFIG='.length)), configuration);
      assert.equal(configuration.protocol, protocol);
      assert(record.attachments.length < limits.observers, 'Observer capture exceeds its exact owner census.');
      assert(!record.attachments.some(({ containerId }) => containerId === candidate.containerId), 'Original observer has repeated attachments.');
      const attachment = { containerId: candidate.containerId, traceId: candidate.traceId, target: candidate.target,
        namespace: labels['ai.agen.sandbox.namespace'], operationId: labels['ai.agen.sandbox.operation'], image: actual.Image,
        inspectedAt: new Date().toISOString(), inspection: actual, openedAt: candidate.openedAt,
        inputBytes: 0, responseBytes: 0, stdoutBytes: 0, stdoutLines: 0, control: [], observations: [],
        prefixLimitReached: false, controlPrefixLimitReached: false, captureDisabled: false, kernelScope: null };
      record.attachments.push(attachment); await save(); return attachment;
    } catch (error) { failed(error, 'identity-read'); return null; }
  };
  const work = (operation) => {
    const actual = operation(); active.add(actual);
    void actual.finally(() => active.delete(actual)).catch(() => {}); return actual;
  };
  const retain = async (attachment, line, frame) => {
    assert(line.length <= limits.lineBytes, 'Observer observation line exceeds four MiB.');
    assert(record.observationBytes + line.length <= limits.observationBytes, 'Observer capture exceeds its global raw-byte bound.');
    const ordinal = attachment.observations.length + 1;
    const item = { ordinal, sequence: frame.sequence, stdoutLine: attachment.stdoutLines,
      observedAt: new Date().toISOString(), bytes: line.length, sha256: sha(line),
      path: join(directory, `${attachment.containerId}-${String(ordinal).padStart(2, '0')}.jsonl`), state: 'write-entered' };
    record.observationBytes += line.length; record.filesEntered++; attachment.observations.push(item); await save();
    let file;
    try {
      file = await open(item.path, 'wx', 0o600); await file.writeFile(line); await file.sync(); item.state = 'written';
    } finally {
      if (file) { await file.close(); record.filesClosed++; }
    }
    item.state = 'closed'; await save();
    if (ordinal === limits.observationsPerObserver) attachment.prefixLimitReached = true;
  };
  const identifyFrame = (line) => {
    const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
    assert(frame && typeof frame === 'object' && !Array.isArray(frame)); assert.equal(frame.protocol, protocol);
    return frame;
  };
  await save();
  return {
    indexPath,
    observeUpgrade({ method, target, status, record: trace }) {
      const match = /^\/v1\.52\/containers\/([a-f0-9]{64})\/attach\?/u.exec(target);
      if (method !== 'POST' || status !== 101 || !match) return;
      if (closing || candidates.length >= limits.attachmentCandidates) {
        failed(new Error('Observer capture attachment census is closed or exhausted.'), 'attachment-entry'); return;
      }
      const candidate = { containerId: match[1], traceId: trace.id, target, openedAt: new Date().toISOString() };
      candidate.identity = inspect(candidate); candidates.push(candidate);
      let multiplex = Buffer.alloc(0), output = Buffer.alloc(0), input = Buffer.alloc(0);
      const consume = async (attachment, chunk) => {
        multiplex = Buffer.concat([multiplex, chunk]);
        assert(multiplex.length <= limits.lineBytes + 65544, 'Observer multiplex prefix exceeds its bounded receive size.');
        while (multiplex.length >= 8) {
          assert((multiplex[0] === 1 || multiplex[0] === 2) && multiplex.subarray(1, 4).equals(Buffer.alloc(3)), 'Invalid captured Docker stream header.');
          const length = multiplex.readUInt32BE(4); assert(length <= limits.lineBytes, 'Captured Docker frame exceeds four MiB.');
          if (multiplex.length < length + 8) break;
          const channel = multiplex[0], payload = multiplex.subarray(8, length + 8); multiplex = multiplex.subarray(length + 8);
          assert.equal(channel, 1, 'Route observer wrote stderr during diagnostic capture.');
          attachment.stdoutBytes += payload.length; output = Buffer.concat([output, payload]);
          while (!attachment.prefixLimitReached) {
            const end = output.indexOf(10);
            if (end < 0) { assert(output.length < limits.lineBytes, 'Captured observation line exceeds four MiB.'); break; }
            const line = output.subarray(0, end + 1); output = output.subarray(end + 1); attachment.stdoutLines++;
            const frame = identifyFrame(line);
            if (frame.kind === 'observation') {
              assert(Number.isSafeInteger(frame.sequence) && frame.sequence > 0, 'Captured observation lacks its exact sequence.');
              await retain(attachment, line, frame);
            }
          }
          if (attachment.prefixLimitReached) { multiplex = Buffer.alloc(0); output = Buffer.alloc(0); break; }
        }
      };
      return {
        input(chunk) { return work(async () => {
          const attachment = await candidate.identity; if (!attachment) return;
          attachment.inputBytes += chunk.length;
          if (attachment.captureDisabled || attachment.prefixLimitReached || attachment.controlPrefixLimitReached) return;
          try {
            input = Buffer.concat([input, chunk]); assert(input.length <= 65536, 'Captured control prefix exceeds 64 KiB.');
            for (;;) {
              const end = input.indexOf(10);
              if (end < 0) { assert(input.length < limits.controlLineBytes); break; }
              const line = input.subarray(0, end + 1); input = input.subarray(end + 1);
              assert(line.length <= limits.controlLineBytes); const frame = identifyFrame(line);
              assert(['observe', 'heartbeat', 'stop'].includes(frame.kind)); assert(Number.isSafeInteger(frame.sequence) && frame.sequence > 0);
              attachment.control.push({ kind: frame.kind, sequence: frame.sequence, bytes: line.length, sha256: sha(line), observedAt: new Date().toISOString() });
              if (attachment.control.length === limits.controlCommands) { attachment.controlPrefixLimitReached = true; input = Buffer.alloc(0); break; }
            }
          } catch (error) { failed(error, 'control-prefix', attachment); }
        }); },
        response(chunk, forward) { return work(async () => {
          try {
            const attachment = await candidate.identity;
            if (attachment) {
              attachment.responseBytes += chunk.length;
              if (!attachment.captureDisabled && !attachment.prefixLimitReached) {
                try { await consume(attachment, chunk); }
                catch (error) { failed(error, 'observation-prefix', attachment); multiplex = Buffer.alloc(0); output = Buffer.alloc(0); }
              }
              candidate.partial = { multiplexBytes: multiplex.length, stdoutLineBytes: output.length,
                multiplexSha256: sha(multiplex), stdoutLineSha256: sha(output) };
            }
          } finally { await forward(chunk); }
        }); },
      };
    },
    close(scopes) {
      if (closing) return closing;
      closing = (async () => {
        await Promise.allSettled(candidates.map(({ identity }) => identity));
        while (active.size) await Promise.allSettled([...active]);
        for (const attachment of record.attachments) {
          const scope = scopes.find(({ computeId }) => computeId === attachment.containerId);
          try {
            assert(scope, 'Captured observer never entered the independent kernel registry.');
            assert.equal(scope.role, 'route_observer'); assert.equal(scope.namespace, attachment.namespace);
            assert.equal(scope.operationId, attachment.operationId); assert.equal(scope.imageDigest, attachment.image);
            attachment.kernelScope = structuredClone(scope);
          } catch (error) { failed(error, 'kernel-scope-correlation', attachment); }
          attachment.partial = candidates.find(({ containerId }) => containerId === attachment.containerId).partial ?? null;
        }
        record.joined = true; record.finishedAt = new Date().toISOString();
        record.status = record.failures.length || record.failuresTruncated ? 'failed' : 'captured'; await save();
        if (record.failures.length || record.failuresTruncated) { record.status = 'failed'; await save(); }
        const bytes = await readFile(indexPath);
        receipt = { status: record.status, indexPath, bytes: bytes.length, sha256: sha(bytes), observers: record.attachments.length,
          observationFiles: record.filesEntered, observationBytes: record.observationBytes, filesClosed: record.filesClosed,
          joined: record.joined, failures: record.failures.length, limits, scope: record.scope };
        return receipt;
      })(); return closing;
    },
  };
}
