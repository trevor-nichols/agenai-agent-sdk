// ------------------------------------------------------------------------------------------------
//                desktopCoordinatorEndpoint.ts - Bounded physical Desktop endpoint alias observation
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { DockerDesktopEngineSocketIdentity } from '../network/routeAuthority.js';

const maximumPathBytes = 4096;
const maximumSymlinks = 40;
const maximumComponents = 256;

interface EndpointStat {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly uid: string;
  readonly gid: string;
  readonly birthtimeNs: string;
  readonly ctimeNs: string;
  readonly mtimeNs: string;
}

export interface DesktopCoordinatorEndpointAlias extends EndpointStat {
  readonly path: string;
  readonly target: string;
}

export interface DesktopCoordinatorEndpointBinding {
  readonly endpoint: string;
  readonly physical: DockerDesktopEngineSocketIdentity;
  readonly aliases: readonly DesktopCoordinatorEndpointAlias[];
  readonly digest: string;
}

type PathEntry =
  | Readonly<{ kind: 'directory'; path: string; identity: string }>
  | Readonly<{ kind: 'alias'; alias: DesktopCoordinatorEndpointAlias }>;

interface EndpointObservation {
  readonly physical: DockerDesktopEngineSocketIdentity;
  readonly socketStat: EndpointStat;
  readonly aliases: readonly DesktopCoordinatorEndpointAlias[];
  readonly entries: readonly PathEntry[];
}

function statFacts(value: BigIntStats): EndpointStat {
  return Object.freeze({ device: String(value.dev), inode: String(value.ino), mode: String(value.mode),
    uid: String(value.uid), gid: String(value.gid), birthtimeNs: String(value.birthtimeNs),
    ctimeNs: String(value.ctimeNs), mtimeNs: String(value.mtimeNs) });
}

function directoryIdentity(value: BigIntStats): string {
  // Unrelated directory-entry writes may change ctime/mtime without changing this path's identity.
  return [value.dev, value.ino, value.mode, value.uid, value.gid, value.birthtimeNs].map(String).join(':');
}

function checkedPath(path: string): string {
  if (!path.isWellFormed() || path.includes('\0') || Buffer.byteLength(path, 'utf8') > maximumPathBytes) {
    throw new SandboxUnsupportedError('Desktop coordinator endpoint exceeds its 4096-byte path bound or has invalid path text.');
  }
  return path;
}

function changed(): never {
  throw new SandboxUnsupportedError('Desktop coordinator endpoint alias chain or physical socket changed during observation.');
}

async function inspectPath(path: string, signal?: AbortSignal): Promise<BigIntStats> {
  signal?.throwIfAborted();
  const value = await lstat(path, { bigint: true });
  signal?.throwIfAborted();
  return value;
}

async function inspectAlias(path: string, before: BigIntStats, signal?: AbortSignal): Promise<DesktopCoordinatorEndpointAlias> {
  signal?.throwIfAborted();
  const bytes = await readlink(path, { encoding: 'buffer' });
  signal?.throwIfAborted();
  const target = checkedPath(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(target, 'utf8')) || target.length === 0) {
    throw new SandboxUnsupportedError('Desktop coordinator endpoint alias requires a nonempty UTF-8 target.');
  }
  const after = await inspectPath(path, signal);
  const facts = statFacts(before);
  if (!after.isSymbolicLink() || JSON.stringify(facts) !== JSON.stringify(statFacts(after))) changed();
  return Object.freeze({ path, target, ...facts });
}

function pathComponents(path: string): string[] {
  const parts = path.split('/').filter((part) => part !== '');
  // A trailing slash requires the preceding component to be a directory, including in alias targets.
  if (path.endsWith('/')) parts.push('.');
  return parts;
}

function checkWorkingPath(resolved: readonly string[], pending: readonly string[]): void {
  if (resolved.length + pending.length > maximumComponents) {
    throw new SandboxUnsupportedError('Desktop coordinator endpoint exceeds its 256-component resolution bound.');
  }
  checkedPath(`/${[...resolved, ...pending].join('/')}`);
}

