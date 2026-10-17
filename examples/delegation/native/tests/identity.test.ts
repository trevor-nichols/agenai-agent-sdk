// ------------------------------------------------------------------------------------------------
//                identity.test.ts - Installed dependency closure at native preflight
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DependencyRecord, NativeSdkIdentity, RuntimeFile } from '../identity.js';

const packageNames = [
  '@agen-ai/validation', '@agen-ai/agent-protocol', '@agen-ai/agent-runtime',
  '@agen-ai/agent-orchestration', '@agen-ai/acp-transport', '@agen-ai/provider-acp', '@agen-ai/acp-registry',
] as const;
const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const treeHash = (value: unknown) => hash(canonical(value));
const rootSnapshot = '@modelcontextprotocol/sdk@1.29.0(native-optional-peer@1.0.0)(native-peer@1.0.0)';
const branchSnapshot = 'native-branch@1.0.0(native-peer@2.0.0)';
const dependency = (dependencies: Record<string, string> = {}, optionalDependencies: Record<string, string> = {}): DependencyRecord => ({
  integrity: null, dependencies, optionalDependencies,
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-identity-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const copiedSource = join(root, 'native');
  await mkdir(copiedSource);
  // Relocate the real preflight so its ordinary Node resolution sees this owned installation.
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) await copyFile(join(source, entry.name), join(copiedSource, entry.name));
  }
  async function install(base: string, manifest: Record<string, unknown>, entry = 'index.js') {
    const packageRoot = join(base, 'node_modules', String(manifest.name));
    await mkdir(join(packageRoot, 'dist', dirname(entry)), { recursive: true });
    const manifestBytes = JSON.stringify({ type: 'module', exports: { './package.json': './package.json' }, ...manifest });
    const code = 'throw new Error("Dependency code must never execute during identity preflight");\n';
    await writeFile(join(packageRoot, 'package.json'), manifestBytes);
    await writeFile(join(packageRoot, 'dist', entry), code);
    const files: RuntimeFile[] = [{ path: entry, bytes: Buffer.byteLength(code), sha256: hash(code) }];
    return { root: packageRoot, manifestPath: join(packageRoot, 'package.json'), manifestBytes, files };
  }
  const packages: NativeSdkIdentity['packages'][number][] = [];
  for (const name of packageNames) {
    const installed = await install(root, { name, version: '0.4.2' });
    packages.push({ name, version: '0.4.2', sourceGitTree: 'a'.repeat(40), manifestSha256: hash(installed.manifestBytes),
      runtimeFiles: installed.files, runtimeTreeSha256: treeHash(installed.files) });
  }
  const mcp = await install(root, {
    name: '@modelcontextprotocol/sdk', version: '1.29.0',
    exports: { './server/index.js': './dist/cjs/server/index.js' },
    dependencies: { 'native-branch': '^1.0.0', 'native-shared': '^1.0.0' },
    peerDependencies: { 'native-peer': '^1.0.0' },
    peerDependenciesMeta: { 'native-optional-peer': { optional: true } },
    optionalDependencies: { 'native-optional': '^1.0.0' },
  }, 'cjs/server/index.js');
  const branchManifest = {
    name: 'native-branch', version: '1.0.0', dependencies: { 'native-shared': '^2.0.0' },
    peerDependencies: { 'native-peer': '^2.0.0' }, optionalDependencies: { 'native-absent': '^1.0.0' },
  };
  const branch = await install(root, branchManifest);
  const nestedShared = await install(branch.root, {
    name: 'native-shared', version: '2.0.0', dependencies: { 'native-branch': '^1.0.0' },
    exports: { './only': './dist/index.js' },
  });
  const nestedPeer = await install(branch.root, { name: 'native-peer', version: '2.0.0' });
  await install(root, { name: 'native-shared', version: '1.0.0' });
  await install(root, { name: 'native-peer', version: '1.0.0' });
  const optional = await install(root, { name: 'native-optional', version: '1.0.0' });
  await install(root, { name: 'native-optional-peer', version: '1.0.0' });
  const graph: Record<string, DependencyRecord> = {
    [rootSnapshot]: dependency({ 'native-branch': '1.0.0(native-peer@2.0.0)', 'native-shared': '1.0.0', 'native-peer': '1.0.0' },
      { 'native-optional': '1.0.0', 'native-optional-peer': '1.0.0' }),
    [branchSnapshot]: dependency({ 'native-shared': '2.0.0', 'native-peer': '2.0.0' }),
    'native-shared@2.0.0': dependency({ 'native-branch': '1.0.0(native-peer@2.0.0)' }),
    'native-shared@1.0.0': dependency(), 'native-peer@1.0.0': dependency(), 'native-peer@2.0.0': dependency(),
    'native-optional@1.0.0': dependency(), 'native-optional-peer@1.0.0': dependency(),
  };
  const expected: NativeSdkIdentity = {
    sourceRevision: 'a'.repeat(40), nodeVersion: process.versions.node,
    nodeSha256: hash(await readFile(await realpath(process.execPath))), pnpmVersion: '11.7.0',
    pnpmSha256: hash('fixture pnpm'), lockfileSha256: hash('fixture lock'), packages,
    mcp: { version: '1.29.0', rootSnapshot, graph, graphSha256: treeHash(graph),
      runtimeFiles: mcp.files, runtimeTreeSha256: treeHash(mcp.files) },
  };
  const preflight = await import(pathToFileURL(join(copiedSource, 'identity.ts')).href) as typeof import('../identity.js');
  return { expected, check: preflight.assertSdkIdentity, install, root, branch, branchManifest, nestedShared, nestedPeer, optional };
}

