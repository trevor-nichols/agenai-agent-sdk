// ------------------------------------------------------------------------------------------------
//                platform-admission.ts - Isolated process identities; no native platform claims
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxCleanupError, SandboxStartError, SandboxUnsupportedError, SandboxValidationError, fileFromBytes, parseSandboxRecoveryRecord, parseSandboxRequest } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '../../src/index.js';
import type { DockerSandboxProfile } from '../../src/index.js';
import { createDockerDesktopRouteAuthority } from '../../src/node/index.js';
import { desktopRouteAuthorityOptions } from './desktopRouteAuthority.js';
import { desktopResourcesFixture } from './desktopResources.js';
import { filesystemConfiguration, filesystemFixture } from './filesystem.js';
import { engineFixture, imageDigest, sandboxRequest } from './engine.js';

function controller(platform: string, architecture: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: architecture, configurable: true });
}

function backendConfig(profile: DockerSandboxProfile, endpoint = 'unix:///absent-agenai-platform-engine.sock', spillDirectory = '/absent-agenai-platform-spill') {
  return { profile, endpoint, spillDirectory, namespace: 'unit-tests', imageDigest, user: { uid: 65534, gid: 65534 } };
}

function responses(profile: DockerSandboxProfile) {
  return {
    version: { ApiVersion: '1.52', MinAPIVersion: '1.44', Os: 'linux', Arch: 'arm64' },
    info: { ID: 'desktop-daemon-unit', OSType: 'linux', Architecture: 'aarch64', OperatingSystem: 'Docker Desktop', Name: 'caller-assigned-hostname',
      CgroupVersion: '2', CgroupDriver: 'cgroupfs', SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
      MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true },
    image: { Id: imageDigest, Os: 'linux', Architecture: profile === 'desktop-apple-virtualization-native-arm64' ? 'arm64' : 'amd64', Config: { Volumes: null } },
  };
}

test('Desktop restricted reservations bind their owned observer and nine-role recovery before effects', () => {
  for (const profile of ['desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64'] as const) {
    const endpoint = 'unix:///absent-desktop-engine.sock';
    const routeAuthority = createDockerDesktopRouteAuthority(desktopRouteAuthorityOptions(profile, endpoint));
    const backend = createDockerSandboxBackend({ ...backendConfig(profile, endpoint), filesystem: filesystemConfiguration(),
      egress: { imageDigest: `sha256:${'e'.repeat(64)}`, protocol: 'agenai.sandbox.egress-connect.v1', user: { uid: 65534, gid: 65534 },
        broker: { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 },
        relay: { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 },
        routeAuthority, control: { heartbeatMs: 100, leaseTimeoutMs: 60_000 } } });
    const owner = backend.reserve(parseSandboxRequest({ policy: { ...sandboxRequest({ kind: 'restricted_https',
      destinations: [{ hostname: 'api.example.com', port: 443 }] }).policy, files: { kind: 'read_write' } } }), { kind: 'in_process' });
    assert.deepEqual(owner.state, { kind: 'reserved' });
    assert.equal(owner.recoveryRecord.backendRevision, `engine-1.52-v6-${profile}`);
    assert.deepEqual(owner.recoveryRecord.authority, { kind: 'unverified' });
    assert.deepEqual(owner.recoveryRecord.resources.map(({ role, identity }) => [role, identity.kind]), [
      ['compute', 'planned'], ['storage', 'planned'], ['export', 'planned'], ['network', 'planned'],
      ['egress_socket', 'planned'], ['egress_broker', 'planned'], ['egress_relay', 'planned'],
      ['filesystem', 'planned'], ['route_observer', 'planned'],
    ]);
    assert.deepEqual(parseSandboxRecoveryRecord(owner.recoveryRecord), owner.recoveryRecord);
  }
});

