// ------------------------------------------------------------------------------------------------
//                configuration.mjs - Explicit platform qualification inputs and observed tuple checks
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { absolutePath, boundedFile, harnessSha256 } from '../native/configuration.mjs';

export const usage = `Usage:
  node scripts/development/agent-sandbox-qualification/platform/run.mjs --row core|datasets|observer|grok-initialize --manifest /absolute/platform.json --consumer /absolute/current/consumer --output /new/absolute/output [--mode monorepo|standalone]

Select an existing local Engine, exact existing source images and an explicit platform profile.
Core runs baseline source scenarios and the installed two-turn controlled ACP example.
Datasets independently runs shared-image/workspace isolation, cleanup recovery and its installed example.
Observer runs only the two-turn example. Grok initializes the selected pinned native binary without a
model turn or credentials. All rows observe daemon-side process/cgroup cleanup independently.
No image pull, context discovery, Desktop settings change or privileged fallback is performed.
`;

export const profiles = Object.freeze({
  'linux-x64': { os: 'linux', architecture: 'x64', daemonArchitecture: 'amd64', imageArchitecture: 'amd64' },
  'desktop-apple-virtualization-native-arm64': { os: 'darwin', architecture: 'arm64', daemonArchitecture: 'arm64', imageArchitecture: 'arm64' },
  'desktop-apple-virtualization-rosetta-amd64': { os: 'darwin', architecture: 'arm64', daemonArchitecture: 'arm64', imageArchitecture: 'amd64' },
});

function keys(value, names) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected a manifest object.');
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Unknown or missing platform manifest field.');
}

function text(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value), 'Bounded explicit identity required.');
}

export function parseArguments(argv) {
  const args = new Map();
  assert(argv.length === 8 || argv.length === 10, 'Explicit row, manifest, consumer and output required; mode is optional.');
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    assert(['--row', '--manifest', '--consumer', '--output', '--mode'].includes(key) && !args.has(key)
      && typeof value === 'string' && !value.startsWith('--'), 'Unknown, repeated or missing argument.');
    args.set(key, value);
  }
  const row = args.get('--row'), mode = args.get('--mode') ?? 'monorepo';
  assert(['core', 'datasets', 'observer', 'grok-initialize'].includes(row), 'Unknown qualification row.');
  assert(['monorepo', 'standalone'].includes(mode), 'Unknown source layout.');
  const output = absolutePath(args.get('--output'));
  assert(Buffer.byteLength(join(output, 'kernel.sock')) <= 100, 'Use a shorter output path for portable Unix sockets.');
  if (row === 'core') {
    assert(Buffer.byteLength(join(output, 'source-integration', 'uncertainty', 'cleanup-observation-timeout', 'engine.sock')) < 104,
      'Use a shorter output path for nested core Unix sockets.');
  } else if (row === 'datasets') {
    for (const directory of ['dataset-escape', 'creating-owner']) {
      assert(Buffer.byteLength(join(output, 'source-integration', directory, 'engine.sock')) < 104,
        'Use a shorter output path for nested dataset Unix sockets.');
    }
  }
  return { row, mode, manifestPath: absolutePath(args.get('--manifest')), consumer: absolutePath(args.get('--consumer')), output };
}

export async function readManifest(path, row) {
  const value = JSON.parse((await boundedFile(path, 16 * 1024)).toString('utf8'));
  keys(value, ['format', 'engine', 'profile', 'sourceImage', 'observerImage', 'expected', 'desktop',
    ...(Object.hasOwn(value, 'harness') ? ['harness'] : [])]);
  assert.equal(value.format, 'agenai.sandbox-platform-manifest.v1');
  assert(typeof value.engine === 'string' && value.engine.startsWith('unix:///'));
  absolutePath(value.engine.slice(7));
  assert(Object.hasOwn(profiles, value.profile), 'Explicit closed platform profile required.');
  for (const image of [value.sourceImage, value.observerImage]) assert.match(image, /^sha256:[a-f0-9]{64}$/u);
  const profile = profiles[value.profile];
  keys(value.expected, ['controller', 'daemon']);
  keys(value.expected.controller, ['os', 'architecture', 'nodeVersion']);
  assert.equal(value.expected.controller.os, profile.os);
  assert.equal(value.expected.controller.architecture, profile.architecture);
  assert.equal(value.expected.controller.nodeVersion, '24.18.0');
  keys(value.expected.daemon, ['id', 'version', 'apiVersion', 'architecture', 'kernelVersion', 'operatingSystem']);
  for (const field of Object.values(value.expected.daemon)) text(field);
  assert.equal(value.expected.daemon.architecture, profile.daemonArchitecture);
  assert(/^1\.\d+$/u.test(value.expected.daemon.apiVersion) && Number(value.expected.daemon.apiVersion.slice(2)) >= 52);
  if (profile.os === 'linux') assert.equal(value.desktop, null);
  else {
    keys(value.desktop, ['version', 'applicationPlist', 'vmm', 'rosetta', 'enhancedContainerIsolation']);
    text(value.desktop.version); absolutePath(value.desktop.applicationPlist);
    assert.equal(value.desktop.vmm, 'apple-virtualization');
    assert.equal(value.desktop.enhancedContainerIsolation, false);
    assert.equal(typeof value.desktop.rosetta, 'boolean');
    if (profile.imageArchitecture === 'amd64') assert.equal(value.desktop.rosetta, true);
    assert.equal(value.expected.daemon.operatingSystem, 'Docker Desktop');
  }
  if (value.harness !== undefined) {
    keys(value.harness, ['path', 'sha256']); absolutePath(value.harness.path);
    assert.equal(value.harness.sha256, harnessSha256);
  }
  if (row === 'grok-initialize') {
    assert(value.harness, 'The Grok row requires an explicit selected binary.');
    assert.equal(profile.imageArchitecture, 'amd64', 'This exact Grok artifact requires the amd64 guest row.');
  }
  return value;
}

export function verifyObservedTuple(manifest, version, info) {
  assert.deepEqual(manifest.expected.controller, { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node },
    'The actual controller differs from the selected tuple.');
  const observed = { id: info.ID, version: version.Version, apiVersion: version.ApiVersion, architecture: version.Arch,
    kernelVersion: info.KernelVersion, operatingSystem: info.OperatingSystem };
  assert.deepEqual(observed, manifest.expected.daemon, 'The selected daemon identity/version differs from observations.');
  assert.equal(version.Os, 'linux'); assert.equal(info.OSType, 'linux');
  return { controller: manifest.expected.controller, daemon: observed, securityOptions: info.SecurityOptions,
    cgroupVersion: info.CgroupVersion, cgroupDriver: info.CgroupDriver, engineGitCommit: version.GitCommit,
    desktopSettings: manifest.desktop === null ? null : { ...manifest.desktop, settingsAuthority: 'explicit caller assertion; not Engine attestation' } };
}
