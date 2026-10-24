// ------------------------------------------------------------------------------------------------
//                datasets.test.ts - Borrowed image mounts, exact recovery binding and cleanup
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxCleanupError, SandboxStartError, SandboxValidationError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '../src/index.js';
import type { DockerSandboxDataset } from '../src/index.js';
import { engineFixture, imageDigest, sandboxRequest } from './fixtures/engine.js';
import type { FixtureOptions } from './fixtures/engine.js';

const dataImage = `sha256:${'4'.repeat(64)}`;
const otherImage = `sha256:${'5'.repeat(64)}`;
const dataset = { name: 'reference', imageDigest: dataImage, subpath: 'inputs/v1' };
const imageMountAdvisory = 'Image mount is an experimental feature';
type Fixture = Awaited<ReturnType<typeof engineFixture>>;
type Container = NonNullable<ReturnType<Fixture['containers']['get']>>;

function config(endpoint = 'unix:///absent-dataset-engine.sock', spillDirectory = '/absent-dataset-spill') {
  return { endpoint, spillDirectory, namespace: 'unit-tests', imageDigest, user: { uid: 65534, gid: 65534 } };
}

async function datasetFixture(datasets: readonly DockerSandboxDataset[] = [dataset], options: FixtureOptions = {}) {
  return engineFixture({ ...options, datasets,
    containerWarnings: options.containerWarnings ?? ((role) => role === 'compute' ? datasets.map(() => imageMountAdvisory) : []),
    async handleRequest(input) {
    if (await options.handleRequest?.(input)) return true;
    if (input.path !== `/v1.52/images/${dataImage}/json` && input.path !== `/v1.52/images/${otherImage}/json`) return false;
    input.response.writeHead(200, { 'content-type': 'application/json' });
    input.response.end(JSON.stringify({ Id: input.path.includes(dataImage) ? dataImage : otherImage, Os: 'linux', Architecture: 'arm64',
      RootFS: { Type: 'layers' }, Config: { Volumes: { '/data-only': {} }, Env: ['DATA_ONLY=1'] } }));
    return true;
  } });
}

function imageHost(container: Container): object {
  const mounts = container.HostConfig.Mounts;
  assert(Array.isArray(mounts));
  const value: unknown = mounts.find((entry: unknown) => typeof entry === 'object' && entry !== null && Reflect.get(entry, 'Type') === 'image');
  assert(value !== null && typeof value === 'object');
  return value;
}

function imageEffective(container: Container): object {
  const value = container.Mounts.find((entry) => typeof entry === 'object' && entry !== null && Reflect.get(entry, 'Type') === 'image');
  assert(value !== null && typeof value === 'object');
  return value;
}

test('dataset capture is inert, canonical across ordering and insulated from later caller mutation', () => {
  const first = { ...dataset };
  const second = { name: 'workspace', imageDigest: otherImage };
  const backend = createDockerSandboxBackend({ ...config(), datasets: [second, first] });
  const expected = createDockerSandboxBackend({ ...config(), datasets: [first, second] }).reserve(sandboxRequest(), { kind: 'in_process' });
  first.subpath = 'retargeted'; second.name = 'changed';
  const owner = backend.reserve(sandboxRequest(), { kind: 'in_process' });
  assert.equal(owner.recoveryRecord.format, 'agenai.sandbox-recovery.v2');
  assert.equal(owner.recoveryRecord.backendRevision, 'engine-1.52-v4-linux-x64');
  assert.equal(owner.recoveryRecord.configurationDigest, expected.recoveryRecord.configurationDigest);
  assert.deepEqual(owner.state, { kind: 'reserved' });
  assert.deepEqual(owner.recoveryRecord.resources.map(({ role, identity }) => [role, identity.kind]),
    [['compute', 'planned'], ['storage', 'planned'], ['export', 'planned']]);
  const empty = createDockerSandboxBackend(config()).reserve(sandboxRequest(), { kind: 'in_process' });
  const explicitEmpty = createDockerSandboxBackend({ ...config(), datasets: [] }).reserve(sandboxRequest(), { kind: 'in_process' });
  assert.equal(empty.recoveryRecord.configurationDigest, explicitEmpty.recoveryRecord.configurationDigest);
});