async function desktopFixture(profile: DockerSandboxProfile, change: (data: ReturnType<typeof responses>) => void = () => {}, appArmorProfile = '') {
  const data = responses(profile);
  change(data);
  const fixture = await engineFixture({ profile, runningAppArmorProfile: appArmorProfile, async handleRequest({ path, response }) {
    const value = path === '/version' ? data.version : path === '/info' ? data.info : path === `/v1.52/images/${imageDigest}/json` ? data.image : undefined;
    if (value === undefined) return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
    return true;
  } });
  return { ...fixture, data };
}

test('construction is inert for all profiles and rejects unrecognized platform choices', () => {
  const profiles: DockerSandboxProfile[] = ['linux-x64', 'desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64'];
  for (const profile of profiles) {
    const owner = createDockerSandboxBackend(backendConfig(profile)).reserve(sandboxRequest(), { kind: 'in_process' });
    assert.deepEqual(owner.state, { kind: 'reserved' });
    assert.equal(owner.recoveryRecord.backendRevision, `engine-1.52-v${profile === 'linux-x64' ? 5 : 6}-${profile}`);
    assert.deepEqual(owner.recoveryRecord.authority, { kind: 'unverified' });
  }
  for (const profile of ['linux-arm64', 'desktop', 'desktop-docker-vmm-arm64', 'desktop-apple-virtualization-amd64', null]) {
    assert.throws(() => Reflect.apply(createDockerSandboxBackend, undefined, [{ ...backendConfig('linux-x64'), profile }]), SandboxValidationError);
  }
  assert.throws(() => Reflect.apply(createDockerSandboxBackend, undefined, [{ ...backendConfig('linux-x64'), architecture: 'arm64' }]), SandboxValidationError);
});

test('wrong controllers reject before filesystem or Engine admission, including cleanup-only recovery', async () => {
  for (const [platform, architecture, profile] of [
    ['linux', 'x64', 'desktop-apple-virtualization-native-arm64'],
    ['linux', 'x64', 'desktop-apple-virtualization-rosetta-amd64'],
    ['darwin', 'x64', 'desktop-apple-virtualization-native-arm64'],
    ['darwin', 'arm64', 'linux-x64'],
    ['linux', 'arm64', 'linux-x64'],
    ['win32', 'x64', 'linux-x64'],
  ] satisfies Array<[string, string, DockerSandboxProfile]>) {
    controller(platform, architecture);
    const backend = createDockerSandboxBackend(backendConfig(profile));
    const owner = backend.reserve(sandboxRequest(), { kind: 'in_process' });
    await assert.rejects(owner.start(), (error: unknown) => {
      assert.ok(error instanceof SandboxStartError);
      assert.ok(error.cause instanceof SandboxUnsupportedError);
      assert.match(error.cause.message, /controller/u);
      return true;
    });
    assert.equal(owner.recoveryRecord.resources.every((resource) => resource.identity.kind === 'planned'), true);
    await assert.rejects(backend.reconcile(owner.recoveryRecord), SandboxUnsupportedError);
  }
});

test('Desktop observer image provenance and fixed launch reject before creating any owned resource', async () => {
  controller('darwin', 'arm64');
  for (const mismatch of ['id', 'os', 'architecture', 'user', 'environment', 'entrypoint', 'command', 'working-directory',
    'protocol', 'observation', 'source', 'user-label'] as const) {
    const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64');
    try {
      const image = fixture.observerImage;
      if (mismatch === 'id') image.Id = `sha256:${'f'.repeat(64)}`;
      if (mismatch === 'os') image.Os = 'windows';
      if (mismatch === 'architecture') image.Architecture = 'amd64';
      if (mismatch === 'user') image.Config.User = '0:0';
      if (mismatch === 'environment') image.Config.Env.push('UNOWNED=1');
      if (mismatch === 'entrypoint') image.Config.Entrypoint = ['/bin/sh'];
      if (mismatch === 'command') image.Config.Cmd = ['unowned'];
      if (mismatch === 'working-directory') image.Config.WorkingDir = '/tmp';
      if (mismatch === 'protocol') image.Config.Labels['ai.agen.sandbox.desktop-route.protocol'] = 'other';
      if (mismatch === 'observation') image.Config.Labels['ai.agen.sandbox.desktop-route.observation'] = 'other';
      if (mismatch === 'source') image.Config.Labels['ai.agen.sandbox.desktop-route.source'] = `sha256:${'f'.repeat(64)}`;
      if (mismatch === 'user-label') image.Config.Labels['ai.agen.sandbox.desktop-route.user'] = '0:0';
      const owner = fixture.backend().reserve(sandboxRequest({ kind: 'restricted_https',
        destinations: [{ hostname: 'api.example.com', port: 443 }] }), { kind: 'in_process' });
      await assert.rejects(owner.start(), (error: unknown) => error instanceof SandboxStartError
        && error.cause instanceof SandboxUnsupportedError && /Prepared Desktop observer image/u.test(error.cause.message), mismatch);
      assert.deepEqual(fixture.effects, [], mismatch);
      await owner.destroy();
    } finally { await fixture.close(); }
  }
});

