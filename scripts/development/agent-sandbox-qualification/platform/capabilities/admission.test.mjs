import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readManifestInput } from '../configuration.mjs';
import { admitPlatformRun } from './admission.mjs';
import { acquireJsonInput, assertInputCurrent } from './input.mjs';
import { parseCapabilityManifest } from './manifest.mjs';
import { capabilityManifest, platformManifest } from './test-fixtures.mjs';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));
const profiles = ['linux-x64', 'desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64'];
const unimplementedRows = ['restricted-https'];

async function fixture(t, profile = 'linux-x64', engine) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pc-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { row: 'combined', manifestPath: join(root, 'platform.json'), capabilitiesManifestPath: join(root, 'capabilities.json'),
    consumer: '/unopened/consumer', output: join(root, 'output') };
  const platform = platformManifest(profile, engine);
  const platformBytes = `${JSON.stringify(platform, null, 2)}\n`;
  await writeFile(options.manifestPath, platformBytes);
  const baselineSha = createHash('sha256').update(platformBytes).digest('hex');
  const write = (value) => writeFile(options.capabilitiesManifestPath, JSON.stringify(value));
  return { root, options, platform, baselineSha, write };
}

test('advanced owner retains explicit UNIMPLEMENTED for rows without a scenario before runtime admission', async (t) => {
  for (const profile of profiles.slice(0, 1)) {
    const context = await fixture(t, profile);
    for (const row of unimplementedRows) {
      await context.write(capabilityManifest(row, context.baselineSha, context.platform));
      await assert.rejects(admitPlatformRun({ ...context.options, row }), {
        name: 'UnimplementedCapabilityRowError', code: 'UNIMPLEMENTED',
        message: `UNIMPLEMENTED: capability row ${row} has validated inputs but no admitted scenario implementation.`,
      });
    }
    assert.deepEqual((await readdir(context.root)).sort(), ['capabilities.json', 'platform.json']);
  }
});

test('combined admission captures the real transfer parent and rejects an oversized simultaneous sibling composition before effects', async (t) => {
  const context = await fixture(t);
  const parent = join(context.root, 'host'); await mkdir(parent);
  await writeFile(join(parent, 'caller-owned'), 'unchanged');
  const expected = capabilityManifest('combined', context.baselineSha, context.platform);
  expected.transfers.hostRoots[0].parent = parent; await context.write(expected);
  const selected = await admitPlatformRun(context.options);
  assert.deepEqual(selected.capabilities.manifest, expected);
  assert.equal(selected.capabilities.hostRoots[0].parent, parent);
  assert.equal(selected.capabilities.scenarioBudget.maximumConcurrentOwners, 2);
  assert.equal(selected.capabilities.scenarioBudget.maximumCases, 11);
  assert.equal(selected.capabilities.scenarioBudget.nanoCpus, 3_500_000_000);
  const oversized = structuredClone(expected); oversized.filesystem.configuration.resources.cpus = 1;
  await context.write(oversized);
  await assert.rejects(admitPlatformRun(context.options), /two simultaneous owners/u);
  assert.equal(await readFile(join(parent, 'caller-owned'), 'utf8'), 'unchanged');
  assert.deepEqual((await readdir(context.root)).sort(), ['capabilities.json', 'host', 'platform.json']);
  await assert.rejects(lstat(context.options.output), { code: 'ENOENT' });
});

