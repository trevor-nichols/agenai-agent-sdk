import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Evidence } from '../../coordinator/evidence.mjs';
import { failure } from '../live/evidence.mjs';

// The launcher admits exactly the capture formats this module emits.
export const phaseCaptureFormat = 'agenai.sandbox-concurrency-phase-capture.v6';
export const captureFormat = 'agenai.sandbox-concurrency-capture.v5';

export class ConcurrencyEvidence extends Evidence {
  constructor(directory, maximumBytes, budget = {}) {
    super(directory, { maximumBytes, maximumFiles: budget.maximumEvidenceFiles ?? 8192,
      maximumEvents: budget.maximumMessages ?? 2048 });
  }
  async close() {
    const failures = [];
    try { await this.tail; } catch (error) { failures.push(error); }
    for (const [name, { handle }] of this.handles) {
      try { await handle.sync(); } catch (error) { failures.push(error); }
      try { await handle.close(); this.handles.delete(name); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Original concurrency evidence writes or descriptor cleanup failed.');
  }
}

/** A closed phase ledger: missing bytes or phases fail, including a successful later cleanup. */
export function createPhaseCollector({ evidence, budget, responseBytes, requiredPhases, onFailure }) {
  const phases = [], failures = [], active = new Set(), streams = new Map(), coverage = new Map();
  const counts = { engine: 0, 'engine-terminal': 0, vm: 0, 'vm-control': 0 };
  const limits = { engine: budget.maximumEngineResponses, 'engine-terminal': budget.maximumEngineTerminals,
    vm: budget.maximumVmFrames, 'vm-control': budget.maximumVmControlFrames };
  const indexName = 'observation-index.jsonl', indexHash = createHash('sha256');
  let current = null, sequence = 0, closed = false, indexBytes = 0, nativeWireBytes = 0, incomplete = 0, cutBinding = null;
  let indexTail = Promise.resolve();
  const retain = (operation) => {
    const actual = operation(); active.add(actual);
    void actual.finally(() => active.delete(actual)).catch(() => {}); return actual;
  };
  const failed = (error) => {
    const first = failures.length === 0;
    if (failures.length < 32) failures.push(failure(error));
    if (first) onFailure?.(error);
  };
  indexTail = evidence.append(indexName, Buffer.alloc(0), budget.maximumObservationIndexBytes);
  void indexTail.catch(failed);
  const collector = {
    get current() { return current; },
    get failed() { return failures.length !== 0; },
    // Set immediately after the selected SIGKILL: later reader-side delivery failures are that cut's effect.
    get cutBound() { return cutBinding !== null; },
    stream(kind, identity, value) {
      try {
        const key = `${kind}-${identity.containerId}`;
        let entry = streams.get(key);
        if (!entry) {
          assert(streams.size < 2 * budget.maximumObserverAttachments, 'Native stream identity census exceeded its admitted lifetime.');
          entry = { kind, identity: structuredClone(identity), name: `${key}.bin`, bytes: 0, chunks: 0, hash: createHash('sha256') };
          streams.set(key, entry);
        }
        nativeWireBytes += value.byteLength;
        assert(nativeWireBytes <= budget.maximumNativeWireBytes, 'Native wire lifetime exceeded its calculated byte capacity.');
        const original = Buffer.from(value); entry.bytes += original.length; entry.chunks++; entry.hash.update(original);
        return retain(async () => {
          try { await evidence.append(entry.name, original, evidence.maximumBytes); }
          catch (error) { failed(error); throw error; }
        });
      } catch (error) { failed(error); throw error; }
    },
    hasNativeForCurrent(ids) {
      const selected = ids.map((id) => coverage.get(current?.sequence)?.native.get(id)).find(Boolean);
      if (selected) current.selectedObserver = { containerId: selected.identity.containerId, sequence: selected.identity.sequence,
        controlPhase: selected.phase, original: selected.original };
      return Boolean(selected);
    },
    // A selected cut freezes the worker whose coordinator drives observer controls, so the wait ends without
    // coverage; close decides whether the verified cut supersedes it.
    async awaitNative(ids, { timeoutMs, signal }) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        if (collector.hasNativeForCurrent(ids)) return true;
        if (signal.aborted) return false;
        if (performance.now() >= deadline) throw new Error('Required phase lacks complete original native observer bytes.');
        await delay(25);
      }
    },
    // Only observations the worker still awaited at the verified cut may lack native coverage.
    bindCut({ cut, outstanding }) {
      assert(cutBinding === null && !closed, 'A selected cut binds the phase collector once, before close.');
      assert(Array.isArray(outstanding) && outstanding.length <= 16
        && outstanding.every(({ id, kind }) => Number.isSafeInteger(id) && typeof kind === 'string'), 'Outstanding cut requests are malformed.');
      cutBinding = { cut: structuredClone(cut), observations: new Set(outstanding.filter(({ kind }) => kind === 'observation').map(({ id }) => id)) };
    },
    async phase(name, detail = {}) {
      try {
        assert(!closed && phases.length < budget.maximumPhases, 'Phase collector is closed or exhausted.');
        const phase = { sequence: phases.length + 1, name, at: new Date().toISOString(), ...structuredClone(detail) };
        current = phase; phases.push(phase);
        coverage.set(phase.sequence, { engine: false, native: new Map() });
        await evidence.file(`phase-${String(phase.sequence).padStart(3, '0')}.json`, phase, 65_536);
        return phase;
      } catch (error) { failed(error); throw error; }
    },
    bytes(kind, identity, value, enteredPhase = current) {
      const phase = enteredPhase;
      if (!Object.hasOwn(counts, kind) || sequence >= budget.maximumObservations || counts[kind] >= limits[kind]) {
        const error = new Error('Full observation lifetime exceeded the calculated capacity.'); failed(error); throw error;
      }
      counts[kind]++;
      const ordinal = ++sequence;
      const { failure: observationFailure, ...observationIdentity } = identity;
      const item = { sequence: ordinal, kind, identity: structuredClone(observationIdentity), phase: phase?.sequence ?? null,
        phaseName: phase?.name ?? null, completionPhase: current?.sequence ?? null, at: new Date().toISOString(), original: null, completeness: 'pending',
        failure: observationFailure ?? null };
      let cause;
      const writing = (async () => {
        try {
          assert(!closed, 'Original byte capture requires an open collector.');
          assert(value instanceof Uint8Array && value.byteLength <= responseBytes, 'Original observation exceeds its admitted raw-byte bound.');
          const original = await evidence.file(`raw-${String(ordinal).padStart(5, '0')}.bin`, Buffer.from(value), responseBytes);
          item.original = original;
          item.completeness = identity.complete !== false ? 'complete' : identity.abandoned === true ? 'abandoned' : 'incomplete';
          if (item.completeness === 'incomplete') incomplete++;
        } catch (error) { cause = error; item.completeness = 'incomplete'; item.failure = failure(error); incomplete++; failed(error); }
      })();
      const appended = indexTail.then(async () => {
        await writing;
        const bytes = Buffer.from(`${JSON.stringify(item)}\n`);
        assert(bytes.length <= budget.maximumObservationMetadataBytes, 'Original observation metadata exceeds its admitted envelope.');
        assert(indexBytes + bytes.length <= budget.maximumObservationIndexBytes, 'Original observation index exceeded its calculated byte capacity.');
        await evidence.append(indexName, bytes, budget.maximumObservationIndexBytes);
        indexBytes += bytes.length; indexHash.update(bytes);
        if (item.completeness === 'complete') {
          const phaseCoverage = coverage.get(item.phase);
          if (kind === 'engine' && item.identity.complete !== false && phaseCoverage) phaseCoverage.engine = true;
          if (kind === 'vm' && item.identity.kind === 'observation' && item.identity.completeGraph === true && phaseCoverage) {
            assert(phaseCoverage.native.has(item.identity.containerId) || phaseCoverage.native.size < budget.maximumObserverAttachments,
              'Per-phase native coverage exceeded its original observer census.');
            phaseCoverage.native.set(item.identity.containerId, item);
          }
        }
      });
      indexTail = appended;
      return retain(async () => {
        try {
          const [, ledger] = await Promise.allSettled([writing, appended]);
          if (ledger.status === 'rejected') throw ledger.reason;
          if (cause) throw cause;
          return item.original;
        }
        catch (error) { failed(error); throw error; }
      });
    },
    fail: failed,
    async close() {
      while (active.size) await Promise.allSettled([...active]);
      try { await indexTail; } catch (error) { failed(error); }
      try { await evidence.tail; } catch (error) { failed(error); }
      closed = true;
      const missing = requiredPhases.filter((name) => !phases.some((phase) => phase.name === name));
      const uncovered = phases.filter((phase) => phase.captureRequired === true
        && !coverage.get(phase.sequence).engine)
        .map(({ sequence: ordinal, name }) => ({ sequence: ordinal, name }));
      const lackingNative = phases.filter((phase) => phase.vmCandidates?.length
        && !phase.vmCandidates.some((id) => coverage.get(phase.sequence).native.has(id)));
      const superseded = (phase) => cutBinding?.observations.has(phase.requestId) === true;
      const missingNative = lackingNative.filter((phase) => !superseded(phase))
        .map((phase) => ({ phase: phase.sequence, name: phase.name, candidates: phase.vmCandidates }));
      const supersededNative = lackingNative.filter(superseded).map((phase) => ({ phase: phase.sequence, name: phase.name,
        candidates: phase.vmCandidates, requestId: phase.requestId, cut: cutBinding.cut }));
      const rawStreams = [...streams.values()].map(({ hash, ...entry }) => ({ ...entry, sha256: hash.digest('hex') }));
      const observationIndex = { format: 'agenai.sandbox-concurrency-observations.v4', path: join(evidence.directory, indexName),
        bytes: indexBytes, sha256: indexHash.digest('hex'), records: sequence, incomplete };
      const report = { format: phaseCaptureFormat, phases, counts, observationIndex, rawStreams, failures, missing, uncovered, missingNative, supersededNative,
        completeness: failures.length || missing.length || uncovered.length || missingNative.length ? 'incomplete' : 'complete',
        truncation: failures.length ? 'capture_failed_or_capacity_exhausted' : 'none',
        scope: 'Complete bounded original Engine response bodies and native observer frames correlated to entered workflow/checkpoint phases. Observations the worker still awaited at a verified selected cut are listed as superseded native coverage, never as covered. This diagnostic capture perturbs timing and is not an atomic continuous topology snapshot.' };
      const index = await evidence.file('phase-capture.json', report, budget.maximumPhaseIndexBytes);
      return { format: report.format, completeness: report.completeness, truncation: report.truncation, counts, observationIndex,
        phases: phases.length, failures, missing, uncovered, missingNative, supersededNative, index };
    },
  };
  return collector;
}

