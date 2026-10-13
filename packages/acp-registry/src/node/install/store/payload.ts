import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalDigest } from '../../../shared/digest.js';
import type { AcpInstallationLimits, AcpInstalledPayloadEntry } from '../contracts.js';
import { checkInstallationCancellation, storeFailure } from './errors.js';
import { inspectDirectory, physicalIdentity, samePhysicalIdentity, syncDirectory } from './filesystem.js';

export type StorePayloadLimits = Pick<AcpInstallationLimits, 'maxPayloadBytes' | 'maxEntries' | 'maxPathDepth' | 'maxPathBytes' | 'maxReceiptBytes'>;
export interface InstalledPayload {
  readonly digest: string;
  readonly bytes: number;
  readonly entries: readonly AcpInstalledPayloadEntry[];
}

export function containedPayloadPath(relative: string): string {
  if (typeof relative !== 'string' || !relative || relative.length > 8_192 || relative.includes('\\')
    || /[:\p{Cc}\p{Cf}]/u.test(relative) || path.posix.isAbsolute(relative)
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    storeFailure('payload_changed', 'Installed paths must be canonical contained relative paths.');
  }
  return relative;
}

function symbolicTarget(target: string): readonly string[] {
  if (!target || target.includes('\\') || /[:\p{Cc}\p{Cf}]/u.test(target) || path.posix.isAbsolute(target)) {
    storeFailure('payload_changed', 'Payload links must have contained relative targets.');
  }
  const segments = target.split('/');
  if (segments.some((segment) => !segment)) storeFailure('payload_changed', 'Payload link targets contain ambiguous empty segments.');
  return segments;
}

export function createInstalledPayloadResolver(entries: readonly AcpInstalledPayloadEntry[], maxDepth: number): (relative: string) => AcpInstalledPayloadEntry | undefined {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const rootEntry = { kind: 'directory' as const, path: '', mode: 0o700 };
  const resolve = (base: readonly string[], segments: readonly string[], active: ReadonlySet<string>): AcpInstalledPayloadEntry | undefined => {
    let current = [...base];
    let entry: AcpInstalledPayloadEntry | undefined = current.length ? byPath.get(current.join('/')) : rootEntry;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      if (segment === '..') {
        if (!current.length) storeFailure('payload_changed', 'A payload link escapes its installation.');
        current.pop();
      } else if (segment !== '.') current.push(segment);
      if (current.length > maxDepth) storeFailure('limit_exceeded', 'Payload link paths exceed their bounded depth.');
      const prefix = current.join('/');
      entry = prefix ? byPath.get(prefix) : rootEntry;
      if (!entry) return undefined;
      if (entry.kind === 'symlink') {
        if (active.has(prefix)) storeFailure('payload_changed', 'Payload links contain a cycle.');
        if (active.size >= maxDepth) storeFailure('limit_exceeded', 'Payload link chains exceed their bounded depth.');
        const target = symbolicTarget(entry.target);
        if (target.length > maxDepth) storeFailure('limit_exceeded', 'Payload link targets exceed their bounded segment count.');
        entry = resolve(current.slice(0, -1), target, new Set([...active, prefix]));
        if (!entry) return undefined;
        current = entry.path.split('/').filter(Boolean);
      }
      if (index < segments.length - 1 && entry.kind !== 'directory') return undefined;
    }
    return entry;
  };
  return (relative) => resolve([], containedPayloadPath(relative).split('/'), new Set());
}

