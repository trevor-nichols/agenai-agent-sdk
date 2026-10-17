import { createHash } from 'node:crypto';
import { open, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDependencyGraphIdentity } from './dependency-identity.js';
import { NativeInputError, semanticDigest, sha256 } from './json.js';

export const SDK_PACKAGE_NAMES = [
  '@agen-ai/validation', '@agen-ai/agent-protocol', '@agen-ai/agent-runtime',
  '@agen-ai/agent-orchestration', '@agen-ai/acp-transport', '@agen-ai/provider-acp', '@agen-ai/acp-registry',
] as const;

export interface RuntimeFile { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface SdkPackageIdentity {
  readonly name: typeof SDK_PACKAGE_NAMES[number];
  readonly version: '0.4.2';
  readonly sourceGitTree: string;
  readonly manifestSha256: string;
  readonly runtimeFiles: readonly RuntimeFile[];
  readonly runtimeTreeSha256: string;
}
export interface DependencyRecord {
  readonly integrity: string | null;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
}
export interface NativeSdkIdentity {
  readonly sourceRevision: string;
  readonly nodeVersion: string;
  readonly nodeSha256: string;
  readonly pnpmVersion: string;
  readonly pnpmSha256: string;
  readonly lockfileSha256: string;
  readonly packages: readonly SdkPackageIdentity[];
  readonly mcp: Readonly<{
    version: '1.29.0'; rootSnapshot: string; graph: Readonly<Record<string, DependencyRecord>>;
    graphSha256: string; runtimeFiles: readonly RuntimeFile[]; runtimeTreeSha256: string;
  }>;
}

export function resolveSdkManifest(name: typeof SDK_PACKAGE_NAMES[number]): string {
  if (name === '@agen-ai/validation' || name === '@agen-ai/acp-transport') {
    const owner = name === '@agen-ai/validation' ? '@agen-ai/agent-protocol' : '@agen-ai/provider-acp';
    return createRequire(fileURLToPath(import.meta.resolve(`${owner}/package.json`))).resolve(`${name}/package.json`);
  }
  return fileURLToPath(import.meta.resolve(`${name}/package.json`));
}

export async function hashRegularFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new NativeInputError('identity_file_invalid');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > before.size) throw new NativeInputError('source_identity_drift');
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new NativeInputError('source_identity_drift');
    }
    return { bytes, sha256: `sha256:${hash.digest('hex')}` };
  } finally { await handle.close(); }
}

export async function runtimeFiles(root: string): Promise<readonly RuntimeFile[]> {
  const records: RuntimeFile[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new NativeInputError('runtime_symlink_denied');
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !/\.(?:js|mjs|cjs|json)$/u.test(entry.name)) continue;
      if (records.length >= 4096) throw new NativeInputError('runtime_file_limit');
      records.push({ path: relative(root, path).split('\\').join('/'), ...await hashRegularFile(path) });
    }
  }
  await visit(root);
  return records.sort((a, b) => a.path < b.path ? -1 : 1);
}

export async function assertSdkIdentity(expected: NativeSdkIdentity): Promise<void> {
  if (process.versions.node !== expected.nodeVersion || (await hashRegularFile(await realpath(process.execPath))).sha256 !== expected.nodeSha256) {
    throw new NativeInputError('source_identity_drift');
  }
  for (const item of expected.packages) {
    const manifestPath = resolveSdkManifest(item.name);
    const manifest = await readFile(manifestPath);
    const parsed = JSON.parse(manifest.toString()) as { name: string; version: string };
    if (sha256(manifest) !== item.manifestSha256 || parsed.name !== item.name || parsed.version !== item.version) {
      throw new NativeInputError('source_identity_drift');
    }
    const files = await runtimeFiles(join(dirname(manifestPath), 'dist'));
    if (semanticDigest(files) !== item.runtimeTreeSha256 || semanticDigest(item.runtimeFiles) !== item.runtimeTreeSha256) {
      throw new NativeInputError('source_identity_drift');
    }
  }
  // Resolve through the bridge's actual dependency graph, not an unrelated root install.
  const orchestration = dirname(fileURLToPath(import.meta.resolve('@agen-ai/agent-orchestration/package.json')));
  const mcpEntry = createRequire(join(orchestration, 'package.json')).resolve('@modelcontextprotocol/sdk/server/index.js');
  const mcpRoot = await realpath(join(dirname(mcpEntry), '../../..'));
  const mcpManifest = JSON.parse(await readFile(join(mcpRoot, 'package.json'), 'utf8')) as { version: string };
  const mcpFiles = await runtimeFiles(join(mcpRoot, 'dist'));
  if (mcpManifest.version !== expected.mcp.version || semanticDigest(mcpFiles) !== expected.mcp.runtimeTreeSha256
    || semanticDigest(expected.mcp.runtimeFiles) !== expected.mcp.runtimeTreeSha256
    || semanticDigest(expected.mcp.graph) !== expected.mcp.graphSha256) throw new NativeInputError('source_identity_drift');
  await assertDependencyGraphIdentity(join(mcpRoot, 'package.json'), expected.mcp);
}

export async function captureRunnerFiles(): Promise<readonly RuntimeFile[]> {
  const parent = fileURLToPath(new URL('../', import.meta.url));
  const files: RuntimeFile[] = [];
  for (const entry of await readdir(join(parent, 'native'), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|py)$/u.test(entry.name)) continue;
    const path = `native/${entry.name}`;
    files.push({ path, ...await hashRegularFile(join(parent, path)) });
  }
  files.push({ path: 'native.ts', ...await hashRegularFile(join(parent, 'native.ts')) });
  return files.sort((a, b) => a.path < b.path ? -1 : 1);
}

export async function assertRunnerIdentity(expected: { readonly runnerFiles: readonly RuntimeFile[]; readonly runnerDigest: string }): Promise<void> {
  const actual = await captureRunnerFiles();
  if (semanticDigest(actual) !== expected.runnerDigest || semanticDigest(expected.runnerFiles) !== expected.runnerDigest) {
    throw new NativeInputError('source_identity_drift');
  }
}
