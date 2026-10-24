// ------------------------------------------------------------------------------------------------
//                configuration.test.mjs - Qualification identity and explicit profile admission
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArguments, readManifest, verifyObservedTuple } from './configuration.mjs';

const image = `sha256:${'1'.repeat(64)}`;
const daemon = { id: 'selected-daemon', version: '29.1.3', apiVersion: '1.52', architecture: 'amd64',
  kernelVersion: 'selected-kernel', operatingSystem: 'selected-linux' };
const linux = { format: 'agenai.sandbox-platform-manifest.v1', engine: 'unix:///var/run/docker.sock',
  profile: 'linux-x64', sourceImage: image, observerImage: image,
  expected: { controller: { os: 'linux', architecture: 'x64', nodeVersion: '24.18.0' }, daemon }, desktop: null };
const argumentsFor = (row, output) => ['--row', row, '--manifest', '/tmp/input.json', '--consumer', '/tmp/consumer', '--output', output];

test('platform CLI keeps row/source layout explicit and rejects ambiguous inputs', () => {
  const args = argumentsFor('core', '/tmp/platform-proof');
  assert.deepEqual(parseArguments(args), { row: 'core', mode: 'monorepo', manifestPath: '/tmp/input.json',
    consumer: '/tmp/consumer', output: '/tmp/platform-proof' });
  assert.equal(parseArguments([...args, '--mode', 'standalone']).mode, 'standalone');
  assert.equal(parseArguments(args.map((value) => value === 'core' ? 'datasets' : value)).row, 'datasets');
  for (const invalid of [args.slice(0, -1), [...args, '--row', 'observer'], [...args, '--mode', 'automatic'],
    args.map((value) => value === 'core' ? 'live' : value), args.map((value) => value === '/tmp/platform-proof' ? 'relative' : value)]) {
    assert.throws(() => parseArguments(invalid));
  }
});

test('platform CLI rejects selected nested socket paths before acquiring the manifest or output', async (t) => {
  for (const [row, output] of [
    ['core', '/private/tmp/as5-mac.XXXXXX/core-r1'],
    ['core', `/private/tmp/${'é'.repeat(8)}/core-r1`],
    ['datasets', `/private/tmp/${'d'.repeat(45)}`],
  ]) await t.test(`${row}: ${output}`, () => {
    assert(Buffer.byteLength(join(output, 'kernel.sock')) <= 100, 'The outer socket alone admits this output.');
    assert.throws(() => parseArguments(argumentsFor(row, output)), /shorter output path.*nested.*Unix socket/u);
    assert.equal(parseArguments(argumentsFor('observer', output)).output, output, 'Observer does not create source fixture sockets.');
  });
});

test('the documented short canonical Mac output roots admit their selected socket layouts', () => {
  for (const [row, output] of [
    ['core', '/private/tmp/a5.XXXXXX/core-r1'], ['core', '/private/tmp/ac-r1'],
    ['datasets', '/private/tmp/a5.XXXXXX/datasets-r1'], ['datasets', '/private/tmp/ad-r1'],
    ['grok-initialize', '/private/tmp/ag-r1'],
  ]) assert.equal(parseArguments(argumentsFor(row, output)).output, output);
});

test('platform manifest rejects implicit emulation and undeclared native inputs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'manifest.json');
  const read = async (value, row = 'core') => { await writeFile(filename, JSON.stringify(value)); return readManifest(filename, row); };
  assert.deepEqual(await read(linux), linux);
  const desktop = { ...linux, profile: 'desktop-apple-virtualization-native-arm64',
    expected: { controller: { os: 'darwin', architecture: 'arm64', nodeVersion: '24.18.0' },
      daemon: { ...daemon, architecture: 'arm64', operatingSystem: 'Docker Desktop' } },
    desktop: { version: '4.86.0', applicationPlist: '/Applications/Docker.app/Contents/Info.plist',
      vmm: 'apple-virtualization', rosetta: false, enhancedContainerIsolation: false } };
  assert.deepEqual(await read(desktop), desktop);
  await assert.rejects(read({ ...desktop, profile: 'desktop-apple-virtualization-rosetta-amd64' }));
  assert.equal((await read({ ...desktop, profile: 'desktop-apple-virtualization-rosetta-amd64',
    desktop: { ...desktop.desktop, rosetta: true } })).desktop.rosetta, true);
  await assert.rejects(read({ ...desktop, desktop: { ...desktop.desktop, enhancedContainerIsolation: true } }));
  await assert.rejects(read({ ...desktop, desktop: { ...desktop.desktop, vmm: 'docker-vmm' } }));
  await assert.rejects(read(linux, 'grok-initialize'));
  await assert.rejects(read({ ...linux, sourceImage: 'node:latest' }));
  await assert.rejects(read({ ...linux, credential: '/private/key' }));
});

test('native observations must match the selected controller and exact daemon', () => {
  const manifest = { ...linux, expected: { controller: { os: process.platform, architecture: process.arch,
    nodeVersion: process.versions.node }, daemon } };
  const version = { Version: daemon.version, ApiVersion: daemon.apiVersion, Arch: daemon.architecture, Os: 'linux' };
  const info = { ID: daemon.id, KernelVersion: daemon.kernelVersion, OperatingSystem: daemon.operatingSystem, OSType: 'linux' };
  assert.deepEqual(verifyObservedTuple(manifest, version, info).daemon, daemon);
  assert.throws(() => verifyObservedTuple(manifest, version, { ...info, ID: 'replacement-daemon' }), /identity\/version/u);
  assert.throws(() => verifyObservedTuple(manifest, { ...version, Arch: 'arm64' }, info), /identity\/version/u);
  assert.throws(() => verifyObservedTuple({ ...manifest, expected: { ...manifest.expected,
    controller: { ...manifest.expected.controller, nodeVersion: '0.0.0' } } }, version, info), /controller/u);
});