test('both Desktop profiles reject unavailable host observation and a different daemon before owned effects', async () => {
  controller('darwin', 'arm64');
  for (const profile of ['desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64'] as const) {
    const fixture = await desktopResourcesFixture(profile);
    try {
      for (const daemonId of ['different-daemon', 'daemon-unit-1']) {
        fixture.setDaemonId(daemonId);
        const owner = fixture.backend().reserve(sandboxRequest({ kind: 'restricted_https',
          destinations: [{ hostname: 'api.example.com', port: 443 }] }), { kind: 'in_process' });
        await assert.rejects(owner.start(), SandboxStartError);
        assert.deepEqual(fixture.effects, []);
        assert.equal(owner.recoveryRecord.authority.kind, 'unverified');
        await owner.destroy();
      }
    } finally { await fixture.close(); }
  }
});

for (const profile of ['desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64'] as const) {
  test(`${profile} admits its exact synthetic workload and retains ordinary resource enforcement`, async () => {
    controller('darwin', 'arm64');
    const fixture = await desktopFixture(profile);
    try {
      const owner = fixture.backend.reserve(sandboxRequest('outbound'), { kind: 'in_process' });
      const sandbox = await owner.start();
      assert.equal(sandbox.effective.isolation, 'container');
      assert.deepEqual(sandbox.effective.workspaceDiskQuota, { kind: 'not_requested' });
      const compute = [...fixture.containers.values()].find((value) => value.State.Running);
      assert.ok(compute);
      assert.equal(compute.AppArmorProfile, '');
      assert.equal(compute.Config.User, '65534:65534');
      const creates = fixture.requests.filter((request) => request.path === '/v1.52/containers/create');
      assert.equal(creates.length, 2);
      for (const request of creates) {
        assert.equal(new URL(request.target, 'http://fixture.invalid').searchParams.get('platform'),
          profile === 'desktop-apple-virtualization-native-arm64' ? 'linux/arm64' : 'linux/amd64');
      }
      assert.deepEqual({ readonly: compute.HostConfig.ReadonlyRootfs, caps: compute.HostConfig.CapDrop,
        security: compute.HostConfig.SecurityOpt, pid: compute.HostConfig.PidMode, ipc: compute.HostConfig.IpcMode,
        cgroup: compute.HostConfig.CgroupnsMode, cpu: compute.HostConfig.NanoCpus, memory: compute.HostConfig.Memory,
        swap: compute.HostConfig.MemorySwap, pids: compute.HostConfig.PidsLimit }, {
        readonly: true, caps: ['ALL'], security: ['no-new-privileges:true'], pid: '', ipc: 'private', cgroup: 'private',
        cpu: 500_000_000, memory: 67_108_864, swap: 67_108_864, pids: 32,
      });
      const reconciliation = await fixture.backend.reconcile(owner.recoveryRecord);
      assert.equal(reconciliation.kind, 'matched');
      if (reconciliation.kind !== 'matched') throw new Error('Expected cleanup recovery.');
      await reconciliation.owner.stop();
      assert.equal(fixture.containers.size, 1);
      assert.equal(fixture.volumes.size, 1);
      await reconciliation.owner.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size }, { containers: 0, volumes: 0, networks: 0 });
      await sandbox.destroy();
    } finally { await fixture.close(); }
  });

  for (const layout of ['baseline', 'private_live'] as const) {
    test(`${profile} public preserving transfers round-trip ${layout} content and enforce actual empty admission`, async () => {
      controller('darwin', 'arm64');
      const fixture = layout === 'private_live' ? await filesystemFixture({ profile }) : await engineFixture({ profile });
      const request = parseSandboxRequest({ policy: { ...sandboxRequest().policy,
        files: { kind: layout === 'private_live' ? 'read_write' : 'disabled' } } });
      const owner = fixture.backend.reserve(request, { kind: 'in_process' });
      const emptyChecks = () => fixture.requests.filter(({ method, path, target }) => method === 'GET' && path.endsWith('/archive')
        && new URL(target, 'http://fixture.invalid').searchParams.get('path') === '/workspace/work').length;
      try {
        const sandbox = await owner.start();
        const imported = await sandbox.importTree([
          { kind: 'symlink', path: 'aliases/current', target: '../bin/./run' },
          fileFromBytes('bin/run', Uint8Array.of(0, 255, 10), { executable: true }),
          fileFromBytes('zero', new Uint8Array()),
          { kind: 'directory', path: 'empty' },
        ], { symlinks: 'preserve_internal' });
        assert.equal(imported.files, 2n); assert.equal(imported.directories, 1n);
        assert.equal(imported.symlinks, 1n); assert.equal(imported.payloadBytes, 3n);
        assert.equal(emptyChecks(), 1);
        assert.deepEqual(fixture.tree.get('/workspace/work/bin/run')?.bytes, Buffer.from([0, 255, 10]));
        assert.equal(fixture.tree.get('/workspace/work/bin/run')?.header.mode, 0o700);
        assert.equal(fixture.tree.get('/workspace/work/aliases/current')?.header.linkname, '../bin/./run');
        const uploads = fixture.uploadedArchives.length;
        let sourceEntered = false;
        async function* source() {
          sourceEntered = true;
          yield { kind: 'symlink' as const, path: 'another', target: 'bin/run' };
        }
        await assert.rejects(sandbox.importTree(source(), { symlinks: 'preserve_internal' }), /actually empty workspace/u);
        assert.equal(emptyChecks(), 2);
        assert.equal(sourceEntered, false);
        assert.equal(fixture.uploadedArchives.length, uploads);
        await sandbox.stop();
        const files: Array<{ path: string; executable: boolean; bytes: number[] }> = [];
        const links: Array<{ path: string; target: string }> = [];
        const exported = await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
          if (entry.kind === 'symlink') links.push({ path: entry.path, target: entry.target });
          if (entry.kind === 'file') {
            const parts: Uint8Array[] = [];
            for await (const part of entry.bytes) parts.push(part);
            files.push({ path: entry.path, executable: entry.executable, bytes: [...Buffer.concat(parts)] });
          }
        }, { symlinks: 'preserve_internal' });
        assert.deepEqual(files, [{ path: 'bin/run', executable: true, bytes: [0, 255, 10] }, { path: 'zero', executable: false, bytes: [] }]);
        assert.deepEqual(links, [{ path: 'aliases/current', target: '../bin/./run' }]);
        assert.equal(exported.files, 2n); assert.equal(exported.directories, 3n);
        assert.equal(exported.symlinks, 1n); assert.equal(exported.payloadBytes, 3n);
        const archiveGets = fixture.requests.filter(({ method, path }) => method === 'GET' && path.endsWith('/archive'));
        assert.equal(new URL(archiveGets.at(-1)?.target ?? '', 'http://fixture.invalid').searchParams.get('path'),
          layout === 'private_live' ? '/workspace/work' : '/workspace');
        const before = fixture.requests.length;
        await assert.rejects(sandbox.exportTree({ kind: 'files', paths: ['aliases/current'] },
          async () => assert.fail('Exact-file export followed a preserved link.'), { symlinks: 'preserve_internal' }), /symlink/u);
        assert.deepEqual(fixture.requests.slice(before).filter(({ method, path }) => method === 'GET' && path.endsWith('/archive')), []);
        await sandbox.destroy();
        assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
      } finally { await owner.destroy(); await fixture.close(); }
    });
  }
}

