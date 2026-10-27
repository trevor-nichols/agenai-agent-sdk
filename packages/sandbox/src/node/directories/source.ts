// ------------------------------------------------------------------------------------------------
//                source.ts - Incremental trusted-root traversal with depth-bounded directory handles
// ------------------------------------------------------------------------------------------------

import { Dir } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxOperationError, SandboxStateError } from '../../errors.js';
import { parseSandboxRelativePath, parseSandboxSymlinkTarget } from '../../files/paths.js';
import type { SandboxTreeEntry } from '../../files/types.js';
import { verifyDirectoryIdentity } from '../hostPath.js';
import { DirectoryFile } from './file.js';
import { readStableLink } from './link.js';

interface DirectoryCursor {
  readonly path: string;
  readonly relative: string;
  readonly metadata: BigIntStats;
  readonly directory: Dir;
}

export class DirectorySource implements AsyncIterable<SandboxTreeEntry> {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly directories: DirectoryCursor[] = [];
  private file: DirectoryFile | undefined;
  private opening: Promise<void> | undefined;
  private pending: Promise<IteratorResult<SandboxTreeEntry>> | undefined;
  private closing: Promise<void> | undefined;
  private phase: 'ready' | 'reading' | 'closing' | 'closed' = 'ready';
  private iterated = false;

  constructor(private readonly root: string, private readonly rootMetadata: BigIntStats,
    private readonly chunkBytes: number, signal?: AbortSignal, private readonly preserveSymlinks = false) {
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
  }

  [Symbol.asyncIterator](): AsyncIterator<SandboxTreeEntry> {
    if (this.iterated || this.phase !== 'ready') throw new SandboxStateError('Host directory sources admit one transfer iterator.');
    this.iterated = true;
    this.phase = 'reading';
    return { next: () => this.next(), return: async () => { await this.close(); return { done: true, value: undefined }; } };
  }

  private next(): Promise<IteratorResult<SandboxTreeEntry>> {
    if (this.phase !== 'reading' || this.pending) return Promise.reject(new SandboxStateError('Host traversal requires one active iterator pull.'));
    const actual = this.pull();
    this.pending = actual;
    void actual.then(() => { this.pending = undefined; }, () => { this.pending = undefined; });
    return actual;
  }

  private async pull(): Promise<IteratorResult<SandboxTreeEntry>> {
    this.check();
    if (this.file) { await this.file.close(); this.file = undefined; }
    if (!this.opening) this.opening = this.openDirectory(this.root, '', this.rootMetadata);
    await this.opening;
    this.check();
    while (true) {
      const current = this.directories.at(-1);
      if (!current) return { done: true, value: undefined };
      await this.verifyParents();
      this.check();
      const entry = await current.directory.read();
      this.check();
      if (!entry) { await current.directory.close(); this.directories.pop(); continue; }
      const rawName: unknown = entry.name;
      if (!(rawName instanceof Uint8Array)) throw new SandboxOperationError('input_limit', 'Host directory traversal requires raw UTF-8 names.');
      const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawName);
      const relative = parseSandboxRelativePath(current.relative ? `${current.relative}/${name}` : name);
      const path = join(current.path, name);
      const metadata = await lstat(path, { bigint: true });
      this.check();
      if (metadata.isDirectory()) {
        await this.openDirectory(path, relative, metadata);
        return { done: false, value: Object.freeze({ kind: 'directory', path: relative }) };
      }
      if (metadata.isSymbolicLink() && this.preserveSymlinks) {
        const target = parseSandboxSymlinkTarget(await readStableLink(path, metadata, this.signal));
        await this.verifyParents();
        this.check();
        return { done: false, value: Object.freeze({ kind: 'symlink', path: relative, target }) };
      }
      if (!metadata.isFile() || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new SandboxOperationError('input_limit', 'Host imports require regular files and directories with representable lengths; links and special files are rejected.');
      }
      const file = new DirectoryFile(path, metadata, this.signal, this.chunkBytes, () => this.verifyParents());
      this.file = file;
      return { done: false, value: Object.freeze({ kind: 'file', path: relative, byteLength: Number(metadata.size),
        executable: (metadata.mode & 0o111n) !== 0n, open: (input: Readonly<{ signal: AbortSignal }>) => file.open(input) }) };
    }
  }

  private async openDirectory(path: string, relative: string, metadata: BigIntStats): Promise<void> {
    this.check();
    await verifyDirectoryIdentity(path, metadata);
    this.check();
    // Node supports raw names here; its current declarations omit the buffer encoding variant.
    const opened: unknown = await Reflect.apply(opendir, undefined, [path, { bufferSize: 32, encoding: 'buffer' }]);
    if (!(opened instanceof Dir)) throw new SandboxOperationError('input_limit', 'Host directory acquisition returned an unsupported handle.');
    const directory = opened;
    this.directories.push({ path, relative, metadata, directory });
    await verifyDirectoryIdentity(path, metadata);
    this.check();
  }

  private async verifyParents(): Promise<void> {
    this.check();
    for (const directory of this.directories) { await verifyDirectoryIdentity(directory.path, directory.metadata); this.check(); }
  }

  close(): Promise<void> {
    if (this.phase === 'closed') return Promise.resolve();
    if (this.closing) return this.closing;
    this.phase = 'closing';
    this.controller.abort(new SandboxStateError('Host directory source is closing.'));
    this.closing = (async () => {
      await this.pending?.catch(() => {});
      const failures: unknown[] = [];
      if (this.file) {
        try { await this.file.close(); this.file = undefined; } catch (error) { failures.push(error); }
      }
      for (let index = this.directories.length - 1; index >= 0; index -= 1) {
        const directory = this.directories[index];
        if (!directory) continue;
        try { await directory.directory.close(); this.directories.splice(index, 1); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Host source handles retain cleanup ownership.');
      this.phase = 'closed';
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private check(): void {
    this.signal.throwIfAborted();
    if (this.phase !== 'reading') throw new SandboxStateError('Host directory source admission is closed.');
  }
}
