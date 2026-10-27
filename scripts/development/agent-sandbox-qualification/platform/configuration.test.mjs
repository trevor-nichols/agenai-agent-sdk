// ------------------------------------------------------------------------------------------------
//                configuration.test.mjs - Qualification identity and explicit profile admission
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
  assert.deepEqual(parseArguments(args), { row: 'core', mode: 'monorepo', testConcurrency: null, manifestPath: '/tmp/input.json',
    consumer: '/tmp/consumer', output: '/tmp/platform-proof' });
  assert.equal(parseArguments([...args, '--mode', 'standalone']).mode, 'standalone');
  assert.equal(parseArguments(args.map((value) => value === 'core' ? 'datasets' : value)).row, 'datasets');
  for (const row of ['core', 'datasets']) for (const concurrency of ['1', '8']) {
    const selected = parseArguments([...argumentsFor(row, '/tmp/platform-proof'), '--test-concurrency', concurrency, '--mode', 'standalone']);
    assert.equal(selected.testConcurrency, Number(concurrency));
    assert.equal(selected.mode, 'standalone');
  }
  for (const row of ['live-files', 'preserve-internal', 'restricted-https', 'combined']) {
    const selected = parseArguments([...argumentsFor(row, '/tmp/platform-proof'), '--capabilities-manifest', '/tmp/capabilities.json']);
    assert.equal(selected.row, row);
    assert.equal(selected.capabilitiesManifestPath, '/tmp/capabilities.json');
    assert.equal(selected.testConcurrency, null);
  }
  for (const invalid of [args.slice(0, -1), [...args, '--row', 'observer'], [...args, '--mode', 'automatic'],
    ...['0', '9', '-1', '1.5', 'many', '01', '+1', '1e0', '1.0', 'NaN', 'Infinity', '', ' 1', '1 ']
      .map((value) => [...args, '--test-concurrency', value]),
    [...args, '--test-concurrency', '1', '--test-concurrency', '2'], [...args, '--test-concurrency'],
    ...['observer', 'grok-initialize'].map((row) => [...argumentsFor(row, '/tmp/platform-proof'), '--test-concurrency', '1']),
    ...['live-files', 'preserve-internal', 'restricted-https', 'combined'].map((row) => argumentsFor(row, '/tmp/platform-proof')),
    [...args, '--capabilities-manifest', '/tmp/capabilities.json'],
    [...argumentsFor('live-files', '/tmp/platform-proof'), '--capabilities-manifest', '/tmp/capabilities.json', '--test-concurrency', '1'],
    args.map((value) => value === 'core' ? 'live' : value), args.map((value) => value === '/tmp/platform-proof' ? 'relative' : value)]) {
    assert.throws(() => parseArguments(invalid));
  }
});

test('platform CLI rejects invalid scheduling before reading a manifest or creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-cli-'));
  const execute = promisify(execFile);
  const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
  try {
    for (const [row, extra, message] of [
      ['core', ['--test-concurrency', '0'], /integer between 1 and 8/u],
      ['core', ['--test-concurrency', '1', '--test-concurrency', '2'], /repeated/u],
      ['observer', ['--test-concurrency', '1'], /only supported for core and datasets/u],
      ['core', ['--capabilities-manifest', '/unread/capabilities.json'], /Baseline rows reject/u],
      ['live-files', [], /Advanced rows require/u],
      ['combined', ['--capabilities-manifest', '/unread/capabilities.json', '--test-concurrency', '1'], /only supported for core and datasets/u],
    ]) {
      const args = ['--row', row, '--manifest', join(root, 'unread-manifest.json'), '--consumer', join(root, 'consumer'),
        '--output', join(root, 'output'), ...extra];
      await assert.rejects(execute(process.execPath, [runner, ...args], { env: {} }), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        const result = JSON.parse(error.stderr);
        assert.equal(result.status, 'failed');
        assert.match(result.failure.message, message);
        return true;
      });
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
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
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'platform-config-')));
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
