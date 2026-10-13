import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDigest } from '../../../shared/digest.js';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import { DEFAULT_ACP_REGISTRY_LIMITS } from '../../../catalog/limits.js';
import { inspectDirectory, readOwnedFile, removeOwnedDirectory, syncDirectory, writeOwnedFile, type OwnedStoreRoot, type PhysicalIdentity } from './filesystem.js';
import { attemptStageName, type StoreLock } from './lock.js';
import { isFilesystemError, storeFailure, validateStoreRecord } from './errors.js';

export interface InstallationStage {
  readonly root: string;
  readonly identity: PhysicalIdentity;
  readonly installationRoot: string;
  readonly payloadRoot: string;
  readonly workRoot: string;
}
function stageMarker(lock: StoreLock, identity: PhysicalIdentity) {
  return { format: 'acp-installation-attempt-v1', storeId: lock.storeId, attemptToken: lock.attemptToken,
    planDigest: lock.planDigest, operation: lock.operation, ...identity };
}

export async function createInstallationStage(authority: OwnedStoreRoot, lock: StoreLock): Promise<InstallationStage> {
  await authority.assertAuthority();
  const root = path.join(authority.root, 'stages', attemptStageName(lock));
  await mkdir(root, { mode: 0o700 });
  const identity = await inspectDirectory(root);
  await writeOwnedFile(path.join(root, 'attempt.json'), JSON.stringify(stageMarker(lock, identity)));
  const installationRoot = path.join(root, 'installation');
  const payloadRoot = path.join(installationRoot, 'payload');
  const workRoot = path.join(root, 'work');
  if (lock.operation === 'install') {
    await mkdir(installationRoot, { mode: 0o700 });
    await mkdir(payloadRoot, { mode: 0o700 });
    await mkdir(workRoot, { mode: 0o700 });
  }
  await syncDirectory(root);
  await syncDirectory(path.dirname(root));
  await authority.assertAuthority();
  return { root, identity, installationRoot, payloadRoot, workRoot };
}

export async function inspectInstallationStage(authority: OwnedStoreRoot, lock: StoreLock): Promise<InstallationStage | undefined> {
  const root = path.join(authority.root, 'stages', attemptStageName(lock));
  let identity: PhysicalIdentity;
  try { identity = await inspectDirectory(root); }
  catch (cause) { if (isFilesystemError(cause, 'ENOENT')) return undefined; throw cause; }
  const content = await readOwnedFile(path.join(root, 'attempt.json'), 4_096);
  const marker = validateStoreRecord('recovery_conflict', () => parseBoundedRegistryJson(content, { ...DEFAULT_ACP_REGISTRY_LIMITS, maxSnapshotBytes: 4_096, maxStringBytes: 2_048, maxDepth: 4, maxValues: 32 }));
  if (canonicalDigest(marker) !== canonicalDigest(stageMarker(lock, identity))) storeFailure('recovery_conflict', 'The attempt directory does not match its exact ownership token and physical identity.');
  const allowed = lock.operation === 'install' ? ['attempt.json', 'installation', 'work'] : ['attempt.json', 'retired'];
  for (const name of await readdir(root)) {
    if (!allowed.includes(name)) storeFailure('recovery_conflict', 'The attempt directory contains unrecognized ownership state.');
    if (name !== 'attempt.json') await inspectDirectory(path.join(root, name));
  }
  return { root, identity, installationRoot: path.join(root, 'installation'), payloadRoot: path.join(root, 'installation', 'payload'), workRoot: path.join(root, 'work') };
}

export async function cleanInstallationStage(authority: OwnedStoreRoot, lock: StoreLock, stage: InstallationStage): Promise<void> {
  const inspected = await inspectInstallationStage(authority, lock);
  if (!inspected || inspected.identity.device !== stage.identity.device || inspected.identity.inode !== stage.identity.inode) storeFailure('recovery_conflict', 'The attempt directory was replaced.');
  await removeOwnedDirectory(authority, stage.root, stage.identity);
}
