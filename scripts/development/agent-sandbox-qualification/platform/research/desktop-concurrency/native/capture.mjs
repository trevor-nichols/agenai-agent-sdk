import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha, failure } from './installed.mjs';

const limits = Object.freeze({ entries: 4096, bytes: 128 * 1024 ** 2, responseBytes: 4 * 1024 ** 2 });

export async function capture({ directory, engine, namespacePrefix, phase }) {
  await mkdir(directory, { mode: 0o700 });
  const record = { format: 'agenai.desktop-concurrency-research-capture.v1', limits, entries: [], failures: [], bytes: 0,
    completeness: 'open', scope: 'Every complete selected Engine JSON response and owned observer line until closure; awaited capture can perturb timing.' };
  let ordinal = 0;
  const streams = [];
  const retain = async (kind, raw, metadata) => {
    assert(record.entries.length < limits.entries, 'Research capture entry bound exhausted.');
    assert(raw.length <= limits.responseBytes && record.bytes + raw.length <= limits.bytes, 'Research capture byte bound exhausted.');
    const path = join(directory, `${String(++ordinal).padStart(5, '0')}-${kind}.json`);
    const entry = { kind, path, phase: phase(), observedAt: new Date().toISOString(), bytes: raw.length, sha256: sha(raw), ...metadata };
    record.entries.push(entry); record.bytes += raw.length;
    await writeFile(path, raw, { mode: 0o600, flag: 'wx' });
  };
  const failed = (error) => {
    if (record.failures.length < 32) record.failures.push(failure(error));
    record.completeness = 'failed';
  };
  return {
    observeResponseBody({ method, target, status, traceId }) {
      if (!(method === 'GET' && (/^(?:\/v1\.52)?\/(?:networks(?:\/|\?|$)|info$|containers\/[^/]+\/json$)/u.test(target))
        || method === 'POST' && /\/create(?:\?|$)/u.test(target))) return;
      let chunks = [], bytes = 0, disabled = false;
      return {
        body(chunk) {
          if (disabled) return;
          bytes += chunk.length;
          if (bytes > limits.responseBytes) { disabled = true; chunks = []; failed(new Error('Research response exceeds bound.')); }
          else chunks.push(Buffer.from(chunk));
        },
        async complete({ complete }) {
          if (disabled) return;
          try {
            assert(complete, 'Selected Engine response was incomplete.');
            const raw = Buffer.concat(chunks); chunks = [];
            if (!raw.length) return;
            JSON.parse(raw.toString('utf8'));
            await retain('engine', raw, { method, target, status, traceId });
          } catch (error) { failed(error); }
        },
      };
    },
    observeUpgrade({ target, record: trace }) {
      const match = /^\/v1\.52\/containers\/([a-f0-9]{64})\/attach\?/u.exec(target);
      if (!match) return;
      const identity = engine.request('GET', `/containers/${match[1]}/json`).then(({ data }) => {
        const labels = data.Config.Labels;
        if (labels['ai.agen.sandbox.role'] !== 'route_observer') return null;
        assert(labels['ai.agen.sandbox.namespace'].startsWith(namespacePrefix));
        return { containerId: data.Id, namespace: labels['ai.agen.sandbox.namespace'], operationId: labels['ai.agen.sandbox.operation'] };
      });
      void identity.catch(failed);
      let multiplex = Buffer.alloc(0), lines = Buffer.alloc(0), disabled = false;
      streams.push(() => ({ containerId: match[1], multiplexBytes: multiplex.length, lineBytes: lines.length, disabled }));
      return {
        input() {},
        async response(chunk, forward) {
          try {
            const original = await identity;
            if (!original || disabled) return;
            multiplex = Buffer.concat([multiplex, chunk]);
            assert(multiplex.length <= limits.responseBytes + 65544);
            while (multiplex.length >= 8) {
              const channel = multiplex[0], size = multiplex.readUInt32BE(4);
              assert([1, 2].includes(channel) && multiplex.subarray(1, 4).equals(Buffer.alloc(3)));
              assert(size <= limits.responseBytes);
              if (multiplex.length < size + 8) break;
              assert.equal(channel, 1, 'Observer stderr is not a successful observation.');
              lines = Buffer.concat([lines, multiplex.subarray(8, size + 8)]);
              multiplex = multiplex.subarray(size + 8);
              assert(lines.length <= limits.responseBytes);
              for (;;) {
                const end = lines.indexOf(10);
                if (end < 0) break;
                const raw = lines.subarray(0, end + 1); lines = lines.subarray(end + 1);
                const frame = JSON.parse(raw.toString('utf8'));
                assert.equal(frame.protocol, 'agenai.sandbox.desktop-route-observer.v1');
                await retain('observer', raw, { ...original, traceId: trace.id, frameKind: frame.kind, sequence: frame.sequence });
              }
            }
          } catch (error) { disabled = true; failed(error); }
          finally { await forward(chunk); }
        },
      };
    },
    async close() {
      record.streams = streams.map((state) => state());
      for (const state of record.streams) if (state.multiplexBytes || state.lineBytes) failed(new Error('Research observer stream ended with an incomplete frame.'));
      record.completeness = record.failures.length ? 'failed' : 'complete';
      await writeFile(join(directory, 'index.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      return { entries: record.entries.length, bytes: record.bytes, completeness: record.completeness, failures: record.failures };
    },
  };
}
