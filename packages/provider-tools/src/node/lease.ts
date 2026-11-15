// ------------------------------------------------------------------------------------------------
//                lease.ts - Exclusive owned-driver lease on one prepared workspace store
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { NodeProviderToolsError } from '../errors.js';
import { STORE_LEASE, validateWorkspaceLayout } from './workspace.js';

const held = new Set<string>();

export interface WorkspaceLease {
  readonly storeDirectory: string;
  release(): Promise<void>;
}

/**
 * Exclusively creates the store lease after validating its idle layout. A lease left by a crashed
 * owner is never stolen; the caller removes it explicitly after confirming no driver uses the store.
 */
export async function acquireWorkspaceLease(storeDirectory: string, uid: number, gid: number): Promise<WorkspaceLease> {
  if (held.has(storeDirectory)) throw new NodeProviderToolsError('workspace_leased', 'The workspace store is held by an owned driver in this process.');
  held.add(storeDirectory);
  const token = randomUUID();
  const path = `${storeDirectory}/${STORE_LEASE}`;
  let created = false;
  try {
    await validateWorkspaceLayout(storeDirectory, uid, gid);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new NodeProviderToolsError('workspace_leased', 'The workspace store is held by another owned driver.');
      throw cause;
    });
    created = true;
    try { await handle.writeFile(`${JSON.stringify({ token, pid: process.pid })}\n`); } finally { await handle.close(); }
    await validateWorkspaceLayout(storeDirectory, uid, gid, true);
  } catch (cause) {
    if (created) await unlink(path).catch(() => {});
    held.delete(storeDirectory);
    throw cause;
  }
  let released = false;
  return Object.freeze({
    storeDirectory,
    async release() {
      if (released) return;
      const current = await readFile(path, 'utf8').catch((cause: unknown) => {
        throw new NodeProviderToolsError('workspace_invalid', 'The owned workspace lease disappeared before release.', { cause });
      });
      if (!current.includes(`"token":"${token}"`)) throw new NodeProviderToolsError('workspace_invalid', 'The workspace lease was replaced by another owner.');
      await unlink(path);
      released = true;
      held.delete(storeDirectory);
    },
  });
}
