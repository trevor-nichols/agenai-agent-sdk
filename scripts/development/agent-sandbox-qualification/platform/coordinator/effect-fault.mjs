import assert from 'node:assert/strict';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { failure } from './evidence.mjs';

export function effectTarget(options, entry, fault) {
  if (!entry?.owner) return false;
  const resource = entry.owner.recoveryRecord.resources.find(({ role }) => role === fault.role);
  if (!resource) return false;
  const collection = resource.role === 'network' ? 'networks' : ['storage', 'egress_socket'].includes(resource.role) ? 'volumes' : 'containers';
  const target = new URL(options.path, 'http://qualification.invalid');
  if (fault.operation === 'create') return options.method === 'POST' && collection === 'containers'
    && target.pathname === '/v1.52/containers/create' && target.searchParams.get('name') === resource.name;
  if (resource.identity.kind !== 'identified') return false;
  const base = `/v1.52/${collection}/${encodeURIComponent(resource.identity.id)}`;
  return fault.operation === 'start' ? options.method === 'POST' && target.pathname === `${base}/start`
    : options.method === 'DELETE' && target.pathname === base;
}

export function installLostAcknowledgement({ socketPath, select, evidence, onResponseCut, onErrorDeliveryCut }) {
  const originalRequest = http.request; const originalGet = http.get;
  const report = { format: 'agenai.desktop-coordinator-lost-ack.v1', kind: 'lost_acknowledgement',
    scope: 'One real mutation response is consumed and retained completely before an explicit transport error reaches the unchanged installed caller. No successful callback or synthetic response reaches that caller.',
    selected: null, failures: [], complete: false, transportErrorIssued: false };
  let restored = false;
  http.request = function faultRequest(options, ...args) {
    const selected = !report.selected && options && typeof options === 'object' && options.socketPath === socketPath && select(options);
    const request = Reflect.apply(originalRequest, this, [options, ...args]);
    if (!selected) return request;
    report.selected = { method: options.method, target: options.path, dispatchedAt: new Date().toISOString(),
      responseAt: null, status: null, bytes: 0, body: null, requestFailure: null, requestClosedAt: null };
    const originalEmit = request.emit;
    let injectedError;
    request.emit = function effectResponse(event, ...values) {
      if (event === 'error' && values[0] === injectedError) {
        const returned = Reflect.apply(originalEmit, this, [event, ...values]);
        report.errorListenersReturned = true;
        try {
          evidence.fileSync('lost-ack-delivered-receipt.json', report);
          if (onErrorDeliveryCut) assert.equal(onErrorDeliveryCut(report), undefined, 'An error-delivery cut must remain synchronous.');
        } catch (error) { report.cutFailure = failure(error); }
        finally { request.emit = originalEmit; }
        return returned;
      }
      if (event !== 'response') return Reflect.apply(originalEmit, this, [event, ...values]);
      const response = values[0]; const chunks = [];
      report.selected.responseAt = new Date().toISOString(); report.selected.status = response.statusCode;
      let bytes = 0; let finished = false;
      const injectError = () => {
        if (report.selected.requestFailure) report.transportErrorSkipped = 'The original request already delivered its own transport failure; no second error was injected.';
        else {
          report.transportErrorIssued = true;
          report.transportErrorBeforeOriginalClose = report.selected.requestClosedAt === null;
          injectedError = new Error('Explicit MS005 qualification lost acknowledgement after original response capture.');
          // A consumed response may make destroy(error) close without delivering the error.
          try { request.emit('error', injectedError); }
          finally { request.destroy(); }
        }
      };
      const finish = (terminal, error) => {
        if (finished) return; finished = true;
        report.selected.bytes = bytes; report.selected.finishedAt = new Date().toISOString(); report.selected.terminal = terminal;
        if (error) report.failures.push(failure(error));
        const complete = terminal === 'end' && response.complete === true;
        if (!complete && !error) report.failures.push(failure(new Error('Selected mutation response ended without a complete HTTP message.')));
        try {
          const stored = evidence.fileSync(complete ? 'lost-ack-original-body.bin' : 'lost-ack-original-prefix.bin', Buffer.concat(chunks), 1024 ** 2);
          if (complete) report.selected.body = stored; else report.selected.prefix = stored;
          report.complete = complete;
          evidence.fileSync(complete ? 'lost-ack-original-receipt.json' : 'lost-ack-failed-receipt.json', report);
        } catch (cause) { report.complete = false; report.failures.push(failure(cause)); }
        if (onResponseCut && report.complete) {
          try { assert.equal(onResponseCut(report), undefined, 'A response cut must remain synchronous.'); }
          catch (error) { report.cutFailure = failure(error); }
        }
        injectError();
      };
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 ** 2) { finish('response_limit', new Error('Selected mutation response exceeded its original-byte bound.')); response.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.once('end', () => finish('end'));
      response.once('error', (error) => finish('error', error));
      response.once('close', () => finish('close'));
      response.resume();
      return true;
    };
    request.once('error', (error) => { report.selected.requestFailure = failure(error); });
    request.once('close', () => { report.selected.requestClosedAt = new Date().toISOString(); });
    return request;
  };
  http.get = function faultGet(...args) { const request = http.request(...args); request.end(); return request; };
  syncBuiltinESMExports();
  return {
    report,
    async close() {
      if (!restored) { restored = true; http.request = originalRequest; http.get = originalGet; syncBuiltinESMExports(); }
      return report;
    },
  };
}
