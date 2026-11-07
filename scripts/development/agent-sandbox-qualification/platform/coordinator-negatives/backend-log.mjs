import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Desktop renames a full backend log to `<name>.<YYYYMMDD-HHMMSS.mmm>`; the newest rotation holds a row's earlier lines. */
async function withNewestRotation(path) {
  const name = basename(path), rotation = /^\.\d{8}-\d{6}\.\d{3}$/u;
  const rotated = (await readdir(dirname(path))).filter((entry) => entry.startsWith(name) && rotation.test(entry.slice(name.length))).sort();
  return [...rotated.slice(-1).map((entry) => join(dirname(path), entry)), path];
}

export async function readBackendLogs(paths) {
  assert(Array.isArray(paths) && paths.length >= 1 && paths.length <= 4);
  const result = [];
  for (const [index, path] of (await Promise.all(paths.map(withNewestRotation))).flat().entries()) {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    try {
      const stat = await file.stat({ bigint: true }); assert(stat.isFile());
      const size = Number(stat.size); assert(Number.isSafeInteger(size));
      const offset = Math.max(0, size - 2 * 1024 ** 2), bytes = Buffer.alloc(size - offset);
      let total = 0;
      while (total < bytes.length) {
        const read = await file.read(bytes, total, bytes.length - total, offset + total);
        if (!read.bytesRead) break; total += read.bytesRead;
      }
      assert.equal(total, bytes.length, 'Original Desktop log was truncated during capture.');
      result.push({ index, source: { path, device: String(stat.dev), inode: String(stat.ino), size, offset,
        prefixOmitted: offset > 0, capturedAt: Date.now() }, bytes });
    } finally { await file.close(); }
  }
  assert(result.length > 0, 'No actual Desktop backend log is readable.');
  return result;
}

export async function captureBackendLogs(paths, evidence, phase) {
  const logs = await readBackendLogs(paths);
  for (const log of logs) log.retained = await evidence.file(`desktop-${phase}-${log.index}.log`, log.bytes, 2 * 1024 ** 2);
  return logs;
}
