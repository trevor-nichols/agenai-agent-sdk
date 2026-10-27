// ------------------------------------------------------------------------------------------------
//                stage.ts - Exclusive output namespace, joined sink work and exact staged ownership
// ------------------------------------------------------------------------------------------------

import { constants } from 'node:fs';
import type { BigIntStats, Dir } from 'node:fs';
import { lstat, mkdir, opendir, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { SandboxOperationError, SandboxStateError } from '../../errors.js';
import { parseSandboxRelativePath, parseSandboxSymlinkTarget } from '../../files/paths.js';
import type { SandboxExportEntry } from '../../files/types.js';
import type { SandboxRelativePath } from '../../files/types.js';
import { createMetadataLedger } from '../../files/metadata/index.js';
import type { MetadataLedger } from '../../files/metadata/index.js';
import type { SandboxDriverSpillStore } from '../../backend/spill.js';
import { SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '../../policy/limits.js';
import { sameIdentity, verifyDirectoryIdentity } from '../hostPath.js';
import { createSandboxSpillStore } from '../spill.js';
import { DirectoryOwnership } from './ownership.js';
import { closeAfter } from './closing.js';
import { readStableLink } from './link.js';

interface OwnedDirectory { readonly path: string; readonly metadata: BigIntStats }
interface UnregisteredEntry extends OwnedDirectory { readonly kind: 'file' | 'directory' | 'symlink' }
interface StageOptions {
  readonly signal?: AbortSignal;
  readonly symlinks: 'reject' | 'preserve_internal';
  readonly root?: SandboxRelativePath;
}

function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

export class DirectoryStage {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly token = randomUUID();
  private namespace: OwnedDirectory | undefined;
  private stage: OwnedDirectory | undefined;
  private markers: OwnedDirectory | undefined;
  private ownership: DirectoryOwnership | undefined;
  private graph: MetadataLedger | undefined;
  private spill: SandboxDriverSpillStore | undefined;
  private unregistered: UnregisteredEntry | undefined;
  private active: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private accepting = true;
  private published = false;
  private closed = false;
  private readonly unverified = new Set<string>();
  private readonly directoryHandles = new Set<Dir>();
  readonly directory: string;

  constructor(readonly destination: string, private readonly parent: BigIntStats, private readonly options: StageOptions) {
    this.signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal;
    this.directory = join(destination, 'files');
  }

  get publishedDirectory(): string | undefined { return this.published ? this.directory : undefined; }

  async initialize(): Promise<void> {
    this.check();
    await verifyDirectoryIdentity(dirname(this.destination), this.parent);
    await mkdir(this.destination, { mode: 0o700 });
    this.unverified.add(this.destination);
    this.namespace = { path: this.destination, metadata: await lstat(this.destination, { bigint: true }) };
    this.unverified.delete(this.destination);
    this.check();
    const stage = join(this.destination, `.staging-${this.token}`);
    await mkdir(stage, { mode: 0o700 });
    this.unverified.add(stage);
    this.stage = { path: stage, metadata: await lstat(stage, { bigint: true }) };
    this.unverified.delete(stage);
    this.check();
    const markers = join(this.destination, `.metadata-${this.token}`);
    await mkdir(markers, { mode: 0o700 });
    this.unverified.add(markers);
    this.markers = { path: markers, metadata: await lstat(markers, { bigint: true }) };
    this.unverified.delete(markers);
    this.ownership = new DirectoryOwnership(markers, this.token);
    if (this.options.symlinks === 'preserve_internal') {
      const spill = await createSandboxSpillStore({ directory: markers, signal: this.signal });
      this.spill = spill;
      this.graph = await createMetadataLedger({ openSpill: async () => spill,
        batchBytes: SANDBOX_DEFAULT_TRANSFER_BUFFERS.metadataBatchBytes,
        fanIn: SANDBOX_DEFAULT_TRANSFER_BUFFERS.metadataMergeFanIn, signal: this.signal });
    }
    this.check();
  }

  consume(entry: SandboxExportEntry, input: Readonly<{ signal: AbortSignal }>): Promise<void> {
    if (!this.accepting || this.active) return Promise.reject(new SandboxStateError('Directory sink is closed or already consuming an entry.'));
    const actual = Promise.resolve().then(() => this.write(entry, AbortSignal.any([input.signal, this.signal])));
    this.active = actual;
    void actual.then(() => { this.active = undefined; }, (error: unknown) => {
      this.active = undefined;
      this.fence(error);
    });
    return actual;
  }

  private async write(entry: SandboxExportEntry, signal: AbortSignal): Promise<void> {
    this.check(); signal.throwIfAborted();
    await this.verifyRoots();
    this.check(); signal.throwIfAborted();
    const relative = parseSandboxRelativePath(entry.path);
    if (entry.kind === 'symlink') {
      if (!this.graph) throw new SandboxOperationError('output_limit', 'Directory export requires explicit internal symbolic-link preservation.');
      await this.graph.append({ kind: 'symlink', path: relative, target: parseSandboxSymlinkTarget(entry.target) });
    } else await this.graph?.append({ kind: entry.kind, path: relative });
    const stage = this.readyStage();
    const ownership = this.readyOwnership();
    const segments = relative.split('/');
    const directories = entry.kind === 'directory' ? segments : segments.slice(0, -1);
    let parent = stage.path;
    let logical = '';
    for (const segment of directories) {
      this.check(); signal.throwIfAborted();
      logical = logical ? `${logical}/${segment}` : segment;
      parent = join(parent, segment);
      let created = false;
      try { await mkdir(parent, { mode: 0o700 }); created = true; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      const metadata = await lstat(parent, { bigint: true });
      if (!metadata.isDirectory()) throw new SandboxOperationError('output_limit', 'Export directory was replaced by a link or non-directory.');
      if (created) this.unregistered = { path: parent, metadata, kind: 'directory' };
      await ownership.remember(logical, metadata, { kind: 'directory' });
      this.unregistered = undefined;
    }
    if (entry.kind === 'directory' || entry.kind === 'symlink') return;
    this.check(); signal.throwIfAborted();
    const path = join(stage.path, ...segments);
    const handle = await ownership.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      entry.executable ? 0o700 : 0o600);
    await closeAfter(async () => {
      const metadata = await handle.stat({ bigint: true });
      this.unregistered = { path, metadata, kind: 'file' };
      await ownership.remember(relative, metadata, { kind: 'file', byteLength: entry.byteLength, executable: entry.executable });
      this.unregistered = undefined;
      let offset = 0;
      for await (const chunk of entry.bytes) {
        this.check(); signal.throwIfAborted();
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > entry.byteLength - offset) throw new Error('Export file body exceeds its declared length.');
        let written = 0;
        while (written < chunk.byteLength) {
          const result = await handle.write(chunk, written, chunk.byteLength - written, offset);
          if (!result.bytesWritten) throw new Error('Export file write made no progress.');
          written += result.bytesWritten;
          offset += result.bytesWritten;
          this.check(); signal.throwIfAborted();
        }
      }
      if (offset !== entry.byteLength) throw new Error('Export file body ended before its declared length.');
      this.check(); signal.throwIfAborted();
    }, () => ownership.closeFile(handle));
  }

  fence(reason: unknown): void {
    this.accepting = false;
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  async publish(): Promise<void> {
    await this.active;
    this.check();
    await this.verifyRoots();
    await this.readyOwnership().closeHandles();
    if (this.graph) {
      await this.graph.finish();
      await this.graph.validateSymlinks(this.options.root === undefined ? undefined : { root: this.options.root });
      await this.walk(this.readyStage().path, '', false);
      await this.verifyMarkers();
      await this.installLinks();
      await this.closeGraph();
    }
    await this.walk(this.readyStage().path, '', false);
    await this.verifyMarkers();
    this.check();
    try { await lstat(this.directory); throw new Error('Published child already exists and is preserved.'); }
    catch (error) { if (!missing(error)) throw error; }
    // The caller grants exclusive ownership of this fresh private namespace; portable rename is not no-replace.
    await rename(this.readyStage().path, this.directory);
    this.published = true;
    this.stage = undefined;
    this.accepting = false;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.fence(new SandboxStateError('Directory sink is closing.'));
    this.closing = (async () => {
      await this.active?.catch(() => {});
      await this.closeGraph();
      await this.ownership?.closeHandles();
      await this.closeDirectories();
      if (this.unverified.size) throw new Error('An acquired output directory has no verified identity and is preserved.');
      if (!this.namespace) { this.closed = true; return; }
      await this.verifyRoots();
      if (this.unregistered) {
        const entry = this.unregistered;
        const current = await lstat(entry.path, { bigint: true });
        if (!sameIdentity(current, entry.metadata)) throw new Error('Partially acquired output entry was replaced and is preserved.');
        if (entry.kind === 'directory') await rmdir(entry.path); else await unlink(entry.path);
        this.unregistered = undefined;
      }
      if (this.stage) {
        if (this.ownership) await this.walk(this.stage.path, '', true);
        await rmdir(this.stage.path);
        this.stage = undefined;
      }
      await this.removeMarkers();
      if (!this.published) await rmdir(this.namespace.path);
      this.closed = true;
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async walk(path: string, relative: string, remove: boolean): Promise<void> {
    const directory = await this.openDirectory(path);
    await closeAfter(async () => {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        const child = join(path, entry.name);
        const metadata = await lstat(child, { bigint: true });
        const kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : metadata.isSymbolicLink() ? 'symlink' : undefined;
        if (!kind) throw new Error('Unknown link or special output entry is preserved.');
        const record = await this.readyOwnership().lookup(metadata, kind);
        const separator = record.path.lastIndexOf('/');
        const parent = separator < 0 ? '' : record.path.slice(0, separator);
        const declared = await lstat(join(this.readyStage().path, ...record.path.split('/')), { bigint: true });
        const logical = relative ? `${relative}/${entry.name}` : entry.name;
        if (parent !== relative || record.path !== logical || !sameIdentity(declared, metadata)
          || (kind !== 'directory' && metadata.nlink !== 1n)) {
          throw new Error('An unexpected alias or relocated output entry is preserved.');
        }
        if (record.kind === 'directory') await this.walk(child, record.path, remove);
        else if (record.kind === 'file' && !remove && (metadata.size !== BigInt(record.byteLength) || ((metadata.mode & 0o111n) !== 0n) !== record.executable)) {
          throw new Error('Staged output file length or executable mode changed.');
        }
        else if (record.kind === 'symlink' && await readStableLink(child, metadata, remove ? undefined : this.signal) !== record.target) {
          throw new Error('Staged symbolic-link target changed.');
        }
        if (remove) {
          if (kind === 'directory') await rmdir(child); else await unlink(child);
          await this.readyOwnership().forget(metadata);
        }
      }
    }, () => this.closeDirectory(directory));
  }

  private async removeMarkers(): Promise<void> {
    if (!this.markers) return;
    const markers = this.markers;
    const directory = await this.openDirectory(markers.path);
    await closeAfter(async () => {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        const path = join(markers.path, entry.name);
        const record = await this.readyOwnership().readMarker(path);
        if (entry.name !== `${record.device}-${record.inode}`) throw new Error('Unexpected control entry is preserved.');
        await unlink(path);
      }
    }, () => this.closeDirectory(directory));
    await rmdir(markers.path);
    this.markers = undefined;
  }

  private async verifyMarkers(): Promise<void> {
    if (!this.markers) throw new SandboxStateError('Directory ownership storage is not acquired.');
    const markers = this.markers;
    const directory = await this.openDirectory(markers.path);
    await closeAfter(async () => {
      while (true) {
        this.check();
        const entry = await directory.read();
        if (!entry) break;
        const record = await this.readyOwnership().readMarker(join(markers.path, entry.name));
        if (entry.name !== `${record.device}-${record.inode}`) throw new Error('Unexpected control entry is preserved.');
        const metadata = await lstat(join(this.readyStage().path, ...record.path.split('/')), { bigint: true });
        if (String(metadata.dev) !== record.device || String(metadata.ino) !== record.inode
          || (record.kind === 'directory' ? !metadata.isDirectory() : record.kind === 'file'
            ? !metadata.isFile() || metadata.size !== BigInt(record.byteLength) || metadata.nlink !== 1n
              || ((metadata.mode & 0o111n) !== 0n) !== record.executable
            : !metadata.isSymbolicLink() || metadata.nlink !== 1n
              || await readStableLink(join(this.readyStage().path, ...record.path.split('/')), metadata, this.signal) !== record.target)) {
          throw new Error('An expected staged entry was changed or replaced before publication.');
        }
      }
    }, () => this.closeDirectory(directory));
  }

  private async installLinks(): Promise<void> {
    if (!this.graph) return;
    for await (const record of this.graph.records()) {
      if (record.kind !== 'symlink') continue;
      this.check();
      await this.verifyRoots();
      const segments = record.path.split('/');
      for (let count = 1; count < segments.length; count += 1) {
        const relative = segments.slice(0, count).join('/');
        const current = await lstat(join(this.readyStage().path, ...segments.slice(0, count)), { bigint: true });
        if (!current.isDirectory() || (await this.readyOwnership().lookup(current, 'directory')).path !== relative) {
          throw new Error('Symbolic-link parent no longer matches its owned directory.');
        }
      }
      const path = join(this.readyStage().path, ...segments);
      await symlink(record.target, path);
      this.unverified.add(path);
      const current = await lstat(path, { bigint: true });
      this.unregistered = { path, metadata: current, kind: 'symlink' };
      this.unverified.delete(path);
      await this.readyOwnership().remember(record.path, current, { kind: 'symlink', target: record.target });
      this.unregistered = undefined;
      if (await readStableLink(path, current, this.signal) !== record.target) throw new Error('Symbolic-link publication target changed.');
    }
  }

  private async closeGraph(): Promise<void> {
    if (this.graph) await this.graph.close();
    else await this.spill?.close();
    this.graph = undefined;
    this.spill = undefined;
  }

  private async openDirectory(path: string): Promise<Dir> {
    const directory = await opendir(path, { bufferSize: 32 });
    this.directoryHandles.add(directory);
    return directory;
  }

  private async closeDirectory(directory: Dir): Promise<void> {
    await directory.close();
    this.directoryHandles.delete(directory);
  }

  private async closeDirectories(): Promise<void> {
    let failure: Readonly<{ error: unknown }> | undefined;
    for (const directory of this.directoryHandles) {
      try { await this.closeDirectory(directory); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
  }

  private async verifyRoots(): Promise<void> {
    await verifyDirectoryIdentity(dirname(this.destination), this.parent);
    if (this.namespace) await verifyDirectoryIdentity(this.namespace.path, this.namespace.metadata);
    if (this.stage) await verifyDirectoryIdentity(this.stage.path, this.stage.metadata);
    if (this.markers) await verifyDirectoryIdentity(this.markers.path, this.markers.metadata);
  }

  private readyStage(): OwnedDirectory {
    if (!this.stage) throw new SandboxStateError('Directory staging is not acquired.');
    return this.stage;
  }

  private readyOwnership(): DirectoryOwnership {
    if (!this.ownership) throw new SandboxStateError('Directory ownership storage is not acquired.');
    return this.ownership;
  }

  private check(): void {
    this.signal.throwIfAborted();
    if (!this.accepting) throw new SandboxStateError('Directory sink admission is closed.');
  }
}
