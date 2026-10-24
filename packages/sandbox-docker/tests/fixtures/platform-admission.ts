// ------------------------------------------------------------------------------------------------
//                platform-admission.ts - Isolated process identities; no native platform claims
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxCleanupError, SandboxStartError, SandboxUnsupportedError, SandboxValidationError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '../../src/index.js';
import type { DockerSandboxProfile } from '../../src/index.js';
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
    assert.equal(owner.recoveryRecord.backendRevision, `engine-1.52-v4-${profile}`);
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
      const stale = parseSandboxRecoveryRecord({ ...record, backendRevision: 'engine-1.52-v2' });
      assert.equal((await fixture.backend.reconcile(stale)).kind, 'conflict');
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
      assert.equal(owner.recoveryRecord.backendRevision, 'engine-1.52-v4-linux-x64');
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