test('dataset configuration rejects ambiguous names, escaping subpaths, arbitrary options and non-data arrays', () => {
  let getterReads = 0;
  const accessor = { name: 'reference', get imageDigest() { getterReads += 1; return dataImage; } };
  const sparse = new Array(1);
  const extra = Object.assign([dataset], { unexpected: true });
  for (const datasets of [
    [{ ...dataset, name: '../workspace' }], [{ ...dataset, name: 'Reference' }], [{ ...dataset, name: 'nested/path' }],
    [{ ...dataset, subpath: '' }], [{ ...dataset, subpath: '/absolute' }], [{ ...dataset, subpath: 'a/../b' }],
    [{ ...dataset, subpath: 'a//b' }], [{ ...dataset, subpath: 'a/' }], [{ ...dataset, subpath: './a' }],
    [{ ...dataset, imageDigest: 'dataset:latest' }], [{ ...dataset, target: '/workspace' }], [{ ...dataset, readOnly: false }],
    [dataset, dataset], [accessor], sparse, extra,
    Array.from({ length: 33 }, (_, index) => ({ ...dataset, name: `dataset-${index}` })),
  ]) assert.throws(() => Reflect.apply(createDockerSandboxBackend, undefined, [{ ...config(), datasets }]), SandboxValidationError);
  assert.equal(getterReads, 0);
});

test('only selected datasets require the admitted overlayfs containerd image store', async (t) => {
  for (const [name, selected, driver, containerd] of [
    ['baseline classic store', false, 'overlay2', false],
    ['baseline other snapshotter', false, 'stargz', true],
    ['selected classic store', true, 'overlay2', false],
    ['selected lazy snapshotter', true, 'stargz', true],
    ['selected unknown snapshotter', true, 'unqualified', true],
  ] as const) await t.test(name, async () => {
    const fixture = await datasetFixture(selected ? [dataset] : [], { async handleRequest({ path, response }) {
      if (path !== '/info') return false;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ID: 'classic-store', OSType: 'linux', Architecture: 'amd64', CgroupVersion: '2', CgroupDriver: 'systemd',
        Driver: driver, DriverStatus: containerd ? [['driver-type', 'io.containerd.snapshotter.v1']] : [['Backing Filesystem', 'extfs']],
        SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'],
        MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true }));
      return true;
    } });
    try {
      const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
      if (selected) {
        await assert.rejects(owner.start(), SandboxStartError);
        assert.deepEqual(fixture.effects, []);
        assert.equal(owner.recoveryRecord.authority.kind, 'unverified');
        await owner.destroy();
      } else {
        const sandbox = await owner.start();
        assert.deepEqual(sandbox.effective.workspaceDiskQuota, { kind: 'not_requested' });
        await sandbox.destroy();
        assert.equal(fixture.volumes.size, 0);
      }
    } finally { await fixture.close(); }
  });
});

test('missing, mismatched and non-Linux dataset images reject before native acquisition', async (t) => {
  for (const [name, status, value] of [
    ['missing', 404, {}], ['different identity', 200, { Id: otherImage, Os: 'linux', RootFS: { Type: 'layers' } }],
    ['Windows data', 200, { Id: dataImage, Os: 'windows', RootFS: { Type: 'layers' } }],
    ['non-filesystem image', 200, { Id: dataImage, Os: 'linux', RootFS: { Type: 'other' } }],
  ] as const) await t.test(name, async () => {
    const fixture = await datasetFixture([dataset], { async handleRequest({ path, response }) {
      if (path !== `/v1.52/images/${dataImage}/json`) return false;
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return true;
    } });
    try {
      const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
      await assert.rejects(owner.start(), SandboxStartError);
      assert.deepEqual(fixture.effects, []);
      assert.equal(owner.recoveryRecord.resources.every((resource) => resource.identity.kind === 'planned'), true);
      await owner.destroy();
    } finally { await fixture.close(); }
  });
});