function validatePayloadLinks(entries: readonly AcpInstalledPayloadEntry[], maxDepth: number): void {
  const resolve = createInstalledPayloadResolver(entries, maxDepth);
  const edges = new Map<string, string[]>([['', []]]);
  for (const entry of entries) if (entry.kind === 'directory') edges.set(entry.path, []);
  for (const entry of entries) {
    const parent = path.posix.dirname(entry.path) === '.' ? '' : path.posix.dirname(entry.path);
    if (entry.kind === 'directory') edges.get(parent)!.push(entry.path);
    if (entry.kind === 'symlink') {
      const resolved = resolve(entry.path);
      if (!resolved) storeFailure('payload_changed', 'A payload link is dangling.');
      if (resolved.kind === 'directory') edges.get(parent)!.push(resolved.path);
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack = [{ directory: '', next: 0 }];
  active.add('');
  while (stack.length) {
    const current = stack.at(-1)!;
    const children = edges.get(current.directory) ?? [];
    const child = children[current.next++];
    if (child === undefined) { active.delete(current.directory); visited.add(current.directory); stack.pop(); continue; }
    if (active.has(child)) storeFailure('payload_changed', 'Payload directory links contain a traversal cycle.');
    if (visited.has(child)) continue;
    if (stack.length > maxDepth) storeFailure('limit_exceeded', 'Payload directory link traversal exceeds its bounded depth.');
    active.add(child); stack.push({ directory: child, next: 0 });
  }
}

async function hashPayloadFile(file: string, remainingBytes: number, synchronize: boolean, signal?: AbortSignal): Promise<Omit<Extract<AcpInstalledPayloadEntry, { readonly kind: 'file' }>, 'kind' | 'path'>> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o7000n) !== 0n) {
      storeFailure('payload_changed', 'Payload files must be bounded regular files without links or special permission bits.');
    }
    if (before.size > BigInt(remainingBytes)) storeFailure('limit_exceeded', 'Installed payload exceeds its byte limit.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1_024);
    let bytes = 0;
    while (true) {
      checkInstallationCancellation(signal);
      const read = await handle.read(buffer, 0, buffer.length, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > remainingBytes) storeFailure('limit_exceeded', 'Installed payload exceeds its byte limit.');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (bytes !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || !samePhysicalIdentity(physicalIdentity(after), physicalIdentity(current)) || after.nlink !== 1n) {
      storeFailure('payload_changed', 'A payload file changed during verification.');
    }
    if (synchronize) await handle.sync();
    return { sizeBytes: bytes, mode: Number(before.mode & 0o777n), sha256: `sha256:${hash.digest('hex')}` };
  } finally { await handle.close(); }
}

export async function inspectInstalledPayload(root: string, limits: StorePayloadLimits, options: { readonly synchronize?: boolean; readonly signal?: AbortSignal } = {}): Promise<InstalledPayload> {
  const entries: AcpInstalledPayloadEntry[] = [];
  let bytes = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    checkInstallationCancellation(options.signal);
    if (depth > limits.maxPathDepth) storeFailure('limit_exceeded', 'Installed payload exceeds its path depth limit.');
    const absolute = relative ? path.join(root, relative) : root;
    const identity = await inspectDirectory(absolute);
    const before = await lstat(absolute, { bigint: true });
    if ((before.mode & 0o7000n) !== 0n) storeFailure('payload_changed', 'Payload directories cannot have special permission bits.');
    const names = (await readdir(absolute)).sort();
    if (entries.length + names.length + (relative ? 1 : 0) > limits.maxEntries) storeFailure('limit_exceeded', 'Installed payload exceeds its entry count limit.');
    if (relative) entries.push({ kind: 'directory', path: relative, mode: Number(before.mode & 0o777n) });
    for (const name of names) {
      if (depth + 1 > limits.maxPathDepth) storeFailure('limit_exceeded', 'Installed payload exceeds its path depth limit.');
      const child = containedPayloadPath(relative ? `${relative}/${name}` : name);
      if (Buffer.byteLength(child, 'utf8') > limits.maxPathBytes) storeFailure('limit_exceeded', 'An installed path exceeds its byte limit.');
      const stat = await lstat(path.join(root, child), { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(child, depth + 1);
      else if (stat.isFile() && !stat.isSymbolicLink()) {
        if (entries.length >= limits.maxEntries) storeFailure('limit_exceeded', 'Installed payload exceeds its entry count limit.');
        const measured = await hashPayloadFile(path.join(root, child), limits.maxPayloadBytes - bytes, options.synchronize === true, options.signal);
        bytes += measured.sizeBytes;
        entries.push({ kind: 'file', path: child, ...measured });
      } else if (stat.isSymbolicLink()) {
        if (entries.length >= limits.maxEntries) storeFailure('limit_exceeded', 'Installed payload exceeds its entry count limit.');
        const target = await readlink(path.join(root, child));
        if (Buffer.byteLength(target, 'utf8') > limits.maxPathBytes) storeFailure('limit_exceeded', 'An installed link target exceeds its byte limit.');
        symbolicTarget(target);
        const afterLink = await lstat(path.join(root, child), { bigint: true });
        if (!samePhysicalIdentity(physicalIdentity(stat), physicalIdentity(afterLink)) || stat.ctimeNs !== afterLink.ctimeNs) storeFailure('payload_changed', 'A payload link changed during verification.');
        entries.push({ kind: 'symlink', path: child, target });
      } else storeFailure('payload_changed', 'Payload devices and special files are unsupported.');
    }
    await inspectDirectory(absolute, identity);
    const after = await lstat(absolute, { bigint: true });
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || (await readdir(absolute)).sort().join('\0') !== names.join('\0')) {
      storeFailure('payload_changed', 'A payload directory changed during verification.');
    }
    if (options.synchronize) await syncDirectory(absolute);
  };
  await visit('', 0);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  validatePayloadLinks(entries, limits.maxPathDepth);
  return { digest: canonicalDigest(entries), bytes, entries };
}
