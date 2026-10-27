import assert from 'node:assert/strict';
import { physicalPath } from './input.mjs';

export function keys(value, fields) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Manifest object required.');
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), 'Unknown or missing capability manifest field.');
}

export function integer(value, minimum, maximum, field) {
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${field} is outside its safe integer bounds.`);
}

export function boundedText(value, minimum, maximum, field) {
  assert(typeof value === 'string' && Buffer.byteLength(value) >= minimum && Buffer.byteLength(value) <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value), `${field} requires bounded text without controls.`);
}

export function sha256(value) { assert(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'Exact SHA-256 required.'); }
export function imageDigest(value) { assert(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value), 'Exact image digest required.'); }

export function endpoint(value) {
  assert(typeof value === 'string' && Buffer.byteLength(value) <= 512 && /^unix:\/\/\/[a-zA-Z0-9_.\-/]+$/u.test(value),
    'Canonical local Unix Engine endpoint required.');
  physicalPath(value.slice(7));
}

export function user(value) {
  keys(value, ['uid', 'gid']);
  assert.equal(value.uid, 1000, 'Qualification user must be 1000:1000.');
  assert.equal(value.gid, 1000, 'Qualification user must be 1000:1000.');
}

export function resources(value) {
  keys(value, ['cpus', 'memoryBytes', 'pids']);
  assert(typeof value.cpus === 'number' && value.cpus >= 0.1 && value.cpus <= 2
    && Number.isSafeInteger(value.cpus * 1_000_000_000), 'Qualification CPU requires 0.1–2 exact nano-CPUs.');
  integer(value.memoryBytes, 64 * 1024 ** 2, 1024 ** 3, 'memoryBytes');
  integer(value.pids, 8, 128, 'pids');
}

export function temporaryBytes(value) { integer(value, 1024 ** 2, 64 * 1024 ** 2, 'temporaryBytes'); }

export function control(value, timeoutMs) {
  keys(value, ['heartbeatMs', 'leaseTimeoutMs']);
  integer(value.heartbeatMs, 100, 5000, 'heartbeatMs');
  integer(value.leaseTimeoutMs, 60_000, 120_000, 'leaseTimeoutMs');
  assert(value.leaseTimeoutMs > timeoutMs + 2 * value.heartbeatMs, 'Control lease must exceed timeout plus two heartbeats.');
}
