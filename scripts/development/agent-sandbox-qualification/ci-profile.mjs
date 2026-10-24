// ------------------------------------------------------------------------------------------------
//                ci-profile.mjs - Explicit integration profile and credential-free child environment
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';

export const qualifiedNode = '24.18.0';
export const qualifiedEngine = '29.1.3';
export const qualifiedDatasetEngine = '29.1.4';
export const sourceImage = 'node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6';

export function verifyProfile(version, info, host = { node: process.versions.node, platform: process.platform, arch: process.arch }, expectedEngine = qualifiedEngine) {
  assert.equal(host.node, qualifiedNode, 'Sandbox integration requires qualified Node 24.18.0.');
  assert.equal(host.platform, 'linux');
  assert.equal(host.arch, 'x64');
  assert.equal(version.Version, expectedEngine, `Sandbox integration requires Engine ${expectedEngine}.`);
  assert.equal(version.ApiVersion, '1.52');
  assert.equal(version.Os, 'linux');
  assert.equal(version.Arch, 'amd64');
  assert.equal(info.OSType, 'linux');
  assert(['x86_64', 'amd64'].includes(info.Architecture));
  assert.equal(info.CgroupVersion, '2');
  assert.equal(info.CgroupDriver, 'systemd');
  for (const controller of ['MemoryLimit', 'SwapLimit', 'PidsLimit', 'CpuCfsPeriod', 'CpuCfsQuota']) assert.equal(info[controller], true, `${controller} is required.`);
  assert(Array.isArray(info.SecurityOptions));
  assert(!info.SecurityOptions.some((value) => /rootless|userns/iu.test(value)));
  assert(info.SecurityOptions.includes('name=apparmor'));
  assert(info.SecurityOptions.includes('name=cgroupns'));
  assert(info.SecurityOptions.includes('name=seccomp,profile=builtin'));
  assert(typeof info.ID === 'string' && info.ID.length > 0);
  const fields = ['ID', 'OSType', 'Architecture', 'CgroupVersion', 'CgroupDriver', 'SecurityOptions',
    'MemoryLimit', 'SwapLimit', 'PidsLimit', 'CpuCfsPeriod', 'CpuCfsQuota', 'Driver', 'DriverStatus', 'KernelVersion', 'OperatingSystem'];
  return { node: host.node,
    version: Object.fromEntries(['Version', 'ApiVersion', 'MinAPIVersion', 'Os', 'Arch', 'KernelVersion', 'Components']
      .filter((key) => version[key] !== undefined).map((key) => [key, version[key]])),
    info: Object.fromEntries(fields.filter((key) => info[key] !== undefined).map((key) => [key, info[key]])) };
}

export function credentialFreeEnvironment(environment, dockerConfig) {
  return { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PNPM_HOME', 'CI', 'LANG', 'LC_ALL', 'XDG_CACHE_HOME', 'LD_LIBRARY_PATH']
    .filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]])), DOCKER_CONFIG: dockerConfig };
}