test('dataset mounts require a stable Engine release containing the image-layer filename fix', async (t) => {
  for (const [name, selected, version, accepted] of [
    ['affected selected Engine', true, '29.1.3', false],
    ['older selected minor', true, '29.0.99', false],
    ['fixed minimum', true, '29.1.4', true],
    ['later stable minor', true, '29.2.0', true],
    ['later stable major', true, '30.0.0', true],
    ['selected missing version', true, undefined, false],
    ['selected unknown version', true, 'vendor-custom', false],
    ['selected prerelease', true, '29.1.4-rc.1', false],
    ['selected future prerelease', true, '30.0.0-rc.1', false],
    ['selected build suffix', true, '29.1.4+vendor.1', false],
    ['selected noncanonical version', true, '29.01.4', false],
    ['baseline affected version', false, '29.1.3', true],
    ['baseline unknown version', false, 'vendor-custom', true],
    ['baseline prerelease', false, '29.1.4-rc.1', true],
    ['baseline missing version', false, undefined, true],
  ] as const) await t.test(name, async () => {
    const fixture = await datasetFixture(selected ? [dataset] : [], { async handleRequest({ path, response }) {
      if (path !== '/version') return false;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Version: version, ApiVersion: '1.52', MinAPIVersion: '1.44', Os: 'linux', Arch: 'amd64' }));
      return true;
    } });
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    try {
      if (accepted) {
        const sandbox = await owner.start();
        assert.equal(sandbox.workspace, '/workspace/work');
        assert.equal(fixture.containers.size, 2);
      } else {
        await assert.rejects(owner.start(), SandboxStartError);
        assert.deepEqual(fixture.effects, []);
        assert.equal(owner.recoveryRecord.authority.kind, 'unverified');
      }
    } finally { await owner.destroy(); await fixture.close(); }
  });
});

test('only selected compute image mounts admit their exact Engine advisory without losing cleanup or mount readback', async (t) => {
  const repeated = (count: number) => Array.from({ length: count }, () => imageMountAdvisory);
  const cases: readonly {
    name: string; mounts: number; computeWarnings: readonly string[]; accessorWarnings?: readonly string[];
    networkWarning?: string; accepted: boolean;
  }[] = [
    { name: 'one image advisory', mounts: 1, computeWarnings: repeated(1), accepted: true },
    { name: 'all 32 image advisories', mounts: 32, computeWarnings: repeated(32), accepted: true },
    { name: 'future Engine without advisory', mounts: 1, computeWarnings: [], accepted: true },
    { name: 'unexpected policy warning', mounts: 1, computeWarnings: ['Memory limit discarded'], accepted: false },
    { name: 'mixed advisory and policy warning', mounts: 2, computeWarnings: [imageMountAdvisory, 'Memory limit discarded'], accepted: false },
    { name: 'too few advisories', mounts: 2, computeWarnings: repeated(1), accepted: false },
    { name: 'too many advisories', mounts: 1, computeWarnings: repeated(2), accepted: false },
    { name: 'advisory array exceeds attachment bound', mounts: 32, computeWarnings: repeated(33), accepted: false },
    { name: 'advisory without datasets', mounts: 0, computeWarnings: repeated(1), accepted: false },
    { name: 'accessor advisory', mounts: 1, computeWarnings: repeated(1), accessorWarnings: repeated(1), accepted: false },
    { name: 'network advisory', mounts: 1, computeWarnings: repeated(1), networkWarning: imageMountAdvisory, accepted: false },
  ];
  for (const row of cases) await t.test(row.name, async () => {
    const fixture = await datasetFixture(Array.from({ length: row.mounts }, (_, index) => ({ ...dataset, name: `dataset-${index}` })), {
      containerWarnings: (role) => role === 'compute' ? row.computeWarnings : row.accessorWarnings ?? [],
      networkWarning: row.networkWarning,
    });
    const owner = fixture.backend.reserve(sandboxRequest(row.networkWarning === undefined ? 'isolated' : 'outbound'), { kind: 'in_process' });
    try {
      if (row.accepted) {
        const sandbox = await owner.start();
        assert.equal(sandbox.workspace, '/workspace/work');
        assert.equal([...fixture.containers.values()].filter((container) => container.State.Running).length, 1);
        assert.equal([...fixture.containers.values()].find((container) => container.State.Running)?.Mounts.length, row.mounts + 1);
      } else {
        await assert.rejects(owner.start(), SandboxStartError);
        assert.equal(fixture.effects.some(({ path }) => path.endsWith('/start')), false);
        assert.equal(fixture.containers.size, row.networkWarning !== undefined ? 0 : row.accessorWarnings === undefined ? 1 : 2,
          'The warning rejection must reach its intended resource role.');
      }
    } finally {
      await owner.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
        { containers: 0, volumes: 0, networks: 0 });
      assert.equal(fixture.requests.some(({ method, path }) => method === 'DELETE' && path.startsWith('/v1.52/images/')), false);
      await fixture.close();
    }
  });
});

