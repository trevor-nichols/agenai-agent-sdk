// ------------------------------------------------------------------------------------------------
//                workspace.ts - Explicit prepared-store creation and exact idle-layout validation
// ------------------------------------------------------------------------------------------------

import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { NodeProviderToolsError } from '../errors.js';
import type { NodeProviderWorkspace } from '../types.js';
import { privateDirectoryPath, captureData } from './options.js';

const LAYOUT = 'agenai.sandbox.workspace.v1';
export const STORE_MARKER = '.agenai-layout';
export const STORE_LEASE = '.agenai-lease';
const STORE_ENTRIES = new Set([STORE_MARKER, 'work', 'stage']);

const invalid = (message: string, cause?: unknown) =>
  new NodeProviderToolsError('workspace_invalid', message, cause === undefined ? undefined : { cause });

function marker(uid: number, gid: number): string {
  return `${JSON.stringify({ layout: LAYOUT, uid, gid })}\n`;
}

function privateDirectory(info: Stats, uid: number, gid: number): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && info.gid === gid && (info.mode & 0o7777) === 0o700;
}

async function observe(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw invalid(`Workspace path cannot be observed: ${path}`, cause);
  }
}

/** Validates an existing idle layout: exact marker, private same-device work/stage and an empty stage. */
export async function validateWorkspaceLayout(storeDirectory: string, uid: number, gid: number, leased = false): Promise<NodeProviderWorkspace> {
  const store = await observe(storeDirectory);
  if (!store || !privateDirectory(store, uid, gid) || await realpath(storeDirectory) !== storeDirectory) {
    throw invalid('The workspace store must be a physical 0700 directory owned by the caller.');
  }
  const entries = new Set(await readdir(storeDirectory));
  if (entries.has(STORE_LEASE) && !leased) {
    throw new NodeProviderToolsError('workspace_leased', 'The workspace store is held by an owned driver or retains an unreleased lease.');
  }
  entries.delete(STORE_LEASE);
  if (entries.size !== STORE_ENTRIES.size || [...STORE_ENTRIES].some((entry) => !entries.has(entry))) {
    throw invalid('The directory is not an idle prepared workspace store.');
  }
  const [work, stage, layout] = await Promise.all(['work', 'stage', STORE_MARKER].map((entry) => observe(`${storeDirectory}/${entry}`)));
  if (!work || !stage || !layout || !privateDirectory(work, uid, gid) || !privateDirectory(stage, uid, gid)
    || work.dev !== store.dev || stage.dev !== store.dev || work.ino === stage.ino) {
    throw invalid('Workspace work and stage directories must be distinct private directories on the store filesystem.');
  }
  const expected = marker(uid, gid);
  if (!layout.isFile() || layout.nlink !== 1 || layout.uid !== uid || layout.gid !== gid || (layout.mode & 0o7777) !== 0o400
    || layout.dev !== store.dev || layout.size !== Buffer.byteLength(expected) || await readFile(`${storeDirectory}/${STORE_MARKER}`, 'utf8') !== expected) {
    throw invalid('The workspace layout marker does not match this caller.');
  }
  if ((await readdir(`${storeDirectory}/stage`)).length !== 0) throw invalid('The workspace stage retains unsettled helper staging.');
  return Object.freeze({ storeDirectory, workspaceDirectory: `${storeDirectory}/work` });
}

/**
 * Creates a private store, or reuses an already valid idle one. Nonempty unrelated directories,
 * aliases, cross-device staging and foreign ownership are refused. Workspace data is never moved.
 */
export async function prepareNodeProviderWorkspace(input: Readonly<{ directory: string }>): Promise<NodeProviderWorkspace> {
  const parsed = z.strictObject({ directory: privateDirectoryPath }).safeParse(captureData(input, 'Workspace preparation'));
  if (!parsed.success) throw new NodeProviderToolsError('invalid_options', 'Workspace preparation requires one canonical absolute directory.', { cause: parsed.error });
  const { directory } = parsed.data;
  const uid = process.geteuid?.();
  const gid = process.getegid?.();
  if (uid === undefined || gid === undefined || uid === 0 || gid === 0) {
    throw new NodeProviderToolsError('platform_unsupported', 'Workspace preparation requires a non-root POSIX identity.');
  }
  const existing = await observe(directory);
  if (existing === undefined) {
    try { await mkdir(directory, { mode: 0o700 }); } catch (cause) { throw invalid('The workspace store cannot be created.', cause); }
  } else if ((await readdir(directory).catch(() => ['unreadable'])).length !== 0) {
    return validateWorkspaceLayout(directory, uid, gid);
  }
  const store = await observe(directory);
  if (!store || !store.isDirectory() || store.uid !== uid || await realpath(directory) !== directory) {
    throw invalid('The workspace store must be a physical directory owned by the caller.');
  }
  try {
    await chmod(directory, 0o700);
    await mkdir(`${directory}/work`, { mode: 0o700 });
    await mkdir(`${directory}/stage`, { mode: 0o700 });
    await chmod(`${directory}/work`, 0o700);
    await chmod(`${directory}/stage`, 0o700);
    await writeFile(`${directory}/${STORE_MARKER}`, marker(uid, gid), { mode: 0o400, flag: 'wx' });
    await chmod(`${directory}/${STORE_MARKER}`, 0o400);
  } catch (cause) { throw invalid('The workspace layout could not be created.', cause); }
  return validateWorkspaceLayout(directory, uid, gid);
}
