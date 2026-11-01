import assert from 'node:assert/strict';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

// Only this process's Node HTTP boundary is covered. Native holder filesystem I/O is separate.
export function installGuard({ socketPath, path, records, completedDeletes = [] }) {
  const request = http.request, get = http.get;
  const fd = openSync(path, 'wx', 0o600);
  const deletes = new Set();
  const completed = new Set(completedDeletes);
  for (const record of records) for (const resource of record.resources) {
    if (resource.identity.kind !== 'identified') continue;
    const id = encodeURIComponent(resource.identity.id);
    deletes.add(resource.role === 'network' ? `/v1.52/networks/${id}`
      : ['storage', 'egress_socket'].includes(resource.role) ? `/v1.52/volumes/${id}`
        : `/v1.52/containers/${id}?force=true&v=false`);
  }
  let policy = { kind: 'read_only' }, restored = false;
  const entries = [], failures = [];
  let sequence = 0;
  const failed = (error) => { if (failures.length < 16) failures.push(error); };
  http.request = function guarded(options, ...rest) {
    const method = options?.method ?? 'GET', target = options?.path ?? '';
    const same = options?.socketPath === socketPath;
    const allowed = same && (method === 'GET' || policy.kind === 'cleanup' && method === 'DELETE' && deletes.has(target) && !completed.has(target)
      || policy.kind === 'fixture_create' && method === 'POST' && target === policy.path
      || policy.kind === 'fixture_delete' && method === 'DELETE' && target === policy.path);
    const entry = { sequence: ++sequence, phase: policy.kind, method, target,
      socketPath: options?.socketPath ?? null, dispatch: allowed ? 'admitted' : 'blocked', at: new Date().toISOString() };
    if (entries.length < 8192) {
      entries.push(entry);
      try { writeSync(fd, `${JSON.stringify(entry)}\n`); } catch (error) { failed(error); }
    } else failed(new Error('Negative qualification request census exhausted; later authorized cleanup still forwards.'));
    assert(allowed, 'Qualification refused an unauthorized HTTP effect before dispatch.');
    return Reflect.apply(request, this, [options, ...rest]);
  };
  http.get = function guardedGet(...args) { const value = http.request(...args); value.end(); return value; };
  syncBuiltinESMExports();
  return {
    select(value) { policy = value; },
    snapshot() { return entries.map((entry) => ({ ...entry })); },
    failures() { return [...failures]; },
    restore() {
      if (restored) return;
      restored = true; http.request = request; http.get = get; syncBuiltinESMExports();
      try { fsyncSync(fd); } catch (error) { failed(error); }
      try { closeSync(fd); } catch (error) { failed(error); }
    },
  };
}
