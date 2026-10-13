// ------------------------------------------------------------------------------------------------
//                launch.test.ts - Owned file, environment, decoder and retained-store boundaries
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createAcpInstallPlan, parseAcpRegistrySnapshot, searchAcpRegistry } from '@agen-ai/acp-registry';
import { openAcpInstallationStore } from '@agen-ai/acp-registry/node';
import { allocateNativeProcess, prepareDirectExecutable, type NativeLaunchCandidate, type RegistryInstallationDescriptor } from '../launch.js';
import { openRegistryExecutable } from '../registry.js';

const run = promisify(execFile);
const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
const identity = (bytes: Uint8Array) => ({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-launch-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('\x7fELFowned-native-fixture');
  const source = join(root, 'source');
  const command = join(root, 'command');
  await writeFile(source, bytes, { mode: 0o700 });
  await symlink(source, command);
  const candidate: NativeLaunchCandidate = {
    native: { ...identity(bytes), version: '1.0.50', target: 'linux-x86_64', installedCommandPath: command, inspectedExecutablePath: source },
    launch: { args: ['agent', '--no-leader', 'stdio'] },
    upstreamArtifact: { ...identity(gzipSync(bytes)), url: 'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.50-linux-x86_64.gz',
      decoded: { ...identity(bytes), magicHex: '7f454c46' } },
    transformation: { recipe: 'gzip-single-member-stream-v1', decoderExecutable: '/usr/bin/python3', decoderExecutableSha256: '0'.repeat(64),
      pythonVersion: '0.0.0', zlibCompileVersion: '0', zlibRuntimeVersion: '0', inputChunkBytes: 1_048_576,
      outputChunkBytes: 1_048_576, maxInputBytes: 104_857_600, maxOutputBytes: 268_435_456, plannedTimeoutMs: 30_000 },
  };
  return { root, bytes, source, command, candidate };
}

test('the direct lease owns pinned read-only bytes, detects drift and retires only its allocation', async (t) => {
  const f = await fixture(t);
  const lease = await prepareDirectExecutable({ root: f.root, candidate: f.candidate });
  assert.deepEqual(await readFile(lease.executable), f.bytes);
  assert.equal((await lstat(lease.executable)).mode & 0o777, 0o555);
  await writeFile(f.source, 'original changed after copying');
  await lease.assertUnchanged();
  await chmod(lease.executable, 0o700);
  await writeFile(lease.executable, 'owned copy changed');
  await assert.rejects(lease.assertUnchanged(), /pinned identity/u);
  const ownedDirectory = dirname(lease.executable);
  const retained = `${ownedDirectory}-retained`;
  await rename(ownedDirectory, retained);
  await mkdir(ownedDirectory, { mode: 0o700 });
  await writeFile(join(ownedDirectory, 'foreign'), 'preserve');
  try {
    await assert.rejects(lease.release(), /directory identity changed/u);
    assert.equal(await readFile(join(ownedDirectory, 'foreign'), 'utf8'), 'preserve');
  } finally {
    await rm(ownedDirectory, { recursive: true });
    await rename(retained, ownedDirectory);
  }
  await Promise.all([lease.release(), lease.release()]);
  await lease.release();
  await assert.rejects(lstat(lease.executable), { code: 'ENOENT' });
  assert.equal(await readFile(f.source, 'utf8'), 'original changed after copying');
});

test('changed command/source pins fail before allocating an executable owner', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, 'changed');
  await assert.rejects(prepareDirectExecutable({ root: f.root, candidate: f.candidate }), /pinned identity/u);
  assert.deepEqual((await readdir(f.root)).sort(), ['command', 'source']);
  await rm(f.command);
  await symlink('/bin/true', f.command);
  await assert.rejects(prepareDirectExecutable({ root: f.root, candidate: f.candidate }), /different executable/u);
  assert.deepEqual((await readdir(f.root)).sort(), ['command', 'source']);
});

