// ------------------------------------------------------------------------------------------------
//                dependency-identity.ts - Resolved installed manifest and peer-context identity
// ------------------------------------------------------------------------------------------------

import { lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DependencyRecord } from './identity.js';
import { NativeInputError, readNativeInput } from './json.js';

const maximumNodes = 512;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const packageVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const drift = (): never => { throw new NativeInputError('source_identity_drift'); };

function fields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return drift();
  return value as Record<string, unknown>;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !packageName.test(value)) return drift();
  return value;
}

function version(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || !packageVersion.test(value)) return drift();
  return value;
}

// Only exact registry versions and their bounded pnpm peer contexts are qualified here.
function snapshot(value: unknown): { name: string; version: string } {
  if (typeof value !== 'string' || value.length > 1024) return drift();
  const input = value;
  let at = 0;
  function part(depth: number): { name: string; version: string } {
    if (depth > 16) return drift();
    const start = at;
    while (at < input.length && input[at] !== '(' && input[at] !== ')') at += 1;
    const base = input.slice(start, at);
    const separator = base.lastIndexOf('@');
    const identity = { name: name(base.slice(0, separator)), version: version(base.slice(separator + 1)) };
    const peers = new Set<string>();
    while (input[at] === '(') {
      at += 1;
      const peer = part(depth + 1);
      if (input[at++] !== ')' || peers.has(peer.name)) return drift();
      peers.add(peer.name);
    }
    return identity;
  }
  const identity = part(0);
  if (at !== input.length) return drift();
  return identity;
}

function dependencyMap(value: unknown): Readonly<Record<string, string>> {
  const map = fields(value);
  if (Object.keys(map).length > maximumNodes) return drift();
  for (const [key, entry] of Object.entries(map)) {
    name(key);
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024) return drift();
  }
  return map as Record<string, string>;
}

interface InstalledManifest {
  readonly name: string;
  readonly version: string;
  readonly required: ReadonlySet<string>;
  readonly optional: ReadonlySet<string>;
  readonly peers: ReadonlySet<string>;
}

async function installedManifest(path: string): Promise<InstalledManifest> {
  const manifest = fields((await readNativeInput(path, undefined, 1_048_576)).value);
  const required = new Set(Object.keys(dependencyMap(manifest.dependencies ?? {})));
  const optional = new Set(Object.keys(dependencyMap(manifest.optionalDependencies ?? {})));
  const peers = new Set(Object.keys(dependencyMap(manifest.peerDependencies ?? {})));
  const metadata = fields(manifest.peerDependenciesMeta ?? {});
  if (Object.keys(metadata).length > maximumNodes) return drift();
  for (const [key, entry] of Object.entries(metadata)) {
    peers.add(name(key));
    if (fields(entry).optional === true) optional.add(key);
  }
  for (const peer of peers) required.add(peer);
  for (const dependency of optional) required.delete(dependency);
  if (required.size + optional.size > maximumNodes) return drift();
  return { name: name(manifest.name), version: version(manifest.version), required, optional, peers };
}

async function resolveManifest(parent: string, dependency: string): Promise<string | undefined> {
  // Package exports can hide package.json or omit a root entry; inspect the nearest installed
  // package root along Node's actual parent-relative lookup paths without executing its code.
  for (const directory of createRequire(parent).resolve.paths(dependency) ?? []) {
    const root = join(directory, dependency);
    try { await lstat(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    return realpath(join(root, 'package.json'));
  }
  return undefined;
}

function sameNames(actual: ReadonlySet<string>, expected: Readonly<Record<string, string>>): boolean {
  return actual.size === Object.keys(expected).length && [...actual].every((key) => Object.hasOwn(expected, key));
}

export async function assertDependencyGraphIdentity(
  rootManifestPath: string,
  expected: { readonly rootSnapshot: string; readonly graph: Readonly<Record<string, DependencyRecord>> },
): Promise<void> {
  try {
    const graph = expected.graph;
    fields(graph);
    if (Object.keys(graph).length === 0 || Object.keys(graph).length > maximumNodes) return drift();
    snapshot(expected.rootSnapshot);
    for (const [key, value] of Object.entries(graph)) {
      snapshot(key);
      const node = fields(value);
      const required = dependencyMap(node.dependencies);
      const optional = dependencyMap(node.optionalDependencies);
      for (const map of [required, optional]) {
        for (const [dependency, reference] of Object.entries(map)) {
          const target = `${dependency}@${reference}`;
          snapshot(target);
          if (!Object.hasOwn(graph, target)) return drift();
        }
      }
      if (Object.keys(required).some((key) => Object.hasOwn(optional, key))) return drift();
    }
    const visited = new Set<string>();
    const reached = new Set<string>();
    async function visit(key: string, path: string, depth: number): Promise<void> {
      if (depth > maximumNodes || !Object.hasOwn(graph, key)) return drift();
      const context = `${key}\0${path}`;
      if (visited.has(context)) return;
      if (visited.size >= maximumNodes) return drift();
      visited.add(context);
      reached.add(key);
      const node = graph[key]!;
      const pinned = snapshot(key);
      const manifest = await installedManifest(path);
      if (manifest.name !== pinned.name || manifest.version !== pinned.version || !sameNames(manifest.required, node.dependencies)) return drift();
      const resolved = new Map<string, string>();
      for (const dependency of [...manifest.required, ...manifest.optional]) {
        const child = await resolveManifest(path, dependency);
        if (child === undefined) {
          if (manifest.required.has(dependency)) return drift();
        } else resolved.set(dependency, child);
      }
      const installedOptional = new Set([...manifest.optional].filter((dependency) => resolved.has(dependency)));
      if (!sameNames(installedOptional, node.optionalDependencies)) return drift();
      const edges = { ...node.dependencies, ...node.optionalDependencies };
      const peerContext = [...manifest.peers].filter((peer) => resolved.has(peer)).sort()
        .map((peer) => `(${peer}@${edges[peer]})`).join('');
      if (`${manifest.name}@${manifest.version}${peerContext}` !== key) return drift();
      for (const [dependency, child] of resolved) {
        await visit(`${dependency}@${edges[dependency]}`, child, depth + 1);
      }
    }
    await visit(expected.rootSnapshot, await realpath(rootManifestPath), 0);
    if (reached.size !== Object.keys(graph).length) return drift();
  } catch {
    // Malformed pins, unreadable manifests and resolution drift all fail this preflight closed.
    return drift();
  }
}
