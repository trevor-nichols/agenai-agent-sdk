import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { NativeExampleError } from './data.js';

export async function physicalDirectory(directory: string, privateMode = false): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || await realpath(directory) !== directory
    || privateMode && ((metadata.mode & 0o077) !== 0 || typeof process.getuid !== 'function' || metadata.uid !== process.getuid())) {
    throw new NativeExampleError('invalid_input');
  }
}
export async function readJson(file: string, maxBytes = 65536): Promise<unknown> {
  const metadata = await lstat(file, { bigint: true });
  if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size < 1n || metadata.size > BigInt(maxBytes) || await realpath(file) !== file) {
    throw new NativeExampleError('invalid_input');
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (before.dev !== metadata.dev || before.ino !== metadata.ino || before.size !== metadata.size) throw new NativeExampleError('invalid_input');
    const bytes = Buffer.alloc(Number(metadata.size));
    for (let offset = 0; offset < bytes.length;) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new NativeExampleError('invalid_input'); offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new NativeExampleError('invalid_input');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new NativeExampleError('invalid_input'); }
  } finally { await handle.close(); }
}
export async function writeJson(file: string, value: unknown, exclusive: boolean): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > 65536) throw new NativeExampleError('artifact_failed');
  const target = exclusive ? file : join(dirname(file), `.writing-${randomUUID()}`);
  const handle = await open(target, 'wx', 0o600);
  let complete = false;
  try { await handle.writeFile(bytes); await handle.sync(); complete = true; }
  finally { await handle.close(); if (!complete) await unlink(target).catch(() => {}); }
  if (!exclusive) await rename(target, file);
  const parent = await open(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
export async function createArtifacts(directory: string) {
  await physicalDirectory(dirname(directory)); await mkdir(directory, { mode: 0o700 });
  let checkpoints = 0;
  return {
    directory,
    write: (name: 'report.json' | 'inspection-cleanup.json', value: unknown) => writeJson(join(directory, name), value, false),
    async persist(record: SandboxRecoveryRecord): Promise<void> {
      if (++checkpoints > 1024) throw new NativeExampleError('artifact_failed');
      const file = `recovery-${String(checkpoints).padStart(4, '0')}.json`;
      await writeJson(join(directory, file), record, true);
      await writeJson(join(directory, 'recovery-latest.json'), { file, record }, false);
    },
  };
}
