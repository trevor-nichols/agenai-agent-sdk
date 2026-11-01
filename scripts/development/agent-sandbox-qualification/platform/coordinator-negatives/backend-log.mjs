import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function captureBackendLogs(paths, evidence, phase) {
  assert(Array.isArray(paths) && paths.length >= 1 && paths.length <= 4);
  const result = [];
  for (const [index, path] of paths.entries()) {
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
      result.push({ source: { path, device: String(stat.dev), inode: String(stat.ino), size, offset,
        prefixOmitted: offset > 0, capturedAt: Date.now() }, bytes,
      retained: await evidence.file(`desktop-${phase}-${index}.log`, bytes, 2 * 1024 ** 2) });
    } finally { await file.close(); }
  }
  assert(result.length > 0, 'No actual Desktop backend log is readable.');
  return result;
}