test('native preflight verifies the installed dependency closure, not a self-consistent supplied graph', async (t) => {
  const f = await fixture(t);
  await f.check(f.expected);
  const drift = { name: 'NativeInputError', code: 'source_identity_drift' };
  const changeGraph = (graph: Record<string, DependencyRecord>, selectedRoot = rootSnapshot): NativeSdkIdentity => ({
    ...f.expected, mcp: { ...f.expected.mcp, rootSnapshot: selectedRoot, graph, graphSha256: treeHash(graph) },
  });
  await t.test('a truncated graph with a recomputed checksum is rejected', async () => {
    await assert.rejects(f.check(changeGraph({ [rootSnapshot]: dependency() })), drift);
  });
  await t.test('invented reachable and unreachable packages are rejected', async () => {
    const graph: Record<string, DependencyRecord> = structuredClone(f.expected.mcp.graph);
    graph['native-invented@1.0.0'] = dependency();
    await assert.rejects(f.check(changeGraph(graph)), drift);
    graph[rootSnapshot] = dependency({ ...graph[rootSnapshot]!.dependencies, 'native-invented': '1.0.0' },
      { ...graph[rootSnapshot]!.optionalDependencies });
    await assert.rejects(f.check(changeGraph(graph)), drift);
  });
  await t.test('nested version and required edge drift are rejected', async () => {
    const original = await readFile(f.nestedShared.manifestPath);
    try {
      await writeFile(f.nestedShared.manifestPath, JSON.stringify({ name: 'native-shared', version: '2.0.1' }));
      await assert.rejects(f.check(f.expected), drift);
    } finally { await writeFile(f.nestedShared.manifestPath, original); }
    const branchBytes = await readFile(f.branch.manifestPath);
    try {
      await writeFile(f.branch.manifestPath, JSON.stringify({ ...f.branchManifest,
        dependencies: { 'native-shared': '^2.0.0', 'native-new-required': '^1.0.0' } }));
      await f.install(f.branch.root, { name: 'native-new-required', version: '1.0.0' });
      await assert.rejects(f.check(f.expected), drift);
    } finally { await writeFile(f.branch.manifestPath, branchBytes); }
  });
  await t.test('installed optional dependencies and metadata-only optional peers are pinned', async () => {
    const original = await readFile(f.optional.manifestPath);
    try {
      await writeFile(f.optional.manifestPath, JSON.stringify({ name: 'native-optional', version: '1.0.1' }));
      await assert.rejects(f.check(f.expected), drift);
    } finally { await writeFile(f.optional.manifestPath, original); }
    const graph: Record<string, DependencyRecord> = structuredClone(f.expected.mcp.graph);
    graph[rootSnapshot] = dependency({ ...graph[rootSnapshot]!.dependencies }, { 'native-optional': '1.0.0' });
    delete graph['native-optional-peer@1.0.0'];
    await assert.rejects(f.check(changeGraph(graph)), drift);
  });
  await t.test('actual peer bindings and snapshot peer context must both match', async () => {
    const original = await readFile(f.nestedPeer.manifestPath);
    try {
      await writeFile(f.nestedPeer.manifestPath, JSON.stringify({ name: 'native-peer', version: '2.0.1' }));
      await assert.rejects(f.check(f.expected), drift);
    } finally { await writeFile(f.nestedPeer.manifestPath, original); }
    const graph: Record<string, DependencyRecord> = structuredClone(f.expected.mcp.graph);
    const dishonest = '@modelcontextprotocol/sdk@1.29.0(native-optional-peer@1.0.0)(native-peer@9.0.0)';
    graph[dishonest] = graph[rootSnapshot]!;
    delete graph[rootSnapshot];
    await assert.rejects(f.check(changeGraph(graph, dishonest)), drift);
  });
  await t.test('missing pinned optional and newly installed optional dependencies are rejected', async () => {
    const parked = `${f.optional.root}-parked`;
    await rename(f.optional.root, parked);
    try { await assert.rejects(f.check(f.expected), drift); }
    finally { await rename(parked, f.optional.root); }
    const installed = await f.install(f.branch.root, { name: 'native-absent', version: '1.0.0' });
    try { await assert.rejects(f.check(f.expected), drift); }
    finally { await rm(installed.root, { recursive: true }); }
  });
  await t.test('unsafe package paths and unsupported references are rejected', async () => {
    for (const [name, reference] of [['../escape', '1.0.0'], ['native-branch', '../../escape'], ['native-branch', 'npm:elsewhere@1.0.0']]) {
      const graph: Record<string, DependencyRecord> = structuredClone(f.expected.mcp.graph);
      graph[rootSnapshot] = dependency({ ...graph[rootSnapshot]!.dependencies, [name!]: reference! },
        { ...graph[rootSnapshot]!.optionalDependencies });
      await assert.rejects(f.check(changeGraph(graph)), drift);
    }
  });
  // The cycle, nested versions and genuinely absent optional dependency remain valid together.
  await f.check(f.expected);
});
