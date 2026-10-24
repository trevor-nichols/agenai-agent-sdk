import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';

const manifest = z.object({ name: z.literal('@cursor/sdk'), version: z.literal('1.0.40') });

async function digest(entry: string): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(fileURLToPath(entry))) {
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024) throw new Error('Unqualified SDK entry');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function inspectCursorSdk(): Promise<Readonly<{ entry: string; sqliteEntry: string }>> {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major === undefined || minor === undefined || major < 22 || (major === 22 && minor < 13)) throw new Error('Unsupported Node');
    const entry = import.meta.resolve('@cursor/sdk'), sqliteEntry = import.meta.resolve('@cursor/sdk/sqlite');
    if (!entry.endsWith('/dist/esm/index.js') || sqliteEntry !== new URL('./sqlite.js', entry).href) throw new Error('Unqualified SDK entry');
    const metadata: unknown = JSON.parse(await readFile(new URL('../../package.json', entry), 'utf8'));
    if (!manifest.safeParse(metadata).success
      || await digest(entry) !== 'fa955abb770bd70961ce878e184adf431b3bf6ba034f8ffce69ff2104b2a5bfe'
      || await digest(sqliteEntry) !== '3ca3eae5ed43241e6e393488981d07b2e93d8ddb278a0b13d509247f1de77b52') {
      throw new Error('Unqualified SDK identity');
    }
    return { entry, sqliteEntry };
  } catch {
    throw new AgentHistoryError('unsupported_scope', 'Cursor local history requires the exact optional SDK 1.0.40 Node ESM entries and Node >=22.13.');
  }
}