test('Desktop controls, identity and daemon/image architectures each fail closed before acquisition', async () => {
  controller('darwin', 'arm64');
  const failures: Array<[string, (data: ReturnType<typeof responses>) => void]> = [
    ['daemon OS', (data) => { data.version.Os = 'windows'; }],
    ['version architecture', (data) => { data.version.Arch = 'amd64'; }],
    ['info architecture', (data) => { data.info.Architecture = 'x86_64'; }],
    ['Desktop identity', (data) => { data.info.OperatingSystem = 'Linux'; }],
    ['cgroup version', (data) => { data.info.CgroupVersion = '1'; }],
    ['cgroup driver', (data) => { data.info.CgroupDriver = 'systemd'; }],
    ['memory controller', (data) => { data.info.MemoryLimit = false; }],
    ['swap controller', (data) => { data.info.SwapLimit = false; }],
    ['PID controller', (data) => { data.info.PidsLimit = false; }],
    ['CPU period controller', (data) => { data.info.CpuCfsPeriod = false; }],
    ['CPU quota controller', (data) => { data.info.CpuCfsQuota = false; }],
    ['AppArmor mismatch', (data) => { data.info.SecurityOptions.push('name=apparmor'); }],
    ['rootless', (data) => { data.info.SecurityOptions.push('name=rootless'); }],
    ['user namespaces', (data) => { data.info.SecurityOptions.push('name=userns'); }],
    ['missing seccomp', (data) => { data.info.SecurityOptions = ['name=cgroupns']; }],
    ['seccomp prefix lookalike', (data) => { data.info.SecurityOptions = ['name=seccomp,profile=builtin-disabled', 'name=cgroupns']; }],
    ['missing cgroup namespace', (data) => { data.info.SecurityOptions = ['name=seccomp,profile=builtin']; }],
    ['API version', (data) => { data.version.ApiVersion = '1.51'; }],
    ['native image architecture', (data) => { data.image.Architecture = 'amd64'; }],
    ['image OS', (data) => { data.image.Os = 'windows'; }],
  ];
  for (const [name, change] of failures) {
    const fixture = await desktopFixture('desktop-apple-virtualization-native-arm64', change);
    try {
      const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
      await assert.rejects(owner.start(), (error: unknown) => error instanceof SandboxStartError && error.cause instanceof SandboxUnsupportedError, name);
      assert.deepEqual(fixture.effects, [], name);
      assert.equal(owner.recoveryRecord.authority.kind, 'unverified', name);
      await owner.destroy();
    } finally { await fixture.close(); }
  }
  const fixture = await desktopFixture('desktop-apple-virtualization-rosetta-amd64', (data) => { data.image.Architecture = 'arm64'; });
  try {
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    await assert.rejects(owner.start(), SandboxStartError);
    assert.deepEqual(fixture.effects, []);
    await owner.destroy();
  } finally { await fixture.close(); }
});

