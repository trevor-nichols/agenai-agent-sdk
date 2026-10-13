import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import { inputRecord, inputString, PLANNING_INPUT_LIMITS } from '../../../selection/input.js';
import { normalizeRegistryExecutable } from '../../../catalog/launch.js';
import { AcpRegistryValidationError } from '../../../shared/errors.js';
import { AcpInstallationError } from '../errors.js';

export interface InstalledPackageMetadata {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export async function readPackageMetadata(path: string): Promise<Record<string, unknown>> {
  const content = await readOwnedText(path, 256 * 1_024);
  try { return inputRecord(parseBoundedRegistryJson(content, { ...PLANNING_INPUT_LIMITS, maxSnapshotBytes: 256 * 1_024, maxStringBytes: 64 * 1_024 }), []); }
  catch (cause) {
    if (cause instanceof AcpRegistryValidationError) throw new AcpInstallationError('unsupported_format', 'Native package metadata must be bounded unambiguous JSON.', { cause });
    throw cause;
  }
}

function fileAccessFailure(cause: unknown): never {
  if (cause instanceof Error && 'code' in cause && ['ELOOP', 'ENOENT', 'ENOTDIR'].includes(String(cause.code))) {
    throw new AcpInstallationError('payload_changed', 'A native package path is missing, substituted or linked.', { cause });
  }
  throw cause;
}

function assertOwnedFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n) throw new AcpInstallationError('payload_changed', 'Native package files must be owned regular files without hard links.');
}

async function verifyFileIdentity(path: string, before: BigIntStats, after: BigIntStats): Promise<void> {
  const current = await lstat(path, { bigint: true }).catch(fileAccessFailure);
  assertOwnedFile(after); assertOwnedFile(current);
  if ([after, current].some((stat) => before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size
    || before.mtimeNs !== stat.mtimeNs || before.ctimeNs !== stat.ctimeNs)) {
    throw new AcpInstallationError('payload_changed', 'A native package file changed while it was read.');
  }
}

export async function readOwnedText(path: string, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new AcpInstallationError('invalid_input', 'Native package reads require a finite positive byte ceiling.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(fileAccessFailure);
  try {
    const before = await file.stat({ bigint: true });
    assertOwnedFile(before);
    if (before.size > BigInt(maxBytes)) throw new AcpInstallationError('limit_exceeded', 'Native package metadata exceeds its byte ceiling.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) throw new AcpInstallationError('limit_exceeded', 'Native package metadata grew beyond its byte ceiling.');
    if (BigInt(length) !== before.size) throw new AcpInstallationError('payload_changed', 'Native package metadata changed length while it was read.');
    await verifyFileIdentity(path, before, await file.stat({ bigint: true }));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch (cause) {
      if (cause instanceof TypeError) throw new AcpInstallationError('unsupported_format', 'Native package metadata requires valid UTF-8.', { cause });
      throw cause;
    }
  } finally { await file.close(); }
}

export async function ownedRegularFile(root: string, path: string): Promise<string> {
  let local: string;
  try { local = normalizeRegistryExecutable(path); }
  catch (cause) {
    if (cause instanceof AcpRegistryValidationError) throw new AcpInstallationError('integrity_mismatch', 'Package launch metadata must name a contained owned payload file.', { cause });
    throw cause;
  }
  let current = root;
  const segments = local.split('/');
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = await lstat(current).catch(fileAccessFailure);
    if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) || stat.nlink > 1 && stat.isFile()) {
      throw new AcpInstallationError('payload_changed', 'Package launch paths must stay inside their owned regular payload.');
    }
  }
  if (await realpath(current).catch(fileAccessFailure) !== current) throw new AcpInstallationError('payload_changed', 'Package launch paths cannot traverse links.');
  return current;
}

export async function isNodeEntryPoint(path: string): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(fileAccessFailure);
  try {
    const before = await file.stat({ bigint: true });
    assertOwnedFile(before);
    const header = Buffer.alloc(256);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    await verifyFileIdentity(path, before, await file.stat({ bigint: true }));
    if (/\.(?:js|mjs|cjs)$/i.test(path)) return true;
    const firstLine = header.subarray(0, bytesRead).toString('utf8').split('\n')[0]!.replace(/\r$/, '');
    return ['#!/usr/bin/env node', '#!/usr/bin/node', '#!/bin/node'].includes(firstLine);
  } finally { await file.close(); }
}

export async function installedNpmPackages(payloadRoot: string, maxPackages: number): Promise<readonly InstalledPackageMetadata[]> {
  const packages: InstalledPackageMetadata[] = [];
  const visit = async (modules: string): Promise<void> => {
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (entry.name === '.package-lock.json') continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new AcpInstallationError('unsupported_format', 'The installed npm tree contains an unsupported entry.');
      const directories = entry.name.startsWith('@')
        ? (await readdir(join(modules, entry.name), { withFileTypes: true })).map((child) => {
          if (!child.isDirectory() || child.isSymbolicLink()) throw new AcpInstallationError('unsupported_format', 'The installed npm scope contains an unsupported entry.');
          return join(modules, entry.name, child.name);
        }) : [join(modules, entry.name)];
      for (const directory of directories) {
        if (packages.length >= maxPackages) throw new AcpInstallationError('limit_exceeded', 'The installed npm dependency count exceeds its bound.');
        const manifest = await readPackageMetadata(join(directory, 'package.json'));
        const name = inputString(manifest.name, ['name'], 214);
        const version = inputString(manifest.version, ['version'], 128);
        const rawDependencies = manifest.dependencies === undefined ? {} : inputRecord(manifest.dependencies, ['dependencies']);
        const dependencies = Object.fromEntries(Object.entries(rawDependencies).map(([key, value]) => [key, inputString(value, ['dependencies', key], 256)]));
        if (manifest.optionalDependencies || manifest.peerDependencies || manifest.peerDependenciesMeta || manifest.bundledDependencies || manifest.bundleDependencies || manifest.os || manifest.cpu || manifest.libc) {
          throw new AcpInstallationError('unsupported_format', 'Optional, peer, bundled and platform-conditioned npm metadata is unsupported.');
        }
        packages.push({ directory, name, version, dependencies, manifest });
        const nested = await lstat(join(directory, 'node_modules')).catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (nested) {
          if (!nested.isDirectory() || nested.isSymbolicLink()) throw new AcpInstallationError('payload_changed', 'Nested npm dependencies must be owned directories.');
          await visit(join(directory, 'node_modules'));
        }
      }
    }
  };
  await visit(join(payloadRoot, 'node_modules'));
  return packages;
}

export function resolveInstalledDependency(packages: readonly InstalledPackageMetadata[], owner: InstalledPackageMetadata, name: string, payloadRoot: string): InstalledPackageMetadata {
  let cursor = owner.directory;
  while (relative(payloadRoot, cursor) !== '..' && !isAbsolute(relative(payloadRoot, cursor)) && !relative(payloadRoot, cursor).startsWith(`..${sep}`)) {
    const candidate = packages.find((item) => item.directory === join(cursor, 'node_modules', name));
    if (candidate) return candidate;
    if (cursor === payloadRoot) break;
    cursor = dirname(cursor);
  }
  throw new AcpInstallationError('integrity_mismatch', 'An installed npm dependency cannot be resolved within its owned payload.');
}
