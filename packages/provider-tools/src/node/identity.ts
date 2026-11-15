// ------------------------------------------------------------------------------------------------
//                identity.ts - Qualified platform tuples and pinned executable byte verification
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { NodeProviderToolsError } from '../errors.js';

export type NodeProviderPlatform = 'linux-x64' | 'linux-arm64';
export const QUALIFIED_NODE_VERSION = 'v24.18.0';

/** Exact Bubblewrap and filesystem-helper bytes from the recorded qualification tuples. */
const TOOL_PINS: Readonly<Record<NodeProviderPlatform, Readonly<{ bubblewrap: string; helper: string }>>> = Object.freeze({
  'linux-x64': Object.freeze({
    bubblewrap: '523da3e7399044be5163aee6f57a77a6bef7454376e28f0a0627920bae1b76b6',
    helper: '467e80d77d52cecb4dcd4072db9f27fa4630eb0087b14f5a05dfd21da70c7e6f',
  }),
  'linux-arm64': Object.freeze({
    bubblewrap: 'ff5add553bea12a45c18ebe6c67d3ed637052b869a1ca2fc5d74a6a2e8c5cce6',
    helper: 'df898d30c471b082639166e567d800049e077668f9ee40f03ee9b0b5b4ac030e',
  }),
});

export interface ProcessIdentity {
  readonly platform: NodeProviderPlatform;
  readonly uid: number;
  readonly gid: number;
}

/** Linux x64 and the Linux arm64 Desktop workload only, with the qualified Node and a non-root identity. */
export function admitProcess(): ProcessIdentity {
  const platform = process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64') ? `linux-${process.arch}` as const : undefined;
  if (!platform) throw new NodeProviderToolsError('platform_unsupported', `Owned provider tools require Linux x64 or arm64, not ${process.platform}-${process.arch}.`);
  if (process.version !== QUALIFIED_NODE_VERSION) {
    throw new NodeProviderToolsError('platform_unsupported', `Owned provider tools require Node ${QUALIFIED_NODE_VERSION}, not ${process.version}.`);
  }
  const uid = process.geteuid?.() ?? 0;
  const gid = process.getegid?.() ?? 0;
  if (uid < 1 || gid < 1 || uid > 262_143 || gid > 262_143) {
    throw new NodeProviderToolsError('platform_unsupported', 'Owned provider tools require effective UID and GID in the filesystem helper range 1–262143.');
  }
  return Object.freeze({ platform, uid, gid });
}

export function toolPins(platform: NodeProviderPlatform): Readonly<{ bubblewrap: string; helper: string }> {
  return TOOL_PINS[platform];
}

export interface VerifiedExecutable {
  readonly path: string;
  readonly sha256: string;
  readonly identity: string;
}

function fingerprint(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mode, info.uid, info.mtimeMs, info.ctimeMs].join(':');
}

/**
 * Hashes the actual bytes behind one physical executable path. The file must not be writable by
 * other users; its identity is re-observed before each later launch so swapped bytes fence startup.
 */
export async function verifyExecutable(path: string, expected: string, maxBytes: number, uid: number): Promise<VerifiedExecutable> {
  const refuse = (message: string, cause?: unknown) => new NodeProviderToolsError('identity_mismatch', `${message}: ${path}`, cause === undefined ? undefined : { cause });
  let handle;
  try {
    const link = await lstat(path);
    if (!link.isFile() || await realpath(path) !== path) throw refuse('Executable must be a physical regular file');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (cause instanceof NodeProviderToolsError) throw cause;
    throw new NodeProviderToolsError('identity_mismatch', `Executable is unavailable: ${path}`, { cause });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== uid) || (info.mode & 0o111) === 0 || info.size > maxBytes) {
      throw refuse('Executable must be bounded, executable and writable only by root or the caller');
    }
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1 << 20 })) {
      total += (chunk as Buffer).byteLength;
      if (total > maxBytes) throw refuse('Executable exceeded its byte bound while hashing');
      hash.update(chunk as Buffer);
    }
    const sha256 = hash.digest('hex');
    const after = await handle.stat();
    if (sha256 !== expected || fingerprint(after) !== fingerprint(info)) throw refuse('Executable bytes differ from the qualified pin');
    return Object.freeze({ path, sha256, identity: fingerprint(info) });
  } finally { await handle.close(); }
}

export async function assertExecutableUnchanged(executable: VerifiedExecutable): Promise<void> {
  let current: string;
  try { current = fingerprint(await stat(executable.path)); } catch (cause) {
    throw new NodeProviderToolsError('identity_mismatch', `Verified executable disappeared: ${executable.path}`, { cause });
  }
  if (current !== executable.identity) throw new NodeProviderToolsError('identity_mismatch', `Verified executable changed: ${executable.path}`);
}