test('process allocations isolate parent and child loading, and keep credentials outside evidence', async (t) => {
  const f = await fixture(t);
  const lease = await prepareDirectExecutable({ root: f.root, candidate: f.candidate });
  const parent = await allocateNativeProcess({ root: f.root, role: 'parent', executable: lease, credential: () => 'fixture-private-key' });
  const child = await allocateNativeProcess({ root: f.root, role: 'child', executable: lease, credential: () => undefined });
  try {
    assert.notEqual(parent.workingDirectory, child.workingDirectory);
    assert.deepEqual(await readdir(parent.workingDirectory), []);
    assert.notEqual(parent.launch.env!.HOME, parent.launch.env!.GROK_HOME);
    assert.notEqual(parent.launch.env!.HOME, child.launch.env!.HOME);
    assert.deepEqual(parent.launch.args, ['agent', '--no-leader', 'stdio']);
    assert.equal(parent.launch.env!.XAI_API_KEY, 'fixture-private-key');
    assert.equal(child.launch.env!.XAI_API_KEY, undefined);
    assert.equal(parent.launch.env!.NODE_OPTIONS, undefined);
    assert.equal(parent.launch.env!.GROK_SUBAGENTS, undefined);
    assert.equal(parent.launch.env!.GROK_DISABLE_AUTOUPDATER, '1');
    assert.equal(parent.launch.env!.GROK_CURSOR_SKILLS_ENABLED, '0');
    assert.equal(parent.launch.env!.GROK_CLAUDE_MCPS_ENABLED, '0');
    const records = await parent.configurationFilesSnapshot();
    assert.equal(JSON.stringify({ keys: parent.environmentKeys, records, evidence: lease.evidence }).includes('fixture-private-key'), false);
    assert.equal(await readFile(join(parent.launch.env!.GROK_HOME!, 'config.toml'), 'utf8'), '[cli]\nauto_update = false\n');
    await parent.configurationFilesSnapshot();
  } finally { await parent.release(); await child.release(); await lease.release(); }
});

test('uninspected ancestor loading and rejected credential setup leave no orphan allocation', async (t) => {
  const f = await fixture(t);
  const lease = await prepareDirectExecutable({ root: f.root, candidate: f.candidate });
  try {
    const before = (await readdir(f.root)).sort();
    await writeFile(join(f.root, 'AGENTS.md'), 'uninspected instructions');
    let credentialCalls = 0;
    await assert.rejects(allocateNativeProcess({ root: f.root, role: 'parent', executable: lease,
      credential: () => { credentialCalls += 1; return undefined; } }), /Uninspected ancestor/u);
    assert.equal(credentialCalls, 0);
    await rm(join(f.root, 'AGENTS.md'));
    assert.deepEqual((await readdir(f.root)).sort(), before);
    const rejected = new Error('credential unavailable');
    await assert.rejects(allocateNativeProcess({ root: f.root, role: 'child', executable: lease,
      credential: () => { throw rejected; } }), (error) => error === rejected);
    assert.deepEqual((await readdir(f.root)).sort(), before);
  } finally { await lease.release(); }
});

