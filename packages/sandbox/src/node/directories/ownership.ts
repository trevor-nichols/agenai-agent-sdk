// ------------------------------------------------------------------------------------------------
//                ownership.ts - Disk-backed logical-path/inode ownership without an in-memory census
// ------------------------------------------------------------------------------------------------

import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxOperationError } from '../../errors.js';
import { parseSandboxRelativePath, parseSandboxSymlinkTarget } from '../../files/paths.js';
import { SANDBOX_LIMITS } from '../../policy/limits.js';
import { sameIdentity } from '../hostPath.js';
import { closeAfter } from './closing.js';

export type OwnedEntry =
  | Readonly<{ kind: 'directory' }>
  | Readonly<{ kind: 'file'; byteLength: number; executable: boolean }>
  | Readonly<{ kind: 'symlink'; target: string }>;

type OwnershipRecord = OwnedEntry & {
  readonly token: string;
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly markerDevice: string;
  readonly markerInode: string;
};

// Path and raw target can each double in JSON; fixed identity fields fit the remaining KiB.
const MAX_OWNERSHIP_RECORD_BYTES = 2 * (SANDBOX_LIMITS.maxPathBytes + SANDBOX_LIMITS.maxSymlinkTargetBytes) + 1024;

interface PendingMarker {
  readonly path: string;
  readonly fileStats: BigIntStats;
}

function identityName(fileStats: BigIntStats): string { return `${fileStats.dev}-${fileStats.ino}`; }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

export class DirectoryOwnership {
  private readonly handles = new Set<FileHandle>();
  private pending: PendingMarker | undefined;

  constructor(private readonly directory: string, private readonly token: string) {}

  async open(path: string, flags: number, mode?: number): Promise<FileHandle> {
    const handle = await open(path, flags, mode);
    this.handles.add(handle);
    return handle;
  }

  async closeFile(handle: FileHandle): Promise<void> {
    await handle.close();
    this.handles.delete(handle);
  }

  async remember(path: string, fileStats: BigIntStats, entry: OwnedEntry): Promise<void> {
    const marker = join(this.directory, identityName(fileStats));
    let handle: FileHandle;
    try { handle = await this.open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = await this.lookup(fileStats, entry.kind);
      if (existing.path !== path || existing.kind !== entry.kind
        || existing.kind === 'file' && (entry.kind !== 'file' || existing.byteLength !== entry.byteLength || existing.executable !== entry.executable)
        || existing.kind === 'symlink' && (entry.kind !== 'symlink' || existing.target !== entry.target)) {
        throw new SandboxOperationError('output_limit', 'Host filesystem path aliases or replaces another owned entry.');
      }
      return;
    }
    await closeAfter(async () => {
      const own = await handle.stat({ bigint: true });
      this.pending = { path: marker, fileStats: own };
      const record: OwnershipRecord = { token: this.token, path, device: String(fileStats.dev), inode: String(fileStats.ino),
        markerDevice: String(own.dev), markerInode: String(own.ino), ...entry };
      const encoded = JSON.stringify(record);
      if (Buffer.byteLength(encoded) > MAX_OWNERSHIP_RECORD_BYTES) throw new Error('Directory ownership record exceeds its representation bound.');
      await handle.writeFile(encoded);
      this.pending = undefined;
    }, () => this.closeFile(handle));
  }

  async lookup(fileStats: BigIntStats, kind: OwnedEntry['kind']): Promise<OwnershipRecord> {
    const record = await this.readMarker(join(this.directory, identityName(fileStats)));
    if (record.kind !== kind || record.device !== String(fileStats.dev) || record.inode !== String(fileStats.ino)) {
      throw new Error('Output inode does not match its retained ownership marker.');
    }
    return record;
  }

  async forget(fileStats: BigIntStats): Promise<void> {
    const path = join(this.directory, identityName(fileStats));
    await this.readMarker(path);
    await unlink(path);
  }

  async readMarker(path: string): Promise<OwnershipRecord> {
    const handle = await this.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return closeAfter<OwnershipRecord>(async () => {
      const fileStats = await handle.stat({ bigint: true });
      if (!fileStats.isFile() || fileStats.size < 1n || fileStats.size > BigInt(MAX_OWNERSHIP_RECORD_BYTES)) throw new Error('Unrecognized directory ownership marker.');
      const bytes = new Uint8Array(Number(fileStats.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (!bytesRead) throw new Error('Directory ownership marker is truncated.');
        offset += bytesRead;
      }
      const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!record || typeof record !== 'object' || !('token' in record) || record.token !== this.token
        || !('path' in record) || typeof record.path !== 'string' || !('kind' in record)
        || (record.kind !== 'file' && record.kind !== 'directory' && record.kind !== 'symlink')
        || !('device' in record) || typeof record.device !== 'string' || !/^[0-9]+$/u.test(record.device)
        || !('inode' in record) || typeof record.inode !== 'string' || !/^[0-9]+$/u.test(record.inode)
        || !('markerDevice' in record) || record.markerDevice !== String(fileStats.dev)
        || !('markerInode' in record) || record.markerInode !== String(fileStats.ino)) throw new Error('Unrecognized directory ownership marker.');
      const shared = ['token', 'path', 'kind', 'device', 'inode', 'markerDevice', 'markerInode'];
      const allowed = record.kind === 'file' ? [...shared, 'byteLength', 'executable']
        : record.kind === 'symlink' ? [...shared, 'target'] : shared;
      if (Object.keys(record).length !== allowed.length || Object.keys(record).some((key) => !allowed.includes(key))) {
        throw new Error('Ownership marker has unrecognized fields.');
      }
      parseSandboxRelativePath(record.path);
      const common = { token: this.token, path: record.path, device: record.device, inode: record.inode,
        markerDevice: String(fileStats.dev), markerInode: String(fileStats.ino) };
      if (record.kind === 'file') {
        if (!('byteLength' in record) || typeof record.byteLength !== 'number' || !Number.isSafeInteger(record.byteLength) || record.byteLength < 0
          || !('executable' in record) || typeof record.executable !== 'boolean') throw new Error('Invalid file ownership marker.');
        return { ...common, kind: 'file', byteLength: record.byteLength, executable: record.executable };
      }
      if (record.kind === 'symlink') {
        if (!('target' in record)) throw new Error('Missing symbolic-link ownership target.');
        return { ...common, kind: 'symlink', target: parseSandboxSymlinkTarget(record.target) };
      }
      return { ...common, kind: 'directory' };
    }, () => this.closeFile(handle));
  }

  async closeHandles(): Promise<void> {
    let failure: Readonly<{ error: unknown }> | undefined;
    for (const handle of this.handles) {
      try { await this.closeFile(handle); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
    const pending = this.pending;
    if (pending) {
      let fileStats: BigIntStats;
      try { fileStats = await lstat(pending.path, { bigint: true }); }
      catch (error) { if (!missing(error)) throw error; this.pending = undefined; return; }
      if (!fileStats.isFile() || !sameIdentity(fileStats, pending.fileStats)) throw new Error('Partial ownership marker was replaced; it is preserved.');
      await unlink(pending.path);
      this.pending = undefined;
    }
  }
}
