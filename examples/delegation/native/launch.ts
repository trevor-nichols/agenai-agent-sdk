// ------------------------------------------------------------------------------------------------
//                launch.ts - Pinned executable copies and isolated native process allocations
// ------------------------------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  NativeAllocationInput, NativeConfigurationFileRecord, NativeExecutableLease,
  NativeFileIdentity, NativePreparationInput, NativeProcessAllocation,
} from './launch-contracts.js';

export type * from './launch-contracts.js';

const MiB = 1_024 * 1_024;
const scannerKeys = ['CURSOR', 'CLAUDE'].flatMap((source) =>
  ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS'].map((kind) => `GROK_${source}_${kind}_ENABLED`));
const ancestorInputs = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.grok', '.cursor', '.claude',
  '.agents', '.mcp.json', '.envrc', 'grok.toml', '.grok.toml'];

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function assertAbsolute(path: string): void {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes('\0')) {
    throw new Error('Native qualification requires canonical absolute paths.');
  }
}

/** Hash a bounded, stable regular file without following its final path component. */
export async function inspectNativeFile(input: {
  readonly path: string;
  readonly expected?: NativeFileIdentity;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}): Promise<NativeFileIdentity> {
  assertAbsolute(input.path);
  const maximum = input.maxBytes ?? 256 * MiB;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 512 * MiB) throw new Error('Invalid native file byte bound.');
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) throw new Error('Native input is not a bounded regular file.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(MiB);
    let bytes = 0;
    for (;;) {
      input.signal?.throwIfAborted();
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > maximum) throw new Error('Native input exceeded its byte bound.');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const identity = Object.freeze({ bytes, sha256: hash.digest('hex') });
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(input.path))
      || bytes !== before.size) throw new Error('Native file identity changed while reading.');
    if (input.expected && (identity.bytes !== input.expected.bytes || identity.sha256 !== input.expected.sha256)) {
      throw new Error('Native file does not match its independently pinned identity.');
    }
    return identity;
  } finally { await handle.close(); }
}

/** Single-flight ownership release remains retryable after a failed cleanup attempt. */
export function nativeRelease(action: () => Promise<void>): () => Promise<void> {
  let released = false;
  let pending: Promise<void> | undefined;
  return () => {
    if (released) return Promise.resolve();
    pending ??= Promise.resolve().then(action).then(() => { released = true; })
      .catch((error) => { pending = undefined; throw error; });
    return pending;
  };
}

export class NativeCleanupError extends AggregateError {
  readonly retainedRoot: string;
  readonly retryCleanup: () => Promise<void>;
  constructor(cause: unknown, cleanupError: unknown, retainedRoot: string, retryCleanup: () => Promise<void>) {
    super([cause, cleanupError], 'Native preparation failed and its owned allocation requires cleanup.');
    this.name = 'NativeCleanupError';
    this.retainedRoot = retainedRoot;
    this.retryCleanup = retryCleanup;
  }
}

export async function inspectNativeRoot(root: string): Promise<Stats> {
  assertAbsolute(root);
  const parent = await lstat(root);
  if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(root) !== root
    || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    throw new Error('Native allocation root must be an owned private physical directory.');
  }
  return parent;
}

export async function createNativeDirectory(root: string, prefix: string): Promise<{
  readonly path: string;
  readonly allocationId: string;
  readonly release: () => Promise<void>;
}> {
  if (!/^[a-z]+-$/u.test(prefix)) throw new Error('Invalid native allocation prefix.');
  const parent = await inspectNativeRoot(root);
  const path = await mkdtemp(join(root, prefix));
  const identity = await lstat(path);
  const release = nativeRelease(async () => {
    const currentParent = await lstat(root);
    const current = await lstat(path);
    if (currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
      || current.dev !== identity.dev || current.ino !== identity.ino
      || !current.isDirectory() || current.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error('Owned native directory identity changed; cleanup is retained.');
    }
    await rm(path, { recursive: true });
  });
  return Object.freeze({ path, allocationId: randomUUID(), release });
}