test('Desktop running AppArmor mismatch retains cleanup and never yields a ready sandbox', async () => {
  controller('darwin', 'arm64');
  const fixture = await desktopFixture('desktop-apple-virtualization-native-arm64', undefined, 'docker-default');
  try {
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    await assert.rejects(owner.start(), SandboxStartError);
    assert.equal([...fixture.containers.values()].some((container) => container.State.Running), true);
    await owner.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { await fixture.close(); }
});

test('reserved and verified records bind the exact selected profile and reject stale revisions without Engine access', async () => {
  controller('darwin', 'arm64');
  const fixture = await desktopFixture('desktop-apple-virtualization-native-arm64');
  try {
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    const reserved = owner.recoveryRecord;
    const other = createDockerSandboxBackend(backendConfig('desktop-apple-virtualization-rosetta-amd64', fixture.endpoint, fixture.spillDirectory));
    const otherRecord = other.reserve(sandboxRequest(), { kind: 'in_process' }).recoveryRecord;
    assert.notEqual(reserved.configurationDigest, otherRecord.configurationDigest);
    assert.equal(reserved.policyDigest, otherRecord.policyDigest);
    const sandbox = await owner.start();
    const before = fixture.requests.length;
    for (const record of [reserved, owner.recoveryRecord]) {
      assert.equal((await other.reconcile(record)).kind, 'conflict');
      for (const backendRevision of ['engine-1.52-v2', 'engine-1.52-v5-desktop-apple-virtualization-native-arm64']) {
        const stale = parseSandboxRecoveryRecord({ ...record, backendRevision });
        assert.equal((await fixture.backend.reconcile(stale)).kind, 'conflict');
      }
    }
    assert.equal(fixture.requests.length, before);
    fixture.data.info.OperatingSystem = 'Other Linux';
    await assert.rejects(fixture.backend.reconcile(owner.recoveryRecord), SandboxUnsupportedError);
    const effects = fixture.effects.length;
    await assert.rejects(sandbox.destroy(), SandboxCleanupError);
    assert.equal(fixture.effects.length, effects);
    fixture.data.info.OperatingSystem = 'Docker Desktop';
    await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { await fixture.close(); }
});

test('the default Linux profile retains AppArmor and refuses a Desktop daemon identity', async () => {
  controller('linux', 'x64');
  for (const desktop of [false, true]) {
    const fixture = await engineFixture({ async handleRequest({ path, response }) {
      if (!desktop || path !== '/info') return false;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ID: 'desktop-with-linux-lookalike-controls', OSType: 'linux', Architecture: 'x86_64', OperatingSystem: 'Docker Desktop',
        CgroupVersion: '2', CgroupDriver: 'systemd', SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'],
        MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true }));
      return true;
    } });
    try {
      const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
      assert.equal(owner.recoveryRecord.backendRevision, 'engine-1.52-v5-linux-x64');
      if (desktop) {
        await assert.rejects(owner.start(), SandboxStartError);
        assert.deepEqual(fixture.effects, []);
        await owner.destroy();
      } else {
        const sandbox = await owner.start();
        assert.equal([...fixture.containers.values()].find((container) => container.State.Running)?.AppArmorProfile, 'docker-default');
        await sandbox.destroy();
        assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
      }
    } finally { await fixture.close(); }
  }
});