async function observePath(path: string, signal?: AbortSignal): Promise<EndpointObservation> {
  const entries: PathEntry[] = [];
  const aliases: DesktopCoordinatorEndpointAlias[] = [];
  const root = await inspectPath('/', signal);
  if (!root.isDirectory()) changed();
  entries.push({ kind: 'directory', path: '/', identity: directoryIdentity(root) });
  let pending = pathComponents(path);
  let resolved: string[] = [];
  let visitedComponents = 0;
  const aliasStates = new Set<string>();
  checkWorkingPath(resolved, pending);

  while (pending.length > 0) {
    if (++visitedComponents > maximumComponents) {
      throw new SandboxUnsupportedError('Desktop coordinator endpoint exceeds its 256-component traversal bound.');
    }
    const part = pending.shift();
    if (part === '.' || part === undefined) continue;
    if (part === '..') { resolved.pop(); continue; }
    const current = checkedPath(`/${[...resolved, part].join('/')}`);
    const value = await inspectPath(current, signal);
    if (value.isSymbolicLink()) {
      const state = `${current}\0${pending.join('/')}`;
      if (aliasStates.has(state)) throw new SandboxUnsupportedError('Desktop coordinator endpoint contains a symbolic-link cycle.');
      aliasStates.add(state);
      if (aliases.length >= maximumSymlinks) {
        throw new SandboxUnsupportedError('Desktop coordinator endpoint exceeds its 40-symbolic-link expansion bound.');
      }
      const alias = await inspectAlias(current, value, signal);
      aliases.push(alias);
      entries.push({ kind: 'alias', alias });
      pending = [...pathComponents(alias.target), ...pending];
      if (alias.target.startsWith('/')) resolved = [];
      checkWorkingPath(resolved, pending);
      continue;
    }
    if (pending.length === 0) {
      if (!value.isSocket()) throw new SandboxUnsupportedError('Desktop coordinator endpoint must resolve to a physical local Unix socket.');
      const stat = statFacts(value);
      return { physical: Object.freeze({ path: current, device: stat.device, inode: stat.inode, mode: stat.mode }),
        socketStat: stat, aliases: Object.freeze(aliases), entries };
    }
    if (!value.isDirectory()) throw new SandboxUnsupportedError('Desktop coordinator endpoint has a non-directory parent component.');
    entries.push({ kind: 'directory', path: current, identity: directoryIdentity(value) });
    resolved.push(part);
  }
  throw new SandboxUnsupportedError('Desktop coordinator endpoint must resolve to a physical local Unix socket.');
}

async function verifyObservation(path: string, observation: EndpointObservation, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let physicalPath: string;
  try { physicalPath = await realpath(path); }
  catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
      throw new SandboxUnsupportedError('Desktop coordinator endpoint exceeds this host\'s symbolic-link resolution bound.');
    }
    throw error;
  }
  if (physicalPath !== observation.physical.path) changed();
  for (const entry of observation.entries.toReversed()) {
    const current = await inspectPath(entry.kind === 'alias' ? entry.alias.path : entry.path, signal);
    if (entry.kind === 'directory') {
      if (!current.isDirectory() || directoryIdentity(current) !== entry.identity) changed();
    } else if (!current.isSymbolicLink() || JSON.stringify(await inspectAlias(entry.alias.path, current, signal)) !== JSON.stringify(entry.alias)) changed();
  }
  const socket = await inspectPath(observation.physical.path, signal);
  if (!socket.isSocket() || JSON.stringify(statFacts(socket)) !== JSON.stringify(observation.socketStat)) changed();
}

export async function inspectDesktopCoordinatorEndpoint(endpoint: string, signal?: AbortSignal): Promise<DesktopCoordinatorEndpointBinding> {
  signal?.throwIfAborted();
  const path = checkedPath(endpoint.slice('unix://'.length));
  if (!endpoint.startsWith('unix:///') || path === '/' || path.slice(1).split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new SandboxUnsupportedError('Desktop coordinator requires a canonical absolute local Unix endpoint.');
  }
  const before = await observePath(path, signal);
  await verifyObservation(path, before, signal);
  const after = await observePath(path, signal);
  if (JSON.stringify(before) !== JSON.stringify(after)) changed();
  await verifyObservation(path, after, signal);
  signal?.throwIfAborted();
  const digest = `sha256:${createHash('sha256').update('agenai.desktop-coordinator.endpoint.v1\0')
    .update(JSON.stringify({ endpoint, ...after })).digest('hex')}`;
  return Object.freeze({ endpoint, physical: after.physical, aliases: after.aliases, digest });
}
