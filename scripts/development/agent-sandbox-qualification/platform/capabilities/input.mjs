import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

export function physicalPath(value) {
  assert(typeof value === 'string' && Buffer.byteLength(value) >= 2 && Buffer.byteLength(value) <= 4096
    && isAbsolute(value) && normalize(value) === value && !value.endsWith('/')
    && !/[\u0000-\u001f\u007f]/u.test(value), 'Canonical physical path spelling required.');
  return value;
}

export function captureData(value, depth = 0, budget = { nodes: 2048 }) {
  assert(--budget.nodes >= 0 && depth <= 12, 'Capability manifest exceeds its bounded data graph.');
  if (value === null || typeof value !== 'object') {
    assert(['string', 'number', 'boolean'].includes(typeof value) || value === null, 'JSON data required.');
    if (typeof value === 'number') assert(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
      'Finite numbers and safe integers required.');
    return value;
  }
  if (Array.isArray(value)) {
    assert(Object.getPrototypeOf(value) === Array.prototype && value.length <= 2048
      && Reflect.ownKeys(value).length === value.length + 1, 'Bounded dense data array required.');
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      assert(property && 'value' in property && property.enumerable, 'Enumerable array data required.');
      result.push(captureData(property.value, depth + 1, budget));
    }
    return Object.freeze(result);
  }
  assert((Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).length <= 64, 'Bounded plain data object required.');
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    assert(typeof key === 'string' && key !== '__proto__' && property && 'value' in property && property.enumerable,
      'Accessors, symbols and hidden fields are forbidden.');
    result[key] = captureData(property.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

const statIdentity = (stat) => Object.freeze({ device: String(stat.dev), inode: String(stat.ino), size: String(stat.size),
  mode: String(stat.mode), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });

export async function assertInputCurrent(input) {
  assert.equal(await realpath(input.path), input.path, 'Manifest path must remain physical.');
  const current = await lstat(input.path, { bigint: true });
  assert(current.isFile() && !current.isSymbolicLink(), 'Manifest must remain a regular no-follow file.');
  assert.deepEqual(statIdentity(current), input.identity, 'Captured manifest identity changed before use.');
}

export async function acquireJsonInput(path, maximum) {
  physicalPath(path);
  assert.equal(await realpath(path), path, 'Manifest path must be physical.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    assert(before.isFile() && before.size <= BigInt(maximum), 'Bounded regular manifest required.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    assert(total <= maximum && BigInt(total) === before.size, 'Manifest size changed during acquisition.');
    assert.deepEqual(statIdentity(after), statIdentity(before), 'Manifest changed during acquisition.');
    const captured = bytes.subarray(0, total);
    const input = Object.freeze({ path, sha256: createHash('sha256').update(captured).digest('hex'), bytes: total,
      identity: statIdentity(after) });
    await assertInputCurrent(input);
    const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(captured);
    return Object.freeze({ value: captureData(JSON.parse(utf8)), input, utf8 });
  } finally { await file.close(); }
}
