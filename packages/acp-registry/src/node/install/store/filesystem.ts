import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalDigest } from '../../../shared/digest.js';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import { DEFAULT_ACP_REGISTRY_LIMITS } from '../../../catalog/limits.js';
import { isFilesystemError, storeFailure } from './errors.js';

export interface PhysicalIdentity { readonly device: string; readonly inode: string }
interface Anchor extends PhysicalIdentity { readonly path: string }
interface StoreMarker {
  readonly format: 'acp-owned-installation-store-v1';
  readonly storeId: string;
  readonly canonicalRoot: string;
  readonly device: string;
  readonly inode: string;
}
export interface OwnedStoreRoot {
  readonly root: string;
  readonly storeId: string;
  assertAuthority(): Promise<void>;
}
export const STORE_DIRECTORIES = ['installations', 'locks', 'references', 'stages'] as const;
const markerName = '.acp-installation-store.json';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function physicalIdentity(stat: { readonly dev: number | bigint; readonly ino: number | bigint }): PhysicalIdentity {
  return { device: String(stat.dev), inode: String(stat.ino) };
}
export function samePhysicalIdentity(left: PhysicalIdentity, right: PhysicalIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export async function inspectDirectory(directory: string, expected?: PhysicalIdentity): Promise<PhysicalIdentity> {
  const stat = await lstat(directory, { bigint: true });
  const identity = physicalIdentity(stat);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (expected && !samePhysicalIdentity(identity, expected))) {
    storeFailure('store_invalid', 'An owned installation directory was replaced or is not a real directory.');
  }
  return identity;
}

export async function syncDirectory(directory: string): Promise<boolean> {
  try {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    return true;
  } catch (cause) {
    if (process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'].some((code) => isFilesystemError(cause, code))) return false;
    throw cause;
  }
}

export async function writeOwnedFile(file: string, content: string): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

export async function readOwnedFile(file: string, maxBytes: number): Promise<string> {
  const selected = await lstat(file, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1n || selected.size > BigInt(maxBytes)) {
    storeFailure('store_invalid', 'An installation record is not a bounded private regular file.');
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes) || !samePhysicalIdentity(physicalIdentity(before), physicalIdentity(selected))) {
      storeFailure('store_invalid', 'An installation record is not a bounded private regular file.');
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) storeFailure('store_invalid', 'An installation record changed while being read.');
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || !samePhysicalIdentity(physicalIdentity(before), physicalIdentity(current)) || after.nlink !== 1n) {
      storeFailure('store_invalid', 'An installation record changed while being read.');
    }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch (cause) { return storeFailure('store_invalid', 'Installation records require valid UTF-8.', cause); }
  } finally { await handle.close(); }
}

async function existingAncestorAnchors(root: string): Promise<Anchor[]> {
  const parent = path.dirname(root);
  const filesystemRoot = path.parse(parent).root;
  const anchors: Anchor[] = [];
  let current = filesystemRoot;
  for (const segment of ['', ...parent.slice(filesystemRoot.length).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    anchors.push({ path: current, ...await inspectDirectory(current) });
  }
  if (await realpath(parent) !== parent) storeFailure('store_invalid', 'The store parent must use its canonical physical path.');
  return anchors;
}

async function assertPrivateRoot(root: string): Promise<void> {
  const stat = await lstat(root, { bigint: true });
  if ((process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n) || (process.getuid && stat.uid !== BigInt(process.getuid()))) {
    storeFailure('store_invalid', 'The installation root must remain private and owned by the current user.');
  }
}

function parseMarker(content: string): StoreMarker {
  let input: unknown;
  try { input = parseBoundedRegistryJson(content, { ...DEFAULT_ACP_REGISTRY_LIMITS, maxSnapshotBytes: 4_096, maxStringBytes: 2_048, maxDepth: 4, maxValues: 32 }); }
  catch (cause) { return storeFailure('store_invalid', 'The installation store marker is malformed.', cause); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) storeFailure('store_invalid', 'The installation store marker is invalid.');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'canonicalRoot,device,format,inode,storeId'
    || record.format !== 'acp-owned-installation-store-v1' || typeof record.storeId !== 'string' || !uuid.test(record.storeId)
    || typeof record.canonicalRoot !== 'string' || typeof record.device !== 'string' || !/^\d+$/u.test(record.device)
    || typeof record.inode !== 'string' || !/^\d+$/u.test(record.inode)) {
    storeFailure('store_invalid', 'The installation store marker is invalid.');
  }
  return record as unknown as StoreMarker;
}

