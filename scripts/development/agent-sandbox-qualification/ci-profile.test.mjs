// ------------------------------------------------------------------------------------------------
//                ci-profile.test.mjs - Runtime admission and credential boundary behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialFreeEnvironment, qualifiedDatasetEngine, verifyProfile } from './ci-profile.mjs';

const host = { node: '24.18.0', platform: 'linux', arch: 'x64' };
const version = { Version: '29.1.3', ApiVersion: '1.52', Os: 'linux', Arch: 'amd64', Components: [{ Name: 'runc', Version: '1.4.0' }] };
const info = { ID: 'test-daemon', OSType: 'linux', Architecture: 'x86_64', CgroupVersion: '2', CgroupDriver: 'systemd',
  MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true,
  SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'] };

test('profile admission records the actual runtime components while excluding daemon proxy credentials', () => {
  assert.deepEqual(verifyProfile(version, { ...info, HTTPProxy: 'http://user:secret@proxy.invalid' }, host), { node: '24.18.0', version, info });
  for (const changed of [{ Version: '29.1.4' }, { ApiVersion: '1.53' }, { Os: 'windows' }, { Arch: 'arm64' }]) {
    assert.throws(() => verifyProfile({ ...version, ...changed }, info, host));
  }
  for (const changed of [{ CgroupVersion: '1' }, { CgroupDriver: 'cgroupfs' }, { SwapLimit: false },
    { SecurityOptions: ['name=apparmor', 'name=seccomp,profile=unconfined', 'name=cgroupns'] },
    { SecurityOptions: [...info.SecurityOptions, 'name=rootless'] },
    { SecurityOptions: info.SecurityOptions.filter((value) => value !== 'name=apparmor') }]) {
    assert.throws(() => verifyProfile(version, { ...info, ...changed }, host));
  }
  assert.throws(() => verifyProfile(version, info, { ...host, node: '24.17.0' }));
  assert.equal(verifyProfile({ ...version, Version: qualifiedDatasetEngine }, info, host, qualifiedDatasetEngine).version.Version, '29.1.4');
  assert.throws(() => verifyProfile(version, info, host, qualifiedDatasetEngine), /requires Engine 29.1.4/u);
});

test('child environment drops model keys, ambient engine overrides and Node hooks, using an empty owned Docker configuration', () => {
  assert.deepEqual(credentialFreeEnvironment({ PATH: '/tools', HOME: '/home/runner', CI: 'true', OPENAI_API_KEY: 'secret',
    ANTHROPIC_API_KEY: 'secret', DOCKER_HOST: 'tcp://elsewhere', DOCKER_CONFIG: '/credentials', NODE_OPTIONS: '--import malicious',
    GITHUB_TOKEN: 'secret', KEEP_ME: 'secret' }, '/owned/docker-config'),
  { PATH: '/tools', HOME: '/home/runner', CI: 'true', DOCKER_CONFIG: '/owned/docker-config' });
});
