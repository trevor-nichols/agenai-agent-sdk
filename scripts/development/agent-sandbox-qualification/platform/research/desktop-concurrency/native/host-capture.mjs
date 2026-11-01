import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sha } from './installed.mjs';

const execute = promisify(execFile);
export async function captureHost(authority, output, phase) {
  const { path, sha256 } = authority.hostObserver.executable;
  const before = await lstat(path, { bigint: true });
  assert(before.isFile()); assert.equal(sha(await readFile(path)), sha256);
  const began = performance.now();
  const result = await execute(path, [], { cwd: '/', env: { LANG: 'C', LC_ALL: 'C', PATH: '/nonexistent' },
    encoding: 'buffer', maxBuffer: authority.maxOutputBytes, timeout: authority.commandTimeoutMs });
  const elapsedMs = performance.now() - began;
  assert.equal(result.stderr.length, 0);
  const document = JSON.parse(result.stdout.toString('utf8'));
  assert.equal(document.format, 'agenai.desktop-host-network.v1');
  const after = await lstat(path, { bigint: true });
  for (const field of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field]);
  assert.equal(sha(await readFile(path)), sha256);
  const destination = join(output, `host-${phase}.json`);
  await writeFile(destination, result.stdout, { flag: 'wx', mode: 0o600 });
  return { phase, path: destination, bytes: result.stdout.length, sha256: sha(result.stdout), elapsedMs,
    executable: { path, sha256, device: String(before.dev), inode: String(before.ino) } };
}