test('live-files admission returns the immutable matching captured manifest before runtime effects', async (t) => {
  for (const profile of profiles) {
    const context = await fixture(t, profile);
    const expected = capabilityManifest('live-files', context.baselineSha, context.platform);
    await context.write(expected);
    const selected = await admitPlatformRun({ ...context.options, row: 'live-files' });
    assert.deepEqual(selected.manifest, context.platform);
    assert.deepEqual(selected.capabilities.manifest, expected);
    assert.equal(selected.capabilities.utf8, JSON.stringify(expected));
    assert.equal(selected.capabilities.input.sha256, createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
    assert.equal(selected.capabilities.manifest.platformManifestSha256, selected.input.sha256);
    assert.equal(Object.isFrozen(selected.capabilities.manifest.filesystem.configuration.control), true);
    assert.deepEqual((await readdir(context.root)).sort(), ['capabilities.json', 'platform.json']);
  }
});

test('restricted HTTPS admits both captured Desktop profiles with the complete bounded scenario inventory before effects', async (t) => {
  for (const profile of profiles.slice(1)) {
    const context = await fixture(t, profile);
    const expected = capabilityManifest('restricted-https', context.baselineSha, context.platform);
    expected.limits.cleanupMs = 30_000;
    await context.write(expected);
    const selected = await admitPlatformRun({ ...context.options, row: 'restricted-https' });
    assert.deepEqual(selected.capabilities.manifest, expected);
    assert.equal(selected.capabilities.input.sha256, createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
    assert.equal(selected.capabilities.scenarioBudget.maximumCases, 26);
    assert.equal(selected.capabilities.scenarioBudget.maximumScopes, 101);
    assert.equal(selected.capabilities.scenarioBudget.maximumConcurrentFixtures, 3);
    assert.equal(selected.capabilities.scenarioBudget.observerCapacity, 128);
    assert(Object.isFrozen(selected.capabilities.scenarioBudget.roles));
    assert.deepEqual((await readdir(context.root)).sort(), ['capabilities.json', 'platform.json']);
    await assert.rejects(lstat(context.options.output), { code: 'ENOENT' });
  }
  const linux = await fixture(t);
  await linux.write(capabilityManifest('restricted-https', linux.baselineSha, linux.platform));
  await assert.rejects(admitPlatformRun({ ...linux.options, row: 'restricted-https' }), {
    name: 'UnimplementedCapabilityRowError', code: 'UNIMPLEMENTED',
  });
});

test('network fixture DNS admission requires an explicit canonical name and usable exact public-subnet member before effects', async (t) => {
  const context = await fixture(t, profiles[1]);
  const expected = capabilityManifest('restricted-https', context.baselineSha, context.platform);
  await context.write(expected);
  const selected = await admitPlatformRun({ ...context.options, row: 'restricted-https' });
  assert.equal(selected.capabilities.manifest.network.fixtures.publicHostname, '93-184-216-12.nip.io');
  assert.equal(selected.capabilities.manifest.network.fixtures.publicAddress, '93.184.216.12');
  for (const [mutate, pattern] of [
    [(value) => { delete value.publicHostname; }, /Unknown or missing/u],
    [(value) => { delete value.publicAddress; }, /Unknown or missing/u],
    [(value) => { value.publicHostname = 'Fixture.NIP.io'; }, /lowercase ASCII/u],
    [(value) => { value.publicHostname = '93.184.216.12'; }, /lowercase ASCII/u],
    [(value) => { value.publicHostname = 'xn--fixture.test'; }, /without IDNA/u],
    [(value) => { value.publicHostname = expected.network.positive.hostname; }, /must differ/u],
    [(value) => { value.publicAddress = '93.184.217.12'; }, /usable member/u],
    ...['93.184.216.0', '93.184.216.1', '93.184.216.255'].map((address) => [
      (value) => { value.publicAddress = address; }, /usable member/u]),
    [(value) => { value.publicAddress = '093.184.216.12'; }, /IPv4/u],
    [(value) => { value.dnsServer = '127.0.0.1'; }, /Unknown or missing/u],
  ]) {
    const invalid = structuredClone(expected); mutate(invalid.network.fixtures); await context.write(invalid);
    await assert.rejects(admitPlatformRun({ ...context.options, row: 'restricted-https' }), pattern);
  }
  assert.deepEqual((await readdir(context.root)).sort(), ['capabilities.json', 'platform.json']);
  await assert.rejects(lstat(context.options.output), { code: 'ENOENT' });
});

test('files and preserving rows reject inputs that fit one workspace but exceed simultaneous scenario ownership', async (t) => {
  const context = await fixture(t);
  for (const row of ['live-files', 'preserve-internal']) {
    const manifest = capabilityManifest(row, context.baselineSha, context.platform);
    manifest.workload.resources.cpus = 1;
    manifest.filesystem.configuration.resources.cpus = 1;
    await context.write(manifest);
    await assert.rejects(admitPlatformRun({ ...context.options, row }), /two workspaces and helpers/u);
  }
  assert.deepEqual((await readdir(context.root)).sort(), ['capabilities.json', 'platform.json']);
});

test('preserving admission captures its explicit helper and actual host parent without reserving output', async (t) => {
  const context = await fixture(t);
  const parent = join(context.root, 'host'); await mkdir(parent);
  await writeFile(join(parent, 'caller-owned'), 'unchanged');
  const expected = capabilityManifest('preserve-internal', context.baselineSha, context.platform);
  expected.transfers.hostRoots[0].parent = parent; await context.write(expected);
  const selected = await admitPlatformRun({ ...context.options, row: 'preserve-internal' });
  assert.deepEqual(selected.capabilities.manifest, expected);
  assert.equal(selected.capabilities.hostRoots.length, 1);
  assert.equal(selected.capabilities.hostRoots[0].parent, parent);
  const stat = await lstat(parent, { bigint: true });
  assert.equal(selected.capabilities.hostRoots[0].identity.device, String(stat.dev));
  assert.equal(selected.capabilities.hostRoots[0].identity.inode, String(stat.ino));
  assert(Object.isFrozen(selected.capabilities.hostRoots[0].identity));
  assert.deepEqual(await readdir(parent), ['caller-owned']);
  assert.deepEqual((await readdir(context.root)).sort(), ['capabilities.json', 'host', 'platform.json']);
  await assert.rejects(lstat(context.options.output), { code: 'ENOENT' });
});

test('preserving admission rejects the old incomplete row and unsafe actual host-root identities before effects', async (t) => {
  const context = await fixture(t);
  const parent = join(context.root, 'host'); await mkdir(parent);
  const incomplete = capabilityManifest('preserve-internal', context.baselineSha, context.platform);
  delete incomplete.filesystem; await context.write(incomplete);
  await assert.rejects(admitPlatformRun({ ...context.options, row: 'preserve-internal' }), /Unknown or missing/u);
  const alias = join(context.root, 'alias'); await symlink(parent, alias);
  const ordinary = join(context.root, 'ordinary'); await writeFile(ordinary, 'caller-owned');
  for (const [path, pattern] of [[alias, /physical/u], [ordinary, /directory/u], [join(context.root, 'absent'), /ENOENT/u]]) {
    const value = capabilityManifest('preserve-internal', context.baselineSha, context.platform);
    value.transfers.hostRoots[0].parent = path; await context.write(value);
    await assert.rejects(admitPlatformRun({ ...context.options, row: 'preserve-internal' }), pattern);
  }
  for (const profile of profiles.slice(1)) {
    const desktop = await fixture(t, profile);
    const other = join(context.root, 'other'); await mkdir(other, { recursive: true });
    const value = capabilityManifest('preserve-internal', desktop.baselineSha, desktop.platform);
    value.transfers.hostRoots[0].parent = parent; value.transfers.hostRoots[1].parent = other; await desktop.write(value);
    await assert.rejects(admitPlatformRun({ ...desktop.options, row: 'preserve-internal' }), /distinct filesystem devices/u);
    await assert.rejects(lstat(desktop.options.output), { code: 'ENOENT' });
  }
  assert.equal(await readFile(ordinary, 'utf8'), 'caller-owned');
  assert.deepEqual(await readdir(parent), []);
  await assert.rejects(lstat(context.options.output), { code: 'ENOENT' });
});

test('owner rejects malformed, unsafe and mismatched captured data instead of reaching its unimplemented branch', async (t) => {
  const context = await fixture(t, profiles[1]);
  const cases = [
    ['unknown script', (v) => { v.script = 'arbitrary'; }, /Unknown or missing/u],
    ['wrong row', (v) => { v.row = 'live-files'; }, /row differs/u],
    ['wrong profile', (v) => { v.profile = 'linux-x64'; }, /profile differs/u],
    ['wrong captured SHA', (v) => { v.platformManifestSha256 = 'f'.repeat(64); }, /baseline SHA differs/u],
    ['missing required section', (v) => { delete v.filesystem; }, /Unknown or missing/u],
    ['null required section', (v) => { v.filesystem = null; }, /Manifest object/u],
    ['string CPU', (v) => { v.workload.resources.cpus = '0.25'; }, /nano-CPU/u],
    ['fractional nano CPU', (v) => { v.workload.resources.cpus = 0.1000000001; }, /nano-CPU/u],
    ['unsafe integer', (v) => { v.workload.resources.pids = Number.MAX_SAFE_INTEGER + 1; }, /safe integers/u],
    ['aggregate CPU', (v) => { v.workload.resources.cpus = 2; v.filesystem.configuration.resources.cpus = 1; }, /Simultaneous qualification/u],
    ['aggregate memory', (v) => { v.workload.resources.memoryBytes = 1024 ** 3; v.filesystem.configuration.resources.memoryBytes = 1024 ** 3;
      v.network.egress.configuration.broker.resources.memoryBytes = 1024 ** 3;
      v.network.egress.configuration.relay.resources.memoryBytes = 1024 ** 3; }, /Simultaneous qualification/u],
    ['wrong user', (v) => { v.filesystem.configuration.user.uid = 0; }, /1000:1000/u],
    ['helper protocol', (v) => { v.network.egress.configuration.protocol = 'unknown'; }, /egress-connect/u],
    ['expired control', (v) => { v.filesystem.configuration.control.leaseTimeoutMs = 20_000; }, /leaseTimeoutMs/u],
    ['cleanup deadline above public SDK ceiling', (v) => { v.limits.cleanupMs = 30_001; }, /cleanupMs/u],
    ['scenario budget', (v) => { v.limits.scenarioMs = 30_000; v.limits.cleanupMs = 15_000; }, /Scenario budget/u],
    ['wrong transfer ordering', (v) => { v.transfers.hostRoots.reverse(); }, /role order/u],
    ['nested transfer parent', (v) => { v.transfers.hostRoots[1].parent = `${v.transfers.hostRoots[0].parent}/nested`; }, /outside each other/u],
    ['consumer overlap', (v) => { v.transfers.hostRoots[0].parent = context.options.consumer; }, /outside consumer/u],
    ['wrong authority kind', (v) => { v.network.routeAuthority.kind = 'local_linux_same_host'; }, /Desktop route authority/u],
    ['wrong Engine ID', (v) => { v.network.routeAuthority.engine.id = 'other'; }, /Engine ID differs/u],
    ['wrong Engine endpoint', (v) => { v.network.routeAuthority.engine.endpoint = 'unix:///tmp/other.sock'; }, /endpoint differs/u],
    ['wrong authority profile', (v) => { v.network.routeAuthority.profile = profiles[2]; }, /Authority profile/u],
    ['wrong deployment', (v) => { v.network.routeAuthority.deployment.hostNetworking = true; }, /deployment hostNetworking/u],
    ['observer script', (v) => { v.network.routeAuthority.hostObserver.executable.args = ['-e']; }, /Unknown or missing/u],
    ['wrong VM protocol', (v) => { v.network.routeAuthority.vmObserver.protocol = 'arbitrary'; }, /desktop-route-observer/u],
    ['uppercase hostname', (v) => { v.network.positive.hostname = 'Fixture.example'; }, /lowercase ASCII/u],
    ['IP hostname', (v) => { v.network.positive.hostname = '93.184.216.1'; }, /lowercase ASCII/u],
    ['IDNA hostname', (v) => { v.network.positive.hostname = 'xn--example.test'; }, /without IDNA/u],
    ['long DNS label', (v) => { v.network.positive.hostname = `${'x'.repeat(64)}.test`; }, /lowercase ASCII/u],
    ['fragment path', (v) => { v.network.positive.path = '/file#fragment'; }, /omit fragments/u],
    ['control path', (v) => { v.network.positive.path = '/file\u0001'; }, /without controls/u],
    ['private fixture subnet', (v) => { v.network.fixtures.publicSubnet = '10.2.3.0/24'; v.network.fixtures.publicGateway = '10.2.3.1'; }, /non-public/u],
    ['noncanonical subnet', (v) => { v.network.fixtures.publicSubnet = '93.184.216.2/24'; }, /network address/u],
    ['wrong gateway', (v) => { v.network.fixtures.publicGateway = '93.184.216.2'; }, /gateway/u],
    ['loopback host', (v) => { v.network.fixtures.hostAddress = '127.0.0.2'; }, /non-loopback/u],
    ['hostname host marker', (v) => { v.network.fixtures.hostAddress = 'local.test'; }, /IPv4/u],
  ];
  for (const [name, mutate, message] of cases) await t.test(name, async () => {
    const value = capabilityManifest('combined', context.baselineSha, context.platform); mutate(value);
    await context.write(value);
    await assert.rejects(admitPlatformRun(context.options), (error) => {
      assert.notEqual(error.code, 'UNIMPLEMENTED'); assert.match(error.message, message); return true;
    });
  });
  assert.deepEqual((await readdir(context.root)).sort(), ['capabilities.json', 'platform.json']);
});

test('row variants reject unrelated sections and Linux authority cannot carry Desktop fields', async (t) => {
  const context = await fixture(t);
  for (const [row, section] of [['live-files', 'network'], ['preserve-internal', 'network'], ['restricted-https', 'transfers']]) {
    const value = capabilityManifest(row, context.baselineSha, context.platform); value[section] = null;
    await context.write(value);
    await assert.rejects(admitPlatformRun({ ...context.options, row }), /Unknown or missing capability/u);
  }
  const value = capabilityManifest('restricted-https', context.baselineSha, context.platform);
  value.network.routeAuthority.profile = profiles[1]; await context.write(value);
  await assert.rejects(admitPlatformRun({ ...context.options, row: 'restricted-https' }), /Unknown or missing capability/u);
});

test('capture binds parsed bytes, SHA and stat identity, rejecting replacement and nonphysical or malformed files', async (t) => {
  const context = await fixture(t);
  const bytes = await readFile(context.options.manifestPath);
  const selected = await readManifestInput(context.options.manifestPath, 'core');
  assert.deepEqual(selected.manifest, context.platform);
  assert.equal(selected.utf8, bytes.toString('utf8'));
  assert.equal(selected.input.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(selected.input.bytes, bytes.length);
  assert.equal(Object.isFrozen(selected.manifest.expected.daemon), true);
  await assertInputCurrent(selected.input);
  await writeFile(join(context.root, 'replacement'), bytes);
  await rename(join(context.root, 'replacement'), context.options.manifestPath);
  await assert.rejects(assertInputCurrent(selected.input), /identity changed/u);
  const link = join(context.root, 'link.json'); await symlink(context.options.manifestPath, link);
  await assert.rejects(acquireJsonInput(link, 128 * 1024), /physical/u);
  for (const bytes of [Buffer.from('{broken'), Buffer.from([0x22, 0xc0, 0xaf, 0x22]), Buffer.alloc(128 * 1024 + 1, 0x20)]) {
    await writeFile(context.options.capabilitiesManifestPath, bytes);
    await assert.rejects(admitPlatformRun(context.options), (error) => error.code !== 'UNIMPLEMENTED');
  }
});

test('closed data boundary refuses accessors, hidden fields, symbols, sparse arrays and excessive graphs without evaluating them', async (t) => {
  const context = await fixture(t);
  const options = { row: 'combined', platform: context.platform, platformInput: { sha256: context.baselineSha },
    consumer: context.options.consumer, output: context.options.output };
  for (const mutate of [
    (v) => { Object.defineProperty(v, 'unsafe', { get() { assert.fail('Accessor evaluated.'); }, enumerable: true }); },
    (v) => { Object.defineProperty(v, 'unsafe', { value: true }); },
    (v) => { v[Symbol('unsafe')] = true; },
    (v) => { delete v.transfers.hostRoots[0]; },
    (v) => { v.unsafe = Array.from({ length: 2048 }, () => null); },
    (v) => { v.unsafe = Array.from({ length: 65 }, (_, index) => [index, true]).reduce((a, [key, value]) => ({ ...a, [key]: value }), {}); },
    (v) => { v.unsafe = Array.from({ length: 13 }).reduce((a) => ({ nested: a }), null); },
    (v) => { Object.setPrototypeOf(v, new Date()); },
  ]) {
    const value = capabilityManifest('combined', context.baselineSha, context.platform); mutate(value);
    assert.throws(() => parseCapabilityManifest(value, options), /data|Accessors|graph|object/u);
  }
});

test('CLI returns explicit advanced failures while a reachable Engine sees no admission and output remains unreserved', async (t) => {
  const context = await fixture(t);
  const socket = join(context.root, 'e');
  assert(Buffer.byteLength(socket) < 104);
  const requests = [];
  const server = createServer((request, response) => { requests.push(`${request.method} ${request.url}`); response.end('{}'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise((resolve, reject) => {
    get({ socketPath: socket, path: '/canary' }, (response) => { response.resume(); response.once('end', resolve); }).once('error', reject);
  });
  assert.deepEqual(requests, ['GET /canary']);
  const platform = platformManifest('linux-x64', `unix://${socket}`);
  const bytes = JSON.stringify(platform); await writeFile(context.options.manifestPath, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const output = `/tmp/pc-${context.root.split('/').at(-1)}`;
  for (const row of unimplementedRows) {
    await context.write(capabilityManifest(row, digest, platform));
    const args = ['--row', row, '--manifest', context.options.manifestPath, '--capabilities-manifest', context.options.capabilitiesManifestPath,
      '--consumer', context.options.consumer, '--output', output];
    await assert.rejects(execute(process.execPath, [runner, ...args], { env: {}, timeout: 15_000 }), (error) => {
      assert.equal(error.code, 1); assert.equal(error.stdout, '');
      const result = JSON.parse(error.stderr);
      assert.equal(result.status, 'failed'); assert.equal(result.failure.name, 'UnimplementedCapabilityRowError');
      assert.equal(result.failure.code, 'UNIMPLEMENTED'); assert.match(result.failure.message, new RegExp(`capability row ${row} `, 'u'));
      return true;
    });
  }
  const incompletePreserving = capabilityManifest('preserve-internal', digest, platform); delete incompletePreserving.filesystem;
  for (const [row, content, message] of [
    ['live-files', '{invalid', /JSON|property name/u],
    ['live-files', JSON.stringify({ ...capabilityManifest('live-files', digest, platform), callback: 'forbidden' }), /Unknown or missing/u],
    ['live-files', JSON.stringify(capabilityManifest('live-files', 'f'.repeat(64), platform)), /baseline SHA differs/u],
    ['preserve-internal', JSON.stringify(incompletePreserving), /Unknown or missing/u],
  ]) {
    await writeFile(context.options.capabilitiesManifestPath, content);
    await assert.rejects(execute(process.execPath, [runner, '--row', row, '--manifest', context.options.manifestPath,
      '--capabilities-manifest', context.options.capabilitiesManifestPath, '--consumer', context.options.consumer, '--output', output],
    { env: {}, timeout: 15_000 }), (error) => {
      assert.equal(error.code, 1); assert.equal(error.stdout, '');
      const result = JSON.parse(error.stderr);
      assert.equal(result.status, 'failed'); assert.notEqual(result.failure.code, 'UNIMPLEMENTED');
      assert.match(result.failure.message, message); return true;
    });
  }
  assert.deepEqual(requests, ['GET /canary']);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});
