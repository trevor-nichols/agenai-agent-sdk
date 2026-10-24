import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';

export async function assertOpenCodeClientIdentity(): Promise<void> {
  try {
    const entry = import.meta.resolve('@opencode/client/promise');
    const manifest: unknown = JSON.parse(await readFile(new URL('../../package.json', entry), 'utf8'));
    if (!z.object({ name: z.literal('@opencode/client'), version: z.literal('2.1.2') }).safeParse(manifest).success) {
      throw new Error('Unqualified client');
    }
  } catch { throw new AgentHistoryError('unsupported_scope', 'OpenCode history requires the optional @opencode/client 2.1.2 peer.'); }
}
