import { lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import { DEFAULT_ACP_REGISTRY_LIMITS } from '../../../catalog/limits.js';
import type { AcpInstallationAttempt } from '../contracts.js';
import { checkInstallationCancellation, isFilesystemError, storeFailure, validateStoreRecord } from './errors.js';
import { inspectDirectory, physicalIdentity, readOwnedFile, syncDirectory, writeOwnedFile, type OwnedStoreRoot, type PhysicalIdentity } from './filesystem.js';

export interface StoreLock extends AcpInstallationAttempt {
  readonly storeId: string;
  readonly ownerPid: number;
  readonly directory: string;
  readonly identity: PhysicalIdentity;
}
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function planDirectoryName(digest: string): string {
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest)) storeFailure('invalid_input', 'An exact canonical plan digest is required.');
  return digest.slice(7);
}
export function attemptStageName(lock: Pick<StoreLock, 'planDigest' | 'attemptToken'>): string {
  if (!tokenPattern.test(lock.attemptToken)) storeFailure('invalid_input', 'An exact installation attempt token is required.');
  return `${planDirectoryName(lock.planDigest)}-${lock.attemptToken}`;
}
function persistedLock(lock: StoreLock) {
  return { format: 'acp-installation-lock-v1', storeId: lock.storeId, planDigest: lock.planDigest, attemptToken: lock.attemptToken,
    operation: lock.operation, createdAt: lock.createdAt, ownerPid: lock.ownerPid };
}

export async function inspectStoreLock(authority: OwnedStoreRoot, planDigest: string): Promise<StoreLock | undefined> {
  const directory = path.join(authority.root, 'locks', planDirectoryName(planDigest));
  await authority.assertAuthority();
  let identity: PhysicalIdentity;
  try { identity = await inspectDirectory(directory); }
  catch (cause) { if (isFilesystemError(cause, 'ENOENT')) return undefined; throw cause; }
  if ((await readdir(directory)).sort().join(',') !== 'owner.json') storeFailure('recovery_conflict', 'The installation lock has unknown or incomplete ownership state.');
  const content = await readOwnedFile(path.join(directory, 'owner.json'), 4_096);
  const input = validateStoreRecord('recovery_conflict', () => parseBoundedRegistryJson(content, { ...DEFAULT_ACP_REGISTRY_LIMITS, maxSnapshotBytes: 4_096, maxStringBytes: 2_048, maxDepth: 4, maxValues: 32 }));
  if (!input || typeof input !== 'object' || Array.isArray(input)) storeFailure('recovery_conflict', 'The installation lock is malformed.');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'attemptToken,createdAt,format,operation,ownerPid,planDigest,storeId'
    || record.format !== 'acp-installation-lock-v1' || record.storeId !== authority.storeId || record.planDigest !== planDigest
    || typeof record.attemptToken !== 'string' || !tokenPattern.test(record.attemptToken)
    || !['install', 'read', 'acquire', 'release', 'remove', 'recover'].includes(record.operation as string)
    || typeof record.ownerPid !== 'number' || !Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    storeFailure('recovery_conflict', 'The installation lock has invalid ownership state.');
  }
  await inspectDirectory(directory, identity);
  await authority.assertAuthority();
  return { ...record, directory, identity } as unknown as StoreLock;
}

export async function acquireStoreLock(authority: OwnedStoreRoot, planDigest: string, operation: AcpInstallationAttempt['operation'], signal?: AbortSignal): Promise<StoreLock> {
  checkInstallationCancellation(signal);
  await authority.assertAuthority();
  const directory = path.join(authority.root, 'locks', planDirectoryName(planDigest));
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (cause) {
    if (isFilesystemError(cause, 'EEXIST')) storeFailure('store_busy', 'Another operation owns this plan lock; inspect it before any explicit recovery.');
    throw cause;
  }
  const lock: StoreLock = { storeId: authority.storeId, planDigest, attemptToken: randomUUID(), operation,
    createdAt: new Date().toISOString(), ownerPid: process.pid, directory, identity: physicalIdentity(await lstat(directory, { bigint: true })) };
  try {
    await authority.assertAuthority();
    await writeOwnedFile(path.join(directory, 'owner.json'), JSON.stringify(persistedLock(lock)));
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
    return lock;
  } catch (cause) {
    await authority.assertAuthority();
    await inspectDirectory(directory, lock.identity);
    const entries = await readdir(directory);
    if (entries.length === 0) await rmdir(directory);
    throw cause;
  }
}

export async function releaseStoreLock(authority: OwnedStoreRoot, lock: StoreLock): Promise<void> {
  const current = await inspectStoreLock(authority, lock.planDigest);
  if (!current || current.attemptToken !== lock.attemptToken || current.identity.device !== lock.identity.device || current.identity.inode !== lock.identity.inode) {
    storeFailure('recovery_conflict', 'The installation lock no longer belongs to this operation.');
  }
  await unlink(path.join(lock.directory, 'owner.json'));
  await rmdir(lock.directory);
  await syncDirectory(path.dirname(lock.directory));
  await authority.assertAuthority();
}