test('a real offline raw installation reopens only in another process after source removal', async (t) => {
  const f = await fixture(t);
  const artifactUrl = 'https://qualification.invalid/fixture.bin';
  const snapshot = parseAcpRegistrySnapshot({ source: { namespace: 'test', kind: 'local', channel: 'stable', location: 'fixture:1', profile: 'published-v1' },
    content: JSON.stringify({ version: '1.0.0', agents: [{ id: 'fixture', name: 'Fixture', version: '1.0.50', description: 'Owned test bytes',
      license_url: 'https://example.invalid/license', distribution: { binary: { 'linux-x86_64': { archive: artifactUrl, cmd: 'grok',
        sha256: f.candidate.native.sha256, args: ['agent', '--no-leader', 'stdio'], env: {} } } } }] }) });
  const [entry] = searchAcpRegistry(snapshot, { query: 'fixture', target: 'linux-x86_64' });
  assert.ok(entry);
  const plan = createAcpInstallPlan(snapshot, { entryIdentity: entry.identity, expectedEntryDigest: entry.digest, expectedSnapshotDigest: snapshot.digest,
    target: 'linux-x86_64', distributionPreference: ['binary'], binaryFormat: 'raw', policy: { network: 'offline', allowedOrigins: [],
      allowInsecureHttp: false, packageScripts: 'deny', integrity: 'require-expected-sha256', reproducibility: 'require-complete', allowedEnvironmentKeys: [] } });
  const storeRoot = join(f.root, 'store');
  const store = await openAcpInstallationStore({ root: storeRoot });
  const receipt = await store.install({ plan, expectedPlanDigest: plan.digest,
    localArtifacts: [{ path: f.source, url: artifactUrl, sha256: `sha256:${f.candidate.native.sha256}` }] });
  const installation: RegistryInstallationDescriptor = { format: 'native-local-raw-installation-v1', storeRoot, installerProcessId: process.pid,
    allocationId: 'fixture', snapshotDigest: snapshot.digest, planDigest: plan.digest, installationId: receipt.installationId,
    receiptDigest: receipt.receiptDigest, native: identity(f.bytes), transformation: { ...identity(gzipSync(f.bytes)), decoded: identity(f.bytes),
      decoderExecutableSha256: '0'.repeat(64), pythonVersion: '0', zlibCompileVersion: '0', zlibRuntimeVersion: '0' } };
  await assert.rejects(openRegistryExecutable({ root: f.root, candidate: f.candidate, installation, ownerId: 'fixture' }), /fresh process/u);
  await rm(f.source);
  const registryModule = pathToFileURL(fileURLToPath(new URL('../registry.ts', import.meta.url))).href;
  const program = `import {openRegistryExecutable} from ${JSON.stringify(registryModule)};
    const input=JSON.parse(process.argv[1]); const lease=await openRegistryExecutable(input);
    await lease.assertUnchanged(); console.log(JSON.stringify(lease.evidence)); await lease.release();`;
  const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program,
    JSON.stringify({ root: f.root, candidate: f.candidate, installation, ownerId: 'fixture-reopened' })],
  { env: environment, timeout: 10_000, maxBuffer: 8_192 });
  const evidence = JSON.parse(result.stdout) as { registry: { reopenedFromFreshProcess: boolean }; identity: { sha256: string } };
  assert.equal(evidence.registry.reopenedFromFreshProcess, true);
  assert.equal(evidence.identity.sha256, f.candidate.native.sha256);
  await assert.rejects(store.read({ planDigest: plan.digest, installationId: receipt.installationId }), { code: 'installation_not_found' });
});

test('gzip transformation bounds real decoder output and rejects incomplete, trailing and extra-member streams', async (t) => {
  const f = await fixture(t);
  const python = await realpath('/usr/bin/python3');
  const version = JSON.parse((await run(python, ['-I', '-S', '-c',
    'import json,sys,zlib;print(json.dumps({"pythonVersion":".".join(map(str,sys.version_info[:3])),"zlibCompileVersion":zlib.ZLIB_VERSION,"zlibRuntimeVersion":zlib.ZLIB_RUNTIME_VERSION}))'],
  { env: environment, timeout: 5_000, maxBuffer: 8_192 })).stdout) as Record<string, string>;
  const payload = Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(100_000, 65)]);
  const compressed = gzipSync(payload);
  for (const [name, data, maximum, success] of [
    ['valid', compressed, payload.length, true],
    ['truncated', compressed.subarray(0, compressed.length - 2), payload.length, false],
    ['trailing', Buffer.concat([compressed, Buffer.from('trailing')]), payload.length, false],
    ['second-member', Buffer.concat([compressed, gzipSync(payload)]), payload.length * 2, false],
    ['expansion-limit', compressed, payload.length - 1, false],
  ] as const) {
    await t.test(name, async () => {
      const source = join(f.root, `${name}.gz`);
      const destination = join(f.root, `${name}.bin`);
      await writeFile(source, data);
      const specification = JSON.stringify({ ...version, inputChunkBytes: 1_024, outputChunkBytes: 17,
        maxInputBytes: 104_857_600, maxOutputBytes: maximum, compressed: identity(data), decoded: identity(payload), magicHex: '7f454c46' });
      const child = execFile(python, ['-I', '-S', '-B', fileURLToPath(new URL('../gzip.py', import.meta.url)), source, destination],
        { env: environment, timeout: 5_000, maxBuffer: 8_192 });
      const result = new Promise<string>((resolve, reject) => {
        child.once('error', reject);
        let output = '';
        child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error('decoder rejected stream')));
      });
      child.stdin!.end(specification);
      if (success) {
        const evidence = JSON.parse(await result) as { decoded: { bytes: number; sha256: string } };
        assert.deepEqual(evidence.decoded, identity(payload));
        assert.deepEqual(await readFile(destination), payload);
      } else await assert.rejects(result, /decoder rejected stream/u);
    });
  }
});
