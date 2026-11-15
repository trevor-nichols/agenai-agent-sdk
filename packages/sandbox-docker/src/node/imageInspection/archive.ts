import { createHash } from 'node:crypto';
import { SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import { DOCKER_API } from '../../policy/config.js';
import type { DockerApi } from '../../resources/api.js';
import { pathStat, sameStat } from '../../workspace/stat.js';
import type { DockerPathStat } from '../../workspace/stat.js';
import { archiveName } from '../../workspace/paths.js';
import { readTar } from '../../workspace/tar/decode.js';
import { BLOCK_BYTES, MAX_PAX_BYTES, parseHeader } from '../../workspace/tar/header.js';
import { parsePax } from '../../workspace/tar/pax.js';
import { TarReader } from '../../workspace/tar/reader.js';
import type { TarHeader, TarOptions, TarOutputEntry } from '../../workspace/tar/contracts.js';
import type { DockerImageFileObservation, DockerImageFileSelection, DockerImageInspectionLimits } from './contracts.js';

const CHUNK_BYTES = 65_536;
const MODE_TYPE = 0x8f28_0000;
const MODE_DIRECTORY = 0x8000_0000;
const MODE_SYMLINK = 0x0800_0000;
function invalid(message: string): never { throw new SandboxStateError(`Docker image inspection: ${message}`); }
const limit = (): never => { throw new SandboxOperationError('output_limit', 'Docker image inspection exceeds its cumulative file, member, payload or wire byte limit.'); };

function statKind(stat: DockerPathStat, path: string, kind: 'file' | 'directory' | 'symlink'): void {
  const type = (stat.mode & MODE_TYPE) >>> 0;
  const expectedName = path === '/' ? stat.name === '/' || stat.name === '.' : stat.name === path.slice(path.lastIndexOf('/') + 1);
  if (!expectedName || type !== (kind === 'directory' ? MODE_DIRECTORY : kind === 'symlink' ? MODE_SYMLINK : 0)
    || kind !== 'symlink' && stat.linkTarget !== '') invalid('selected path has a different name/type or traverses a symbolic link.');
}

function statMode(stat: DockerPathStat): number {
  return (stat.mode & 0o777) | (stat.mode & 0x0080_0000 ? 0o4000 : 0) | (stat.mode & 0x0040_0000 ? 0o2000 : 0)
    | (stat.mode & 0x0010_0000 ? 0o1000 : 0);
}

function rootName(name: string, path: string, directory: boolean): string {
  if (path === '/' && (name === '.' || name === './' || name === '/')) return '/';
  return archiveName(name, directory);
}

function metadata(entry: TarHeader | TarOutputEntry, path: string) {
  return { path, mode: entry.mode, uid: entry.uid, gid: entry.gid };
}

export class ImageArtifactReader {
  readonly entries = new Map<string, DockerImageFileObservation>();
  readonly absences: string[] = [];
  private members = 0;
  private files = 0;
  private bytes = 0;
  private wireBytes = 0n;

  constructor(private readonly api: DockerApi, private readonly containerId: string,
    private readonly limits: DockerImageInspectionLimits, private readonly signal: AbortSignal) {}

  private options(): TarOptions {
    return { signal: this.signal, chunkBytes: CHUNK_BYTES, limitCode: 'output_limit', symlinks: 'observe',
      maxArchiveBytes: BigInt(this.limits.maxArchiveBytes) - this.wireBytes };
  }

  private member(): void { if (++this.members > this.limits.maxMembers) limit(); }

  private remember(entry: DockerImageFileObservation): void {
    const previous = this.entries.get(entry.path);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) invalid('artifact metadata changed between observations.');
    this.entries.set(entry.path, Object.freeze(entry));
  }

  private async stat(path: string): Promise<DockerPathStat | undefined> {
    const result = await this.api.engine.stream('HEAD', `${DOCKER_API}/containers/${this.containerId}/archive?path=${encodeURIComponent(path)}`,
      { signal: this.signal, chunkBytes: CHUNK_BYTES }, async (response) => {
        if (response.statusCode !== 200 && response.statusCode !== 404) invalid('path stat returned an unsupported HTTP status.');
        const stat = response.statusCode === 200 ? pathStat(response) : undefined;
        for await (const chunk of response.body) if (chunk.length) invalid('HEAD returned an unexpected body.');
        return stat;
      });
    return result.value;
  }

  private async directory(path: string): Promise<void> {
    const cached = this.entries.get(path);
    if (cached) {
      if (cached.kind !== 'directory') invalid('an ancestor is not a real directory.');
      return;
    }
    const stat = await this.stat(path);
    if (!stat) invalid('a required directory ancestor is absent.');
    statKind(stat, path, 'directory');
    const result = await this.api.stream('GET', `${DOCKER_API}/containers/${this.containerId}/archive?path=${encodeURIComponent(path)}`,
      { signal: this.signal, chunkBytes: CHUNK_BYTES, responseMode: 'prefix' }, async (response) => {
        const archivedStat = pathStat(response);
        // Engine archive mounts give `/` a fresh mtime; its identity, type, size and permissions remain exact.
        sameStat(path === '/' ? { ...archivedStat, mtime: stat.mtime } : archivedStat, stat);
        const reader = new TarReader(response.body, this.options());
        let header = parseHeader(await reader.required(BLOCK_BYTES));
        let name = header.path;
        if (header.kind === 'pax') {
          if (header.size === 0 || header.size > MAX_PAX_BYTES) invalid('directory metadata has excessive PAX bytes.');
          const pax = parsePax(await reader.required(header.size));
          if (pax.linkpath !== undefined) invalid('directory PAX metadata contains a link target.');
          await reader.zeroes((BLOCK_BYTES - header.size % BLOCK_BYTES) % BLOCK_BYTES);
          header = parseHeader(await reader.required(BLOCK_BYTES));
          name = pax.path ?? header.path;
        }
        this.member();
        if (header.kind !== 'directory' || rootName(name, path, true) !== (path === '/' ? '/' : stat.name)
          || header.mode !== statMode(stat)) invalid('directory metadata does not describe the exact requested root.');
        return Object.freeze({ ...metadata(header, path), kind: 'directory' as const });
      });
    this.wireBytes += result.downloadedBytes;
    if (this.wireBytes > BigInt(this.limits.maxArchiveBytes)) limit();
    this.remember(result.value);
  }

  async select(selection: DockerImageFileSelection): Promise<void> {
    const parts = selection.path === '/' ? [] : selection.path.slice(1).split('/');
    await this.directory('/');
    for (let count = 1; count < parts.length; count += 1) await this.directory(`/${parts.slice(0, count).join('/')}`);
    if (selection.kind === 'directory' && !selection.recursive) return this.directory(selection.path);
    const stat = await this.stat(selection.path);
    if (selection.kind === 'absent') {
      if (stat) invalid('a required absent path exists.');
      this.absences.push(selection.path);
      return;
    }
    if (!stat) invalid('a selected artifact is absent.');
    statKind(stat, selection.path, selection.kind);
    const seen = new Map<string, TarOutputEntry['kind']>();
    const result = await this.api.stream('GET', `${DOCKER_API}/containers/${this.containerId}/archive?path=${encodeURIComponent(selection.path)}`,
      { signal: this.signal, chunkBytes: CHUNK_BYTES }, async (response) => {
        sameStat(pathStat(response), stat);
        await readTar(response.body, async (entry) => {
          this.member();
          const root = selection.path === '/' ? '/' : stat.name;
          const name = rootName(entry.path, selection.path, entry.kind === 'directory');
          const isRoot = name === root;
          if (seen.has(name) || seen.size === 0 && !isRoot) invalid('archive has a duplicate member or lacks its first exact root.');
          if (isRoot) {
            if (entry.kind !== selection.kind || entry.mode !== statMode(stat) || entry.kind === 'file' && entry.size !== stat.size) invalid('archive root differs from its selected stat.');
          } else {
            if (selection.kind !== 'directory' || !selection.recursive || !name.startsWith(`${root}/`)) invalid('archive member escapes its selected root.');
            const parent = name.slice(0, name.lastIndexOf('/'));
            if (seen.get(parent) !== 'directory') invalid('archive member has a missing or symbolic-link parent.');
          }
          seen.set(name, entry.kind);
          const path = isRoot ? selection.path : `${selection.path}${name.slice(root.length)}`;
          if (entry.kind === 'symlink') this.remember({ ...metadata(entry, path), kind: 'symlink', target: entry.target });
          else if (entry.kind === 'directory') this.remember({ ...metadata(entry, path), kind: 'directory' });
          else {
            if (++this.files > this.limits.maxFiles || entry.size > this.limits.maxBytes - this.bytes) limit();
            this.bytes += entry.size;
            const hash = createHash('sha256');
            for await (const chunk of entry.body) hash.update(chunk);
            this.remember({ ...metadata(entry, path), kind: 'file', size: entry.size, sha256: hash.digest('hex') });
          }
        }, this.options());
        if (!seen.size) invalid('the selected archive root is absent.');
      });
    this.wireBytes += result.downloadedBytes;
    if (this.wireBytes > BigInt(this.limits.maxArchiveBytes)) limit();
  }
}
