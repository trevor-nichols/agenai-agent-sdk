import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const encode = (value) => `${JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2)}\n`;
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function absolute(path) {
  assert(typeof path === 'string' && isAbsolute(path) && normalize(path) === path && path.isWellFormed()
    && Buffer.byteLength(path) <= 4096 && !path.endsWith('/') && !/\p{Cc}/u.test(path));
  return path;
}
export function failure(error, depth = 0) {
  if (depth >= 8) return { name: 'DepthLimit' };
  return { name: String(error?.name ?? 'ThrownValue').slice(0, 128), message: String(error?.message ?? error).slice(0, 4096),
    ...(error?.code === undefined ? {} : { code: String(error.code).slice(0, 128) }),
    ...(error?.failure === undefined ? {} : { failure: error.failure }),
    ...(Array.isArray(error?.issues) ? { issues: error.issues.slice(0, 16) } : {}),
    ...(error?.owner?.state === undefined ? {} : { ownerState: error.owner.state }),
    ...(error?.cause === undefined ? {} : { cause: failure(error.cause, depth + 1) }),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 16).map((item) => failure(item, depth + 1)) } : {}) };
}

export class Evidence {
  constructor(directory, { maximumBytes = 96 * 1024 ** 2, maximumFiles = 8192, maximumEvents = 2048 } = {}) {
    for (const value of [maximumBytes, maximumFiles, maximumEvents]) assert(Number.isSafeInteger(value) && value > 0);
    this.directory = directory; this.maximumBytes = maximumBytes; this.maximumFiles = maximumFiles; this.maximumEvents = maximumEvents;
    this.bytes = 0; this.files = 0; this.events = 0; this.handles = new Map(); this.tail = Promise.resolve();
  }
  async initialize(input) {
    await mkdir(this.directory, { mode: 0o700 });
    await mkdir(join(this.directory, 'sources'), { mode: 0o700 });
    await this.file('input.json', input);
  }
  count(bytes) {
    this.bytes += bytes;
    assert(this.bytes <= this.maximumBytes, 'Attempt evidence exceeded its aggregate bound.');
  }
  allocate(name, value, maximum) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(name) && !name.includes('..'));
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : encode(value));
    assert(bytes.length <= maximum && ++this.files <= this.maximumFiles); this.count(bytes.length);
    const path = join(this.directory, name);
    return { path, bytes };
  }
  async file(name, value, maximum = 4 * 1024 ** 2) {
    const { path, bytes } = this.allocate(name, value, maximum);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return { path, bytes: bytes.length, sha256: sha(bytes) };
  }
  fileSync(name, value, maximum = 4 * 1024 ** 2) {
    const { path, bytes } = this.allocate(name, value, maximum);
    const descriptor = openSync(path, 'wx', 0o600);
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    return { path, bytes: bytes.length, sha256: sha(bytes) };
  }
  append(name, bytes, maximum = 2 * 1024 ** 2) {
    this.tail = this.tail.then(async () => {
      let entry = this.handles.get(name);
      if (!entry) { entry = { handle: await open(join(this.directory, name), 'wx', 0o600), bytes: 0 }; this.handles.set(name, entry); }
      entry.bytes += bytes.length; assert(entry.bytes <= maximum); this.count(bytes.length);
      await entry.handle.writeFile(bytes);
    });
    return this.tail;
  }
  event(value) {
    assert(++this.events <= this.maximumEvents);
    return this.append('events.jsonl', Buffer.from(`${JSON.stringify({ sequence: this.events, at: new Date().toISOString(), ...value },
      (_, item) => typeof item === 'bigint' ? String(item) : item)}\n`), 16 * 1024 ** 2);
  }
  async freezeSources() {
    const paths = ['controller.mjs', 'member.mjs', 'session.mjs', 'guest.mjs', 'guest-network.mjs', 'evidence.mjs', 'engine-capture.mjs',
      'scenario.mjs', 'configuration.mjs', 'effect-fault.mjs', 'control-loss.mjs', 'handoff.mjs', 'cut.mjs',
      '../coordinator-recovery/common.mjs', '../coordinator-recovery/canonical.mjs',
      '../research/desktop-concurrency/native/installed.mjs', '../../engine.mjs', '../capabilities/network/resources.mjs',
      '../../scalability/identity.mjs', '../../scalability/configuration.mjs',
      '../../scalability/manifests.mjs', '../../native/configuration.mjs'];
    const result = [];
    for (const [index, name] of paths.entries()) {
      const path = fileURLToPath(new URL(name, import.meta.url));
      assert.equal(await realpath(path), path);
      const bytes = await readFile(path); assert(bytes.length <= 1024 ** 2);
      result.push({ original: path, ...await this.file(`sources/${String(index).padStart(2, '0')}-${name.split('/').at(-1)}`, bytes, 1024 ** 2) });
    }
    return result;
  }
  async close() { await this.tail; for (const { handle } of this.handles.values()) { await handle.sync(); await handle.close(); } }
}

export async function observe(actual, timeoutMs, description) {
  let timer;
  try { return await Promise.race([actual, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description}: bounded wait expired; the original operation remains owned.`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
