// ------------------------------------------------------------------------------------------------
//                provision-ci.test.mjs - Ephemeral daemon authority and policy restoration behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = new URL('./provision-ci.sh', import.meta.url).pathname;

async function fixture(action, overrides, inspect) {
  const root = await mkdtemp(path.join(tmpdir(), 'agenai-daemon-provision-test-'));
  const operation = path.join(root, 'agenai-sdk-sandbox-123-1');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'commands.json');
  await mkdir(bin);
  await writeFile(log, '[]');
  const fake = `#!${process.execPath}
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const calls = JSON.parse(readFileSync(log)); calls.push({ command, args }); writeFileSync(log, JSON.stringify(calls));
if (command === 'apt-get' && args.includes('download')) writeFileSync('fixture.deb', 'fixture package');
if (command === 'dpkg-deb') {
  const destination = path.join(args.at(-1), 'usr/bin'); mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(destination, 'docker'), '#!/bin/sh\\nexit 0\\n'); chmodSync(path.join(destination, 'docker'), 0o700);
}
if (command === 'systemctl' && args[0] === 'show') console.log('loaded');
if (command === 'bwrap') console.log('--ro-bind-fd --bind-fd');
if (command === 'sysctl') console.log('1');
if (command === 'sudo' && args[0] === 'journalctl' && process.env.FAIL_JOURNAL === '1') process.exit(3);
`;
  for (const command of ['sudo', 'curl', 'apt-get', 'dpkg-deb', 'systemctl', 'sysctl', 'bwrap']) {
    await writeFile(path.join(bin, command), fake);
    await chmod(path.join(bin, command), 0o700);
  }
  if (action === 'cleanup') await mkdir(operation);
  const envFile = path.join(root, 'env');
  const pathFile = path.join(root, 'path');
  await writeFile(envFile, '');
  await writeFile(pathFile, '');
  try {
    const result = await execute('/bin/bash', [script, action === 'cleanup' ? '--cleanup' : operation], { env: {
      PATH: `${bin}:/usr/bin:/bin`, SANDBOX_RUNNER_ENVIRONMENT: 'github-hosted', SANDBOX_RUNNER_OS: 'Linux', ImageOS: 'ubuntu24', RUNNER_ARCH: 'X64',
      RUNNER_TEMP: root, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_ENV: envFile, GITHUB_PATH: pathFile,
      ...(action === 'cleanup' ? { SANDBOX_CI_UNIT: 'agenai-sdk-sandbox-123-1', SANDBOX_CI_ROOT: operation, SANDBOX_APPARMOR_USERNS_ORIGINAL: '1' } : {}), ...overrides,
    }, timeout: 10_000 }).then((value) => ({ ...value, code: 0 }), (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
    await inspect({ result, commands: JSON.parse(await readFile(log, 'utf8')), environment: await readFile(envFile, 'utf8'), operation });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('provisioning and cleanup reject local or incompatible runner contexts before any command can mutate the host', async () => {
  for (const action of ['provision', 'cleanup']) {
    for (const overrides of [{ SANDBOX_RUNNER_ENVIRONMENT: 'self-hosted' }, { SANDBOX_RUNNER_OS: 'Windows' }, { ImageOS: 'ubuntu22' }, { RUNNER_ARCH: 'ARM64' }]) {
      await fixture(action, overrides, ({ result, commands, environment }) => {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /requires the ephemeral GitHub-hosted Ubuntu 24.04 x64 runner/u);
        assert.deepEqual(commands, []);
        assert.equal(environment, '');
      });
    }
  }
});

test('ephemeral provisioning fetches signed exact packages into private apt state and launches one owned daemon', async () => {
  await fixture('provision', {}, ({ result, commands, environment, operation }) => {
    assert.equal(result.code, 0, result.stderr);
    const download = commands.find(({ command, args }) => command === 'apt-get' && args.includes('download'));
    assert.deepEqual(download.args.slice(-3), ['docker-ce=5:29.1.4-1~ubuntu.24.04~noble', 'docker-ce-cli=5:29.1.4-1~ubuntu.24.04~noble', 'containerd.io=2.2.2-1~ubuntu.24.04~noble']);
    assert(download.args.includes(`Dir::State::lists=${operation}/apt/lists`));
    assert.equal(commands.some(({ command, args }) => command === 'apt-get' && args.includes('install')), false);
    const launch = commands.find(({ command, args }) => command === 'sudo' && args[0] === 'systemd-run');
    assert(launch.args.includes(`${operation}/tools/usr/bin/dockerd`));
    for (const argument of ['Delegate=yes', 'native.cgroupdriver=systemd', 'private', 'overlayfs', 'containerd-snapshotter=true', `${operation}/data`, `${operation}/exec`, `unix://${operation}/engine.sock`]) {
      assert(launch.args.includes(argument), `Missing owned daemon boundary ${argument}`);
    }
    assert.match(environment, /SANDBOX_CI_UNIT=agenai-sdk-sandbox-123-1\n/u);
    assert(environment.includes(`AGENAI_SANDBOX_CI_ENGINE=unix://${operation}/engine.sock\n`));
    assert(environment.includes('SANDBOX_APPARMOR_USERNS_ORIGINAL=1\n'));
    const stops = commands.filter(({ command, args }) => command === 'sudo' && args[0] === 'systemctl');
    assert.deepEqual(stops.map(({ args }) => args), [['systemctl', 'stop', 'docker.service', 'docker.socket']]);
  });
});

test('cleanup refuses a foreign unit and still stops the exact owned unit when log collection fails', async () => {
  await fixture('cleanup', { SANDBOX_CI_UNIT: 'foreign-daemon' }, ({ result, commands }) => {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /exact ephemeral operation identity/u);
    assert.deepEqual(commands, []);
  });
  for (const failJournal of ['0', '1']) await fixture('cleanup', { FAIL_JOURNAL: failJournal }, ({ result, commands }) => {
    assert.equal(result.code, failJournal === '1' ? 3 : 0, result.stderr);
    assert.deepEqual(commands.filter(({ command }) => command === 'sudo').map(({ args }) => args), [
      ['journalctl', '--unit', 'agenai-sdk-sandbox-123-1', '--no-pager'], ['systemctl', 'stop', 'agenai-sdk-sandbox-123-1'],
      ['sysctl', '--write', 'kernel.apparmor_restrict_unprivileged_userns=1'],
    ]);
  });
});