export async function openOwnedStoreRoot(root: string): Promise<OwnedStoreRoot> {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root) {
    storeFailure('store_invalid', 'Select an absolute canonical installation root below an existing parent.');
  }
  const anchors = await existingAncestorAnchors(root);
  for (const anchor of anchors) await inspectDirectory(anchor.path, anchor);
  let created = false;
  try { await mkdir(root, { mode: 0o700 }); created = true; }
  catch (cause) { if (!isFilesystemError(cause, 'EEXIST')) throw cause; }
  const rootIdentity = await inspectDirectory(root);
  await assertPrivateRoot(root);
  const markerPath = path.join(root, markerName);
  if (created) {
    const assertOpeningAuthority = async () => {
      for (const anchor of anchors) await inspectDirectory(anchor.path, anchor);
      await inspectDirectory(root, rootIdentity);
      if (await realpath(root) !== root) storeFailure('store_invalid', 'The installation root changed during initialization.');
    };
    await assertOpeningAuthority();
    const marker: StoreMarker = { format: 'acp-owned-installation-store-v1', storeId: randomUUID(), canonicalRoot: root, ...rootIdentity };
    await writeOwnedFile(markerPath, JSON.stringify(marker));
    for (const directory of STORE_DIRECTORIES) { await assertOpeningAuthority(); await mkdir(path.join(root, directory), { mode: 0o700 }); }
    await syncDirectory(root);
    await syncDirectory(path.dirname(root));
  }
  let marker: StoreMarker;
  try { marker = parseMarker(await readOwnedFile(markerPath, 4_096)); }
  catch (cause) { return storeFailure('store_invalid', 'The selected directory is not a recognized owned installation store.', cause); }
  if (marker.canonicalRoot !== root || !samePhysicalIdentity(marker, rootIdentity)) {
    storeFailure('store_invalid', 'The installation root does not match its persisted physical identity.');
  }
  const markerIdentity = physicalIdentity(await lstat(markerPath, { bigint: true }));
  const markerDigest = canonicalDigest(marker);
  const directoryIdentities = await Promise.all(STORE_DIRECTORIES.map(async (directory) => ({ path: path.join(root, directory), ...await inspectDirectory(path.join(root, directory)) })));
  const assertAuthority = async () => {
    for (const anchor of [...anchors, ...directoryIdentities]) await inspectDirectory(anchor.path, anchor);
    await inspectDirectory(root, rootIdentity);
    await assertPrivateRoot(root);
    if (await realpath(root) !== root || !samePhysicalIdentity(physicalIdentity(await lstat(markerPath, { bigint: true })), markerIdentity)
      || canonicalDigest(parseMarker(await readOwnedFile(markerPath, 4_096))) !== markerDigest) {
      storeFailure('store_invalid', 'The owned installation root or marker changed.');
    }
    const names = (await readdir(root)).sort();
    if (names.join(',') !== [...STORE_DIRECTORIES, markerName].sort().join(',')) storeFailure('store_invalid', 'The installation root contains unrecognized entries.');
  };
  await assertAuthority();
  return { root, storeId: marker.storeId, assertAuthority };
}

export async function removeOwnedDirectory(authority: OwnedStoreRoot, directory: string, identity: PhysicalIdentity): Promise<void> {
  await authority.assertAuthority();
  await inspectDirectory(directory, identity);
  await rm(directory, { recursive: true });
  await authority.assertAuthority();
  await syncDirectory(path.dirname(directory));
}