export async function prepareDirectExecutable(input: NativePreparationInput): Promise<NativeExecutableLease> {
  input.signal?.throwIfAborted();
  if (process.platform !== 'linux' || process.arch !== 'x64' || input.candidate.native.target !== 'linux-x86_64') {
    throw new Error('The pinned native candidate requires Linux x86_64.');
  }
  const candidate = input.candidate.native;
  if (await realpath(candidate.installedCommandPath) !== candidate.inspectedExecutablePath) {
    throw new Error('The inspected native command now resolves to a different executable.');
  }
  await inspectNativeFile({ path: candidate.inspectedExecutablePath, expected: candidate, ...(input.signal ? { signal: input.signal } : {}) });
  const directory = await createNativeDirectory(input.root, 'executable-');
  try {
    const executable = join(directory.path, 'grok');
    const source = await open(candidate.inspectedExecutablePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await source.stat();
      if (!before.isFile() || before.size !== candidate.bytes) throw new Error('Native executable changed before copying.');
      const destination = await open(executable, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
      try {
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(MiB);
        let bytes = 0;
        for (;;) {
          input.signal?.throwIfAborted();
          const read = await source.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
          if (bytes > candidate.bytes) throw new Error('Native executable grew while copying.');
          const chunk = buffer.subarray(0, read.bytesRead);
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const result = await destination.write(chunk, offset, chunk.length - offset);
            if (!result.bytesWritten) throw new Error('Native executable copy made no progress.');
            offset += result.bytesWritten;
          }
        }
        if (bytes !== candidate.bytes || hash.digest('hex') !== candidate.sha256
          || !sameFile(before, await source.stat()) || !sameFile(before, await lstat(candidate.inspectedExecutablePath))) {
          throw new Error('Native executable identity drifted while copying.');
        }
        await destination.sync();
      } finally { await destination.close(); }
    } finally { await source.close(); }
    await chmod(executable, 0o555);
    const identity = await inspectNativeFile({ path: executable, expected: candidate, ...(input.signal ? { signal: input.signal } : {}) });
    return Object.freeze({ mode: 'direct', executable, identity,
      evidence: Object.freeze({ mode: 'direct', identity, allocationId: directory.allocationId }),
      assertUnchanged: async () => { await inspectNativeFile({ path: executable, expected: identity }); },
      release: directory.release,
    });
  } catch (cause) {
    try { await directory.release(); } catch (cleanupError) {
      throw new NativeCleanupError(cause, cleanupError, directory.path, directory.release);
    }
    throw cause;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function inspectLoadingBoundary(workingDirectory: string): Promise<readonly NativeConfigurationFileRecord[]> {
  const records: NativeConfigurationFileRecord[] = [];
  for (let ancestor = workingDirectory; ; ancestor = dirname(ancestor)) {
    for (const name of ancestorInputs) {
      if (await exists(join(ancestor, name))) throw new Error('Uninspected ancestor instructions or configuration prevent isolated native launch.');
    }
    if (dirname(ancestor) === ancestor) break;
  }
  for (const path of ['/etc/grok', '/etc/grok/config.toml', '/etc/grok/requirements.toml']) {
    if (await exists(path)) throw new Error('System Grok policy changed; native loading requires a new inspection.');
    records.push({ location: path, kind: 'absent' });
  }
  return Object.freeze(records);
}

export async function allocateNativeProcess(input: NativeAllocationInput): Promise<NativeProcessAllocation> {
  if (!['discovery', 'parent', 'child', 'comparison'].includes(input.role)) throw new Error('Invalid native process role.');
  input.signal?.throwIfAborted();
  await input.executable.assertUnchanged();
  const directory = await createNativeDirectory(input.root, `${input.role}-`);
  try {
    const paths = Object.fromEntries(['work', 'home', 'grok', 'config', 'data', 'cache', 'state', 'runtime', 'tmp']
      .map((name) => [name, join(directory.path, name)]));
    for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
    await inspectLoadingBoundary(paths.work!);
    const configPath = join(paths.grok!, 'config.toml');
    await writeFile(configPath, '[cli]\nauto_update = false\n', { flag: 'wx', mode: 0o600 });
    const key = await input.credential(input.signal);
    input.signal?.throwIfAborted();
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 16_384 || /[\0\r\n]/u.test(key))) {
      throw new Error('Native credential callback must return one bounded API key or undefined.');
    }
    const env = Object.freeze({
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      HOME: paths.home!, GROK_HOME: paths.grok!, XDG_CONFIG_HOME: paths.config!, XDG_DATA_HOME: paths.data!,
      XDG_CACHE_HOME: paths.cache!, XDG_STATE_HOME: paths.state!, XDG_RUNTIME_DIR: paths.runtime!,
      TMPDIR: paths.tmp!, TMP: paths.tmp!, TEMP: paths.tmp!, GROK_DISABLE_AUTOUPDATER: '1',
      ...Object.fromEntries(scannerKeys.map((name) => [name, '0'])),
      ...(key === undefined ? {} : { XAI_API_KEY: key }),
    });
    const configurationFilesSnapshot = async (): Promise<readonly NativeConfigurationFileRecord[]> => {
      const config = await inspectNativeFile({ path: configPath, maxBytes: MiB });
      const records: NativeConfigurationFileRecord[] = [...await inspectLoadingBoundary(paths.work!),
        { location: 'GROK_HOME/config.toml', kind: 'file', ...config }];
      for (const name of ['skills', 'agents', 'hooks', 'rules', 'mcp.json', 'requirements.toml']) {
        const path = join(paths.grok!, name);
        const present = await exists(path);
        if (!present) records.push({ location: `GROK_HOME/${name}`, kind: 'absent' });
        else {
          const stat = await lstat(path);
          if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error('Native loading path is not a regular owned entry.');
          records.push({ location: `GROK_HOME/${name}`, kind: stat.isDirectory() ? 'directory' : 'file',
            ...(stat.isFile() ? await inspectNativeFile({ path, maxBytes: MiB }) : {}) });
        }
      }
      return Object.freeze(records);
    };
    return Object.freeze({ allocationId: directory.allocationId, role: input.role, workingDirectory: paths.work!,
      launch: Object.freeze({ executable: input.executable.executable, args: Object.freeze(['agent', '--no-leader', 'stdio']),
        cwd: paths.work!, env, shutdownTimeoutMs: 5_000 }),
      environmentKeys: Object.freeze(Object.keys(env).sort()), configurationFilesSnapshot, release: directory.release,
    });
  } catch (cause) {
    try { await directory.release(); } catch (cleanupError) {
      throw new NativeCleanupError(cause, cleanupError, directory.path, directory.release);
    }
    throw cause;
  }
}