test('compute receives exact read-only image mounts while export retains only its private workspace', async () => {
  const fixture = await datasetFixture([{ name: 'zeta', imageDigest: otherImage }, dataset]);
  try {
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    const sandbox = await owner.start();
    const compute = [...fixture.containers.values()].find((value) => value.Name.endsWith('-compute'));
    const accessor = [...fixture.containers.values()].find((value) => value.Name.endsWith('-export'));
    assert(compute && accessor);
    const storage = owner.recoveryRecord.resources.find((resource) => resource.role === 'storage');
    assert(storage);
    assert.deepEqual(compute.HostConfig.Mounts, [
      { Type: 'volume', Source: storage.name, Target: '/workspace', ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'image', Source: dataImage, Target: '/datasets/reference', ReadOnly: true, ImageOptions: { Subpath: 'inputs/v1' } },
      { Type: 'image', Source: otherImage, Target: '/datasets/zeta', ReadOnly: true },
    ]);
    assert.deepEqual(accessor.HostConfig.Mounts,
      [{ Type: 'volume', Source: storage.name, Target: '/workspace', ReadOnly: true, VolumeOptions: { NoCopy: true } }]);
    assert.equal(accessor.Mounts.length, 1);
    assert.equal(compute.Mounts.length, 3);
    compute.Mounts.reverse();
    assert.equal((await fixture.backend.reconcile(owner.recoveryRecord)).kind, 'matched', 'Daemon map iteration order does not change mount identity.');
    await sandbox.stop();
    assert.equal(fixture.containers.size, 1);
    assert.equal(fixture.volumes.size, 1);
    await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
    assert.equal(fixture.requests.some(({ method, path }) => method !== 'GET' && path.startsWith('/v1.52/images/')), false);
  } finally { await fixture.close(); }
});