/** Mature trace-proxy callbacks retain all bounded bodies/frames without a prefix. */
export function createConcurrencyCapture({ collector, budget, observerIds, maxResponseBytes }) {
  const attachments = [];
  const requestPhases = new Map();
  const active = new Set();
  let requests = 0, completed = 0, abandoned = 0, uncapturedResponses = 0, enteredRequests = 0, terminalRequests = 0, responseAbsent = 0, notForwardedRequests = 0, uncapturedTerminals = 0;
  let lastEnteredTraceId = -1;
  const work = (action) => {
    const actual = action(); active.add(actual);
    void actual.finally(() => active.delete(actual)).catch((error) => collector.fail(error)); return actual;
  };
  return {
    observeRequest({ method, target, traceId }) {
      if (method !== 'GET') return;
      if (collector.failed) return;
      if (requestPhases.size >= budget.proxy.maxRequestLifecycles || enteredRequests >= budget.maximumEngineTerminals) {
        collector.fail(new Error('Original Engine request phase census exceeded forwarding capacity.')); return;
      }
      if (!Number.isSafeInteger(traceId) || traceId <= lastEnteredTraceId || typeof target !== 'string') {
        collector.fail(new Error('Original Engine request entry identity is missing, repeated or out of order.')); return;
      }
      lastEnteredTraceId = traceId; enteredRequests++;
      requestPhases.set(traceId, { method, target, phase: collector.current, body: null });
    },
    observeResponseBody({ method, target, status, traceId }) {
      if (method !== 'GET') return;
      if (collector.failed) { uncapturedResponses++; return; }
      if (requests >= budget.maximumEngineResponses) {
        collector.fail(new Error('Original Engine response lifetime exceeded its calculated capacity.')); uncapturedResponses++; return;
      }
      const entered = requestPhases.get(traceId), phase = entered?.phase ?? collector.current;
      const entry = { method, target, status, traceId, complete: false, bytes: 0 };
      requests++; const chunks = []; let responseFailure;
      return {
        async body(chunk) {
          entry.bytes += chunk.length;
          if (entry.bytes <= maxResponseBytes) chunks.push(Buffer.from(chunk));
          else { responseFailure ??= new Error('Original Engine response exceeded its complete-byte capacity.'); collector.fail(responseFailure); }
        },
        // An unfinished body is accepted only when the proxy attests its client closed first: the proxy never ended
        // that response, so no client consumed it. It is retained, but never covers a phase.
        complete({ complete, abandoned: clientClosed = false }) { return work(async () => {
          entry.complete = complete && entry.bytes <= maxResponseBytes;
          entry.abandoned = !complete && clientClosed === true && responseFailure === undefined;
          const original = Buffer.concat(chunks);
          if (entry.complete && new URL(target, 'http://engine.invalid').pathname === '/v1.52/networks') {
            try {
              const networks = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original));
              assert(Array.isArray(networks) && networks.length <= budget.networkTopology.maximumNetworks
                && networks.every((network) => typeof network?.Id === 'string')
                && new Set(networks.map(({ Id }) => Id)).size === networks.length,
              'Captured Engine network-list identities exceed maxEngineNetworks or are incomplete.');
            } catch (error) { responseFailure = error; collector.fail(error); entry.complete = false; }
          }
          if (!entry.complete && !entry.abandoned) { responseFailure ??= new Error(`Original Engine response incomplete: ${target}`); collector.fail(responseFailure); }
          const stored = await collector.bytes('engine', { method, target, status, traceId, complete: entry.complete,
            ...(entry.abandoned ? { abandoned: true } : {}), ...(responseFailure ? { failure: failure(responseFailure) } : {}) }, original, phase);
          if (entered) entered.body = { status, complete: entry.complete, abandoned: entry.abandoned, bytes: entry.bytes, original: stored };
          if (entry.complete) completed++; else if (entry.abandoned) abandoned++;
        }); },
      };
    },
    observeRequestSettled(receipt) { return work(async () => {
      let record;
      const entered = requestPhases.get(receipt?.traceId);
      try {
        assert(receipt?.bytes instanceof Uint8Array && receipt.bytes.byteLength <= 2048, 'Original HTTP terminal trace bytes are missing or exceed their envelope.');
        const original = receipt.original;
        assert(original && typeof original.path === 'string' && Number.isSafeInteger(original.offset) && original.offset >= 0
          && original.bytes === receipt.bytes.byteLength && original.sha256 === createHash('sha256').update(receipt.bytes).digest('hex'),
        'Original HTTP terminal trace identity does not match its serialized bytes.');
        record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receipt.bytes));
        if (record.method !== 'GET') { assert(!entered, 'Original GET terminal was replaced by a different HTTP method.'); return; }
        if (!entered && collector.failed) { uncapturedTerminals++; return; }
        assert(entered && record.id === receipt.traceId && record.method === entered.method && record.target === entered.target,
          'Original GET terminal is missing, repeated or differs from its entered identity.');
        const notForwarded = record.terminal?.kind === 'http_not_forwarded';
        assert(record.terminal?.downstreamResponseClosed === true && typeof record.finishedAt === 'string',
          'Original GET terminal did not confirm joined downstream ownership.');
        if (notForwarded) {
          assert(record.terminal.upstreamAcquisition === 'not_entered' && !Object.hasOwn(record.terminal, 'upstreamRequestClosed')
            && ['downstream_closed', 'proxy_closing', 'request_observer_failed'].includes(record.terminal.reason),
          'Original pre-dispatch terminal did not preserve absent upstream acquisition and its exact local reason.');
        } else assert(record.terminal.kind === 'http' && record.terminal.upstreamRequestClosed === true,
          'Original GET terminal did not confirm joined upstream HTTP ownership.');
        const absent = record.status === null;
        assert(!notForwarded || absent, 'A pre-dispatch terminal cannot carry a response status.');
        if (absent) {
          assert(entered.body === null && record.uploadedBytes === 0 && record.upstreamBodyBytes === 0 && record.forwardedBodyBytes === 0
            && typeof record.failure?.name === 'string' && typeof record.failure?.message === 'string',
          'No-response GET terminal lacks its original zero-body failure observation.');
        } else {
          assert(Number.isInteger(record.status) && record.status >= 100 && record.status <= 599 && entered.body
            && entered.body.status === record.status && entered.body.bytes === record.upstreamBodyBytes,
          'Response-present GET terminal lacks its correlated original body observation.');
          if (entered.body.abandoned) assert(record.terminal.downstreamAbandoned === true && record.fault === null
            && record.failure !== null && record.forwardedBodyBytes === record.upstreamBodyBytes,
          'An abandoned GET body lacks its proxy-attested client close, or the proxy withheld upstream bytes.');
        }
        await collector.bytes('engine-terminal', { traceId: record.id, method: record.method, target: record.target, status: record.status,
          outcome: notForwarded ? 'not_forwarded' : absent ? 'response_absent' : entered.body.abandoned ? 'response_abandoned' : 'response_present',
          scope: 'local_request_lifecycle', complete: true,
          requestFailure: record.failure, trace: original, body: entered.body?.original ?? null }, receipt.bytes, entered.phase);
        terminalRequests++; if (notForwarded) notForwardedRequests++; else if (absent) responseAbsent++;
      } catch (error) {
        collector.fail(error);
        if (entered && receipt?.bytes instanceof Uint8Array && receipt.bytes.byteLength <= 2048) {
          try { await collector.bytes('engine-terminal', { traceId: receipt.traceId, scope: 'local_request_lifecycle', outcome: 'unconfirmed',
            complete: false, failure: failure(error) }, receipt.bytes, entered.phase); } catch (captureError) { collector.fail(captureError); }
        }
      } finally { if (entered) requestPhases.delete(receipt.traceId); }
    }); },
    observeUpgrade({ method, target, status, record, connection }) {
      const match = /^\/v1\.52\/containers\/([a-f0-9]{64})\/attach\?/u.exec(target);
      if (method !== 'POST' || status !== 101 || !match || !observerIds.has(match[1])) return;
      if (collector.failed) return;
      if (attachments.length >= budget.maximumObserverAttachments) {
        collector.fail(new Error('Native attachment lifetime exceeded its original observer census.')); return;
      }
      const identity = { containerId: match[1], ...observerIds.get(match[1]) };
      const entry = { identity, traceId: record.id, frames: 0, bytes: 0, controls: 0, complete: false, connection };
      attachments.push(entry);
      let multiplex = Buffer.alloc(0), line = Buffer.alloc(0), control = Buffer.alloc(0), controlPhase = null;
      const controls = new Map();
      return {
        input(chunk) {
          if (collector.failed) { entry.captureFailed = true; return; }
          const inputPhase = collector.current;
          return work(async () => {
          try {
            await collector.stream('vm-control-wire', identity, chunk);
            if (!control.length) controlPhase = inputPhase;
            control = Buffer.concat([control, chunk]); assert(control.length <= 65_536);
            for (;;) {
              const end = control.indexOf(10); if (end < 0) break;
              const original = Buffer.from(control.subarray(0, end + 1)); control = control.subarray(end + 1);
              assert(original.length <= 4096);
              const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original));
              assert.equal(frame.protocol, 'agenai.sandbox.desktop-route-observer.v1'); entry.controls++;
              const phase = controlPhase; controlPhase = control.length ? inputPhase : null;
              if (frame.kind === 'observe') {
                assert(controls.size === 0, 'Native observation control is already awaiting its original reply.');
                controls.set(frame.sequence, phase);
              }
              await collector.bytes('vm-control', { ...identity, kind: frame.kind, sequence: frame.sequence }, original, phase);
            }
          } catch (error) { collector.fail(error); }
        }); },
        response(chunk, forward) { return work(async () => {
          if (collector.failed) { entry.captureFailed = true; await forward(chunk); return; }
          try {
            await collector.stream('vm-response-wire', identity, chunk);
            entry.bytes += chunk.length; multiplex = Buffer.concat([multiplex, chunk]);
            assert(multiplex.length <= maxResponseBytes + 65_544, 'Native observer multiplex frame capacity exhausted.');
            while (multiplex.length >= 8) {
              assert(multiplex[0] === 1 && multiplex.subarray(1, 4).equals(Buffer.alloc(3)), 'Native observer emitted an invalid frame or stderr.');
              const size = multiplex.readUInt32BE(4); assert(size <= maxResponseBytes);
              if (multiplex.length < size + 8) break;
              line = Buffer.concat([line, multiplex.subarray(8, size + 8)]); multiplex = multiplex.subarray(size + 8);
              for (;;) {
                const end = line.indexOf(10); if (end < 0) break;
                const original = Buffer.from(line.subarray(0, end + 1)); line = line.subarray(end + 1);
                const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original));
                assert.equal(frame.protocol, 'agenai.sandbox.desktop-route-observer.v1'); entry.frames++;
                const phase = controls.get(frame.sequence) ?? null; controls.delete(frame.sequence);
                await collector.bytes('vm', { ...identity, kind: frame.kind, sequence: frame.sequence,
                  completeGraph: frame.document?.format === 'agenai.desktop-vm-network.v1' && frame.document?.complete === true }, original, phase);
              }
              assert(line.length <= maxResponseBytes, 'Native observer line capacity exhausted.');
            }
          } catch (error) { collector.fail(error); }
          finally { entry.partial = { multiplex: multiplex.length, line: line.length, control: control.length }; }
          try { await forward(chunk); }
          catch (error) {
            // The selected cut killed the original reader. The bytes are already retained; the tunnel ends here.
            if (!collector.cutBound) throw error;
            entry.severed = { at: new Date().toISOString(), failure: failure(error), pendingControls: [...controls.keys()] };
            return 'close';
          }
        }); },
      };
    },
    async close({ absentContainers = new Set() } = {}) {
      while (active.size) await Promise.allSettled([...active]);
      for (const entry of attachments) {
        const state = entry.connection(); delete entry.connection;
        entry.finalConnection = state;
        // A cut-severed stream may end inside exactly one awaited reply, and only once its observer is exactly absent.
        const severedReply = entry.severed !== undefined && entry.partial.control === 0 && entry.severed.pendingControls.length === 1
          && absentContainers.has(entry.identity.containerId);
        entry.complete = !entry.captureFailed && entry.frames > 0
          && (severedReply || !Object.values(entry.partial ?? {}).some((bytes) => bytes !== 0))
          && state.downstream.destroyed && state.upstream.destroyed;
        if (!entry.complete) collector.fail(new Error('Original native observer stream is incomplete or remains unjoined.'));
      }
      if (requestPhases.size) collector.fail(new Error('Original Engine request phase receipts remain without a captured terminal.'));
      requestPhases.clear();
      return { format: captureFormat, requests, completed, abandoned, incomplete: requests - completed - abandoned, uncapturedResponses,
        enteredRequests, terminalRequests, responseAbsent, notForwardedRequests, uncapturedTerminals, attachments,
        completeness: !collector.failed && requests === completed + abandoned && enteredRequests === terminalRequests
        && attachments.every(({ complete }) => complete) ? 'complete' : 'incomplete' };
    },
  };
}
