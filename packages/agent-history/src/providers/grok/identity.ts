import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AgentHistoryError } from '../../lifecycle/errors.js';

const runFile = promisify(execFile);
const GROK_SHA256 = '2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa';
const GROK_EXECUTABLE_BYTES = 191_715_904;

export async function grokExecutablePath(path: string): Promise<string> {
  try {
    const physical = await realpath(path);
    if (!(await stat(physical)).isFile()) throw new Error('File required');
    await access(physical, constants.X_OK);
    return physical;
  } catch { throw new AgentHistoryError('invalid_input', 'Grok history requires explicit executable tool paths.'); }
}

export async function grokDirectory(path: string): Promise<string> {
  try {
    const physical = await realpath(path);
    if (!(await stat(physical)).isDirectory()) throw new Error('Directory required');
    return physical;
  } catch { throw new AgentHistoryError('invalid_input', 'Grok history requires existing explicit native, project and temporary directories.'); }
}

export async function assertGrokExecutable(path: string, signal?: AbortSignal): Promise<void> {
  try {
    if ((await stat(path)).size !== GROK_EXECUTABLE_BYTES) throw new Error('Unqualified executable');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024, signal })) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid executable bytes');
      bytes += chunk.length;
      if (bytes > GROK_EXECUTABLE_BYTES) throw new Error('Executable changed');
      hash.update(chunk);
    }
    if (bytes !== GROK_EXECUTABLE_BYTES || hash.digest('hex') !== GROK_SHA256) throw new Error('Unqualified executable');
  } catch {
    if (signal?.aborted) throw new AgentHistoryError('cancelled', 'Grok executable inspection was cancelled.');
    throw new AgentHistoryError('unsupported_scope', 'Grok history requires the qualified Linux x86_64 Grok Build 1.0.62 executable.');
  }
}

export async function assertGrokSandbox(path: string, writable: boolean): Promise<void> {
  try {
    const result = await runFile(path, ['--help'], { timeout: 2000, maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    if (!result.stdout.includes('--ro-bind-fd') || (writable && !result.stdout.includes('--bind-fd'))) throw new Error('Held descriptor mount required');
  } catch { throw new AgentHistoryError('unsupported_scope', 'Grok history requires Bubblewrap with read-only file-descriptor mounts.'); }
}

export interface GrokSessionStore {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export async function captureGrokStore(path: string): Promise<GrokSessionStore> {
  const physical = await grokDirectory(path), metadata = await stat(physical, { bigint: true });
  return Object.freeze({ path: physical, device: metadata.dev, inode: metadata.ino });
}

export async function openGrokStore(store: GrokSessionStore) {
  try {
    if (await realpath(store.path) !== store.path) throw new Error('Store replaced');
    const handle = await open(store.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isDirectory() || metadata.dev !== store.device || metadata.ino !== store.inode) throw new Error('Store replaced');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  } catch { throw new AgentHistoryError('unsupported_scope', 'The captured Grok sessions directory was replaced or is unavailable.'); }
}