test('mount readback rejects changed identity, write access, options, targets and effective inventories', async (t) => {
  const changes: ReadonlyArray<readonly [string, (container: Container) => void]> = [
    ['image source', (container) => { Reflect.set(imageHost(container), 'Source', otherImage); }],
    ['writable request', (container) => { Reflect.set(imageHost(container), 'ReadOnly', false); }],
    ['image subpath', (container) => { Reflect.set(imageHost(container), 'ImageOptions', { Subpath: 'other' }); }],
    ['unexpected bind options', (container) => { Reflect.set(imageHost(container), 'BindOptions', { CreateMountpoint: true }); }],
    ['unexpected volume options', (container) => { Reflect.set(imageHost(container), 'VolumeOptions', { NoCopy: false }); }],
    ['requested target', (container) => { Reflect.set(imageHost(container), 'Target', '/workspace'); }],
    ['effective image identity', (container) => { Reflect.set(imageEffective(container), 'Name', otherImage); }],
    ['effective write access', (container) => { Reflect.set(imageEffective(container), 'RW', true); }],
    ['effective shared propagation', (container) => { Reflect.set(imageEffective(container), 'Propagation', 'rshared'); }],
    ['effective target', (container) => { Reflect.set(imageEffective(container), 'Destination', '/datasets/other'); }],
    ['wrong effective mount type', (container) => { Reflect.set(imageEffective(container), 'Type', 'bind'); }],
    ['missing effective mount', (container) => { container.Mounts.splice(1); }],
    ['extra effective mount', (container) => { container.Mounts.push({ Type: 'image', Name: dataImage, Source: '/extra', Destination: '/extra', RW: false }); }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    let changed = false;
    const fixture: Fixture = await datasetFixture([dataset], { async handleRequest({ path }) {
      const id = /^\/v1\.52\/containers\/([a-f0-9]{64})\/json$/u.exec(path)?.[1];
      const container = id === undefined ? undefined : fixture.containers.get(id);
      if (!changed && container?.Name.endsWith('-compute')) { changed = true; change(container); }
      return false;
    } });
    try {
      const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
      await assert.rejects(owner.start(), SandboxStartError);
      assert.equal(fixture.effects.some(({ path }) => path.endsWith('/start')), false);
      await owner.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
    } finally { await fixture.close(); }
  });
});

test('recovery rejects legacy records and every changed dataset or user configuration before Engine access', async () => {
  const fixture = await datasetFixture();
  try {
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    const reserved = owner.recoveryRecord;
    const sandbox = await owner.start();
    for (const record of [reserved, owner.recoveryRecord]) {
      const before = fixture.requests.length;
      for (const changed of [
        { datasets: [] }, { datasets: [{ ...dataset, name: 'different' }] }, { datasets: [{ ...dataset, imageDigest: otherImage }] },
        { datasets: [{ ...dataset, subpath: 'other' }] }, { datasets: [dataset], user: { uid: 1000, gid: 1000 } },
      ]) {
        const backend = createDockerSandboxBackend({ ...config(fixture.endpoint, fixture.spillDirectory), ...changed });
        assert.equal((await backend.reconcile(record)).kind, 'conflict');
      }
      assert.equal((await fixture.backend.reconcile(parseSandboxRecoveryRecord({ ...record, backendRevision: 'engine-1.52-v3-linux-x64' }))).kind, 'conflict');
      const { configurationDigest: _configuration, ...legacy } = record;
      await assert.rejects(Reflect.apply(fixture.backend.reconcile, fixture.backend, [{ ...legacy, format: 'agenai.sandbox-recovery.v1' }]), SandboxValidationError);
      assert.equal(fixture.requests.length, before);
    }
    await sandbox.destroy();
  } finally { await fixture.close(); }
});

test('cleanup and recovery retain retry ownership without requiring or deleting borrowed images', async () => {
  let imageAvailable = true;
  let datasetInspections = 0;
  const fixture = await datasetFixture([dataset], { failDeleteVolumeOnce: true, async handleRequest({ path, response }) {
    if (path !== `/v1.52/images/${dataImage}/json`) return false;
    datasetInspections += 1;
    if (imageAvailable) return false;
    response.writeHead(404, { 'content-type': 'application/json' }); response.end('{}'); return true;
  } });
  try {
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    const sandbox = await owner.start();
    assert.equal(datasetInspections, 1);
    imageAvailable = false;
    const recovered = await fixture.backend.reconcile(owner.recoveryRecord);
    assert.equal(recovered.kind, 'matched');
    if (recovered.kind !== 'matched') throw new Error('Expected exact cleanup ownership.');
    await recovered.owner.stop();
    await assert.rejects(recovered.owner.destroy(), SandboxCleanupError);
    assert.equal(fixture.volumes.size, 1);
    await recovered.owner.destroy();
    await sandbox.destroy();
    assert.equal(datasetInspections, 1, 'Destruction does not need an image lookup or mount acquisition.');
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
    assert.equal(fixture.requests.some(({ method, path }) => method === 'DELETE' && path.startsWith('/v1.52/images/')), false);
  } finally { await fixture.close(); }
});
