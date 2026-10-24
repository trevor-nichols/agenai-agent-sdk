import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { AgentHistoryError } from '../../lifecycle/errors.js';

const CODEX_SHA256 = '399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215';
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export async function codexExecutablePath(path: string): Promise<string> {
  try {
    const physical = await realpath(path);
    const metadata = await stat(physical);
    await access(physical, constants.X_OK);
    if (!metadata.isFile()) throw new Error('Executable required');
    return physical;
  } catch { throw new AgentHistoryError('invalid_input', 'Codex history requires explicit executable tool paths.'); }
}

export async function assertCodexExecutable(path: string, signal?: AbortSignal): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_EXECUTABLE_BYTES) throw new Error('Unqualified executable');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024, signal })) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid executable bytes');
      bytes += chunk.length;
      if (bytes > MAX_EXECUTABLE_BYTES) throw new Error('Executable too large');
      hash.update(chunk);
    }
    if (hash.digest('hex') !== CODEX_SHA256) throw new Error('Unqualified executable');
  } catch { throw new AgentHistoryError('unsupported_scope', 'Codex history requires the qualified Linux x86_64 Codex 0.163.0 executable.'); }
}

export async function codexDirectory(path: string): Promise<string> {
  try {
    const physical = await realpath(path);
    if (!(await stat(physical)).isDirectory()) throw new Error('Directory required');
    return physical;
  } catch { throw new AgentHistoryError('invalid_input', 'Codex history requires existing explicit configuration, project and temporary directories.'); }
}
