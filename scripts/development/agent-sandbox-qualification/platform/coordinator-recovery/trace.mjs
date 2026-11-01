import assert from 'node:assert/strict';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

export function installCleanupTrace({ socketPath, path, records, consume = () => {} }) {
  const originalRequest = http.request; const originalGet = http.get;
  const descriptor = openSync(path, 'wx', 0o600);
  const gets = new Set(['/version', '/info', '/v1.52/version', '/v1.52/info', '/v1.52/networks', '/v1.52/volumes', '/v1.52/containers/json?all=1']);
  const deletes = new Set(); const entries = []; let bytes = 0; let restored = false;
  for (const record of records) for (const resource of record.resources) {
    const references = resource.identity.kind === 'identified' ? [resource.name, resource.identity.id] : [resource.name];
    for (const reference of references) {
      const encoded = encodeURIComponent(reference);
      if (resource.role === 'network') { gets.add(`/v1.52/networks/${encoded}`); deletes.add(`/v1.52/networks/${encoded}`); }
      else if (resource.role === 'storage' || resource.role === 'egress_socket') {
        gets.add(`/v1.52/volumes/${encoded}`); deletes.add(`/v1.52/volumes/${encoded}`);
      } else {
        gets.add(`/v1.52/containers/${encoded}/json`); deletes.add(`/v1.52/containers/${encoded}?force=true&v=false`);
      }
    }
  }
  http.request = function cleanupRequest(options, ...rest) {
    const data = options && typeof options === 'object' && !Array.isArray(options);
    const method = data ? options.method ?? 'GET' : '';
    const target = data && typeof options.path === 'string' ? options.path : '';
    const selected = data && options.socketPath === socketPath;
    const admitted = selected && (method === 'GET' && gets.has(target) || method === 'DELETE' && deletes.has(target));
    const entry = { sequence: entries.length + 1, pid: process.pid, at: new Date().toISOString(), method: String(method).slice(0, 32),
      target: target.slice(0, 4096), socketPath: data ? String(options.socketPath ?? '').slice(0, 4096) : '', dispatch: admitted ? 'admitted' : 'blocked' };
    const line = Buffer.from(`${JSON.stringify(entry)}\n`);
    assert(entries.length < 4096 && bytes + line.length <= 4 * 1024 ** 2, 'Cleanup HTTP trace exceeded its bound.');
    consume(line.length); bytes += line.length; entries.push(entry); writeSync(descriptor, line);
    assert(admitted, 'Cleanup HTTP guard rejected an unregistered endpoint, resource or operation before dispatch.');
    return Reflect.apply(originalRequest, this, [options, ...rest]);
  };
  http.get = function cleanupGet(...args) { const request = http.request(...args); request.end(); return request; };
  syncBuiltinESMExports();
  return {
    summarize() {
      return { requests: entries.length, bytes, gets: entries.filter((entry) => entry.method === 'GET' && entry.dispatch === 'admitted').length,
        deletes: entries.filter((entry) => entry.method === 'DELETE' && entry.dispatch === 'admitted').length,
        blocked: entries.filter((entry) => entry.dispatch === 'blocked').length,
        forbiddenDispatches: entries.filter((entry) => entry.dispatch === 'admitted' && entry.method !== 'GET' && entry.method !== 'DELETE').length,
        scope: 'This process Node http.request/get; every admitted SDK HTTP request is retained. No claim covers arbitrary raw-socket writers.' };
    },
    restore() {
      if (restored) return; restored = true;
      http.request = originalRequest; http.get = originalGet; syncBuiltinESMExports(); fsyncSync(descriptor); closeSync(descriptor);
    },
  };
}
