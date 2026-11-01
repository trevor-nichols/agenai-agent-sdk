import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const path = process.env.AGENAI_COLD_HTTP_TRACE, socketPath = process.env.AGENAI_COLD_ENGINE_SOCKET;
assert(path?.startsWith('/') && socketPath?.startsWith('/'), 'Cold HTTP preload requires explicit owned paths.');
const fd = openSync(path, 'wx', 0o600), request = http.request;
let sequence = 0, bytes = 0, failed = false;
const active = new Set(), children = new Set();
const spawn = childProcess.spawn;
const record = (value) => {
  try {
    const line = `${JSON.stringify(value)}\n`; bytes += Buffer.byteLength(line);
    assert(bytes <= 8 * 1024 ** 2); writeSync(fd, line);
  } catch { failed = true; } // Evidence failure must leave original SDK cleanup forwarding intact.
};
record({ kind: 'header', socketPath, pid: process.pid, scope: 'Passive original Node HTTP method/path, terminal response hash and mutation-response bytes; raw GET bodies belong to the original Engine capture.' });
childProcess.spawn = function coldSpawn(command, args, ...rest) {
  const child = Reflect.apply(spawn, this, [command, args, ...rest]);
  children.add(child); record({ kind: 'child_spawn', pid: child.pid ?? null, command, args, at: Date.now() });
  child.once('close', (code, signal) => {
    children.delete(child); record({ kind: 'child_close', pid: child.pid ?? null, code, signal, at: Date.now() });
  });
  return child;
};
http.request = function coldRequest(options, ...rest) {
  const actual = Reflect.apply(request, this, [options, ...rest]);
  if (options?.socketPath !== socketPath) return actual;
  const id = ++sequence, method = options.method ?? 'GET', target = options.path;
  if (sequence > 4096) failed = true;
  active.add(id); record({ kind: 'request', id, method, target, at: Date.now() });
  const emit = actual.emit; let response, responseEmit, done = false, count = 0;
  const hash = createHash('sha256'), raw = [];
  const finish = (terminal) => {
    if (done) return; done = true; active.delete(id);
    const complete = terminal === 'upgrade' || terminal === 'end' && response?.complete === true;
    if (!complete) failed = true;
    record({ kind: 'response', id, method, target, status: response?.statusCode ?? null, terminal, complete,
      bytes: count, sha256: hash.digest('hex'), ...(method === 'GET' ? {} : { bodyBase64: Buffer.concat(raw).toString('base64') }), at: Date.now() });
    actual.emit = emit; if (response) response.emit = responseEmit;
  };
  actual.emit = function coldEvent(event, ...values) {
    if (event === 'response') {
      response = values[0]; responseEmit = response.emit;
      response.emit = function coldResponse(kind, ...chunks) {
        if (kind === 'data') {
          const chunk = chunks[0]; count += chunk.length; hash.update(chunk);
          if (method !== 'GET') { if (count <= 65536) raw.push(Buffer.from(chunk)); else failed = true; }
        }
        const result = Reflect.apply(responseEmit, this, [kind, ...chunks]);
        if (kind === 'end') finish('end'); else if (kind === 'close') finish('close');
        return result;
      };
    }
    if (event === 'upgrade') { response = values[0]; responseEmit = response.emit; finish('upgrade'); }
    const result = Reflect.apply(emit, this, [event, ...values]);
    if (event === 'close' && !response) finish('request_close');
    return result;
  };
  return actual;
};
http.get = function coldGet(...args) { const actual = http.request(...args); actual.end(); return actual; };
syncBuiltinESMExports();
process.once('exit', () => {
  record({ kind: 'closed', requests: sequence, active: [...active], activeChildren: [...children].map(({ pid }) => pid),
    complete: !failed && active.size === 0 && children.size === 0 });
  try { fsyncSync(fd); closeSync(fd); } catch { /* Missing terminal bytes fail the parent proof. */ }
});