for (const [profile, platform, architecture, helperPlatform, workloadPlatform] of [
  ['linux-x64', 'linux', 'x64', 'linux/amd64', 'linux/amd64'],
  ['desktop-apple-virtualization-native-arm64', 'darwin', 'arm64', 'linux/arm64', 'linux/arm64'],
  ['desktop-apple-virtualization-rosetta-amd64', 'darwin', 'arm64', 'linux/arm64', 'linux/amd64'],
] satisfies Array<[DockerSandboxProfile, string, string, string, string]>) {
  test(`${profile} disabled live files acquire no helper and missing configuration rejects grants`, async () => {
    controller(platform, architecture);
    const fixture = await filesystemFixture({ profile });
    try {
      const unconfigured = createDockerSandboxBackend(backendConfig(profile, fixture.endpoint, fixture.spillDirectory));
      for (const kind of ['read_only', 'read_write'] as const) {
        const request = parseSandboxRequest({ policy: { ...sandboxRequest().policy, files: { kind } } });
        assert.throws(() => unconfigured.reserve(request, { kind: 'in_process' }), SandboxUnsupportedError);
      }
      assert.deepEqual(fixture.requests, []);
      const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
      try {
        const sandbox = await owner.start();
        assert.deepEqual(sandbox.files, { kind: 'disabled' });
        assert.deepEqual(owner.recoveryRecord.resources.map(({ role }) => role), ['compute', 'storage', 'export']);
        assert.deepEqual([...fixture.containers.values()].map(({ Image }) => Image), [imageDigest, imageDigest]);
        assert.equal(fixture.requests.some(({ path }) => path === `/v1.52/images/${fixture.filesystem.imageDigest}/json`), false);
        await sandbox.destroy();
        assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
      } finally { await owner.destroy(); }
    } finally { await fixture.close(); }
  });

  for (const kind of ['read_only', 'read_write'] as const) {
    test(`${profile} public live grants admit ${kind} operations with the native helper architecture`, async () => {
      controller(platform, architecture);
      const fixture = await filesystemFixture({ profile });
      try {
        const request = parseSandboxRequest({ policy: { ...sandboxRequest().policy, files: { kind } } });
        const owner = fixture.backend.reserve(request, { kind: 'in_process' });
        try {
          const sandbox = await owner.start();
          assert.deepEqual(sandbox.effective.files, { kind });
          assert.equal(sandbox.files.kind, kind);
          const creates = fixture.requests.filter(({ path }) => path === '/v1.52/containers/create');
          assert.deepEqual(creates.map(({ target }) => new URL(target, 'http://fixture.invalid').searchParams.get('platform')),
            [helperPlatform, workloadPlatform, workloadPlatform]);
          const helper = [...fixture.containers.values()].find((value) => value.Name.endsWith('-filesystem'));
          assert(helper);
          assert.equal(helper.Image, fixture.filesystem.imageDigest);
          assert.deepEqual(helper.Config.Entrypoint, ['/usr/local/bin/agenai-sandbox-files']);
          assert.equal(helper.Config.User, '65534:65534');
          assert.equal(helper.State.Running, true);
          assert.equal(helper.HostConfig.NetworkMode, 'none');
          const mounts = helper.HostConfig.Mounts;
          assert(Array.isArray(mounts));
          assert.deepEqual(mounts.map((mount) => ({ target: mount.Target, readOnly: mount.ReadOnly })),
            [{ target: '/store', readOnly: kind === 'read_only' }]);
          const initial = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
          await sandbox.importTree([fileFromBytes('program.bin', initial, { executable: true }),
            fileFromBytes('\uFEFFprogram.bin', Uint8Array.of(1)), fileFromBytes('\uFEFF', Uint8Array.of(2))]);
          assert.deepEqual(await sandbox.files.stat('program.bin'), { kind: 'completed', entry: {
            path: 'program.bin', kind: 'file', byteLength: 4, permissions: 0o700 } });
          const listed: string[] = [];
          assert.deepEqual(await sandbox.files.list('.', async (entry) => { listed.push(entry.path); }), { kind: 'completed', entries: 3n });
          assert.deepEqual(listed.sort(), ['program.bin', '\uFEFF', '\uFEFFprogram.bin']);
          const observed: Buffer[] = [];
          assert.deepEqual(await sandbox.files.readFile('program.bin', async ({ chunks }) => {
            for await (const part of chunks) observed.push(Buffer.from(part));
          }), { kind: 'completed', bytes: 4n });
          assert.deepEqual(Buffer.concat(observed), initial);
          if (sandbox.files.kind === 'read_write') {
            assert.deepEqual(await sandbox.files.writeFile('program.bin', [Buffer.from('replacement')], { mode: 'replace' }),
              { kind: 'completed', effect: 'published', bytes: 11n, permissions: 0o700 });
            const replaced: Buffer[] = [];
            assert.deepEqual(await sandbox.files.readFile('program.bin', async ({ chunks }) => {
              for await (const part of chunks) replaced.push(Buffer.from(part));
            }), { kind: 'completed', bytes: 11n });
            assert.equal(Buffer.concat(replaced).toString(), 'replacement');
          } else {
            assert.equal('writeFile' in sandbox.files, false);
          }
          await sandbox.destroy();
          assert.equal(owner.recoveryRecord.phase, 'destroyed');
          assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
        } finally { await owner.destroy(); }
      } finally { await fixture.close(); }
    });
  }
}
