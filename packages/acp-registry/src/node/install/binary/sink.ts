import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, symlink } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import type { AcpInstallationLimits } from '../contracts.js';
import { AcpInstallationError } from '../errors.js';
import { writeAll } from '../artifacts/acquire.js';
import { archiveLinkTarget, archivePath, parentArchivePaths, relativeArchiveTarget } from './paths.js';

export interface ArchiveEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'hardlink';
  readonly size: number;
  readonly mode: number;
  readonly target?: string;
}

export interface ArchiveSinkInput {
  readonly payloadRoot?: string;
  readonly limits: AcpInstallationLimits;
  readonly signal?: AbortSignal;
  readonly rejectLinks?: boolean;
  readonly caseInsensitive?: boolean;
  readonly readFiles?: readonly string[];
}

export class ArchiveSink {
  private readonly entries = new Map<string, ArchiveEntry>();
  private readonly explicitPaths = new Set<string>();
  private readonly casePaths = new Map<string, string>();
  private bytes = 0;
  private count = 0;
  private capturedBytes = 0;
  readonly files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;

  constructor(private readonly input: ArchiveSinkInput) {
    this.entries.set('', { path: '', kind: 'directory', size: 0, mode: 0o700 });
  }

  async initialize(): Promise<void> {
    const root = this.input.payloadRoot;
    if (root === undefined) return;
    if (!isAbsolute(root)) throw new AcpInstallationError('store_invalid', 'Extraction requires an absolute private payload directory.');
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(root)).length !== 0) {
      throw new AcpInstallationError('store_invalid', 'Extraction requires an empty private payload directory.');
    }
  }

  async entry(input: ArchiveEntry, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    this.input.signal?.throwIfAborted();
    this.count += 1;
    if (this.count > this.input.limits.maxEntries) throw new AcpInstallationError('limit_exceeded', 'The archive contains too many entries.');
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw new AcpInstallationError('unsafe_archive', 'Archive entries must declare exact nonnegative sizes.');
    const path = archivePath(input.path, input.kind === 'directory', this.input.limits);
    if (this.explicitPaths.has(path)) throw new AcpInstallationError('unsafe_archive', 'The archive contains duplicate normalized paths.');
    this.explicitPaths.add(path);
    for (const parent of parentArchivePaths(path)) {
      this.assertCase(parent);
      const existing = this.entries.get(parent);
      if (existing && existing.kind !== 'directory') throw new AcpInstallationError('unsafe_archive', 'An archive entry would traverse a non-directory or link.');
      this.remember(existing ?? { path: parent, kind: 'directory', size: 0, mode: 0o700 });
    }
    this.assertCase(path);
    const previous = this.entries.get(path);
    if (previous && (previous.kind !== 'directory' || input.kind !== 'directory')) throw new AcpInstallationError('unsafe_archive', 'An archive entry conflicts with an existing payload path.');
    const entry = { ...input, path };
    if (entry.kind === 'symlink' || entry.kind === 'hardlink') {
      if (this.input.rejectLinks) throw new AcpInstallationError('unsafe_archive', 'Package archives containing links are unsupported.');
      archiveLinkTarget(entry.target ?? '', this.input.limits);
    } else if (entry.target) throw new AcpInstallationError('unsafe_archive', 'A regular archive entry carries unexpected link metadata.');
    if (entry.kind !== 'file' && entry.size !== 0) throw new AcpInstallationError('unsafe_archive', 'Non-file archive entries cannot carry file data.');
    this.remember(entry);
    if (entry.kind === 'directory') {
      await this.ensureDirectory(path);
      await this.consume(chunks, 0);
      return;
    }
    if (entry.kind !== 'file') { await this.consume(chunks, 0); return; }
    if (entry.size > this.input.limits.maxPayloadBytes - this.bytes) throw new AcpInstallationError('limit_exceeded', 'Archive file data exceeds the payload budget.');
    await this.ensureDirectory(posix.dirname(path) === '.' ? '' : posix.dirname(path));
    const root = this.input.payloadRoot;
    const mode = 0o600 | (entry.mode & 0o111 ? 0o100 : 0);
    const handle = root === undefined ? undefined : await open(join(root, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    let observed = 0;
    const captured: Buffer[] | undefined = this.input.readFiles?.includes(path) ? [] : undefined;
    try {
      for await (const chunk of chunks) {
        this.input.signal?.throwIfAborted();
        observed += chunk.byteLength;
        this.bytes += chunk.byteLength;
        if (observed > entry.size || this.bytes > this.input.limits.maxPayloadBytes) throw new AcpInstallationError('limit_exceeded', 'Archive file data exceeds its declared size or the payload budget.');
        if (handle) await writeAll(handle, chunk);
        if (captured) {
          this.capturedBytes += chunk.byteLength;
          if (this.capturedBytes > this.input.limits.maxReceiptBytes) throw new AcpInstallationError('limit_exceeded', 'Captured archive metadata exceeds the configured byte budget.');
          captured.push(Buffer.from(chunk));
        }
      }
      if (observed !== entry.size) throw new AcpInstallationError('unsafe_archive', 'An archive file ended before its declared size.');
      if (captured) this.files[path] = Buffer.concat(captured, observed);
    } finally { await handle?.close(); }
  }

  async finish(): Promise<void> {
    const resolutions = new Map<string, string>();
    for (const entry of this.entries.values()) {
      if (entry.kind === 'symlink' || entry.kind === 'hardlink') {
        const target = this.resolveLink(entry, new Set());
        if (entry.kind === 'hardlink' && this.entries.get(target)?.kind !== 'file') throw new AcpInstallationError('unsafe_archive', 'Archive hardlinks must resolve to regular files.');
        resolutions.set(entry.path, target);
      }
    }
    const root = this.input.payloadRoot;
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'hardlink') continue;
      const target = resolutions.get(entry.path)!;
      const source = this.entries.get(target)!;
      if (source.size > this.input.limits.maxPayloadBytes - this.bytes) throw new AcpInstallationError('limit_exceeded', 'Materialized hardlinks exceed the payload byte budget.');
      this.bytes += source.size;
      if (root !== undefined) {
        this.input.signal?.throwIfAborted();
        await this.ensureDirectory(posix.dirname(entry.path) === '.' ? '' : posix.dirname(entry.path));
        await copyFile(join(root, target), join(root, entry.path), constants.COPYFILE_EXCL);
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'symlink' || root === undefined) continue;
      this.input.signal?.throwIfAborted();
      await this.ensureDirectory(posix.dirname(entry.path) === '.' ? '' : posix.dirname(entry.path));
      const target = relativeArchiveTarget(entry.path, resolutions.get(entry.path)!);
      archiveLinkTarget(target, this.input.limits);
      await symlink(target, join(root, entry.path));
    }
  }

  private resolveLink(entry: ArchiveEntry, active: Set<string>): string {
    if (active.has(entry.path)) throw new AcpInstallationError('unsafe_archive', 'Archive links cannot contain cycles.');
    if (active.size >= this.input.limits.maxPathDepth) throw new AcpInstallationError('limit_exceeded', 'Archive link chains exceed the configured depth.');
    active.add(entry.path);
    try {
      const base = entry.kind === 'hardlink' ? [] : entry.path.split('/').slice(0, -1);
      return this.resolveSegments(base, archiveLinkTarget(entry.target ?? '', this.input.limits), active);
    } finally { active.delete(entry.path); }
  }

  private resolveSegments(base: readonly string[], segments: readonly string[], active: Set<string>): string {
    let current = [...base];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (segment === '.') continue;
      if (segment === '..') {
        if (current.length === 0) throw new AcpInstallationError('unsafe_archive', 'An archive link escapes the payload directory.');
        current.pop();
      } else current.push(segment);
      if (current.length > this.input.limits.maxPathDepth) throw new AcpInstallationError('limit_exceeded', 'An archive link resolution exceeds the path depth limit.');
      const path = current.join('/');
      const entry = this.entries.get(path);
      if (!entry) throw new AcpInstallationError('unsafe_archive', 'Archive links must resolve to retained payload entries.');
      if (entry.kind === 'symlink' || entry.kind === 'hardlink') current = this.resolveLink(entry, active).split('/').filter(Boolean);
      const resolved = this.entries.get(current.join('/'));
      if (index < segments.length - 1 && resolved?.kind !== 'directory') throw new AcpInstallationError('unsafe_archive', 'An archive link target traverses a non-directory.');
    }
    return current.join('/');
  }

  private assertCase(path: string): void {
    if (!this.input.caseInsensitive) return;
    const key = path.toLowerCase();
    const prior = this.casePaths.get(key);
    if (prior !== undefined && prior !== path) throw new AcpInstallationError('unsafe_archive', 'Archive paths collide on the target filesystem.');
    this.casePaths.set(key, path);
  }

  private remember(entry: ArchiveEntry): void {
    if (!this.entries.has(entry.path) && this.entries.size - 1 >= this.input.limits.maxEntries) {
      throw new AcpInstallationError('limit_exceeded', 'Extracted files and implicit directories exceed the payload entry budget.');
    }
    this.entries.set(entry.path, entry);
  }

  private async ensureDirectory(path: string): Promise<void> {
    const root = this.input.payloadRoot;
    if (root === undefined || !path) return;
    const components = path.split('/');
    for (let index = 1; index <= components.length; index += 1) {
      const directory = join(root, ...components.slice(0, index));
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AcpInstallationError('unsafe_archive', 'An archive path traverses a link or non-directory.');
    }
  }

  private async consume(chunks: AsyncIterable<Uint8Array>, expected: number): Promise<void> {
    let size = 0;
    for await (const chunk of chunks) { this.input.signal?.throwIfAborted(); size += chunk.byteLength; if (size > expected) throw new AcpInstallationError('unsafe_archive', 'An archive metadata entry contains unexpected file data.'); }
  }
}
