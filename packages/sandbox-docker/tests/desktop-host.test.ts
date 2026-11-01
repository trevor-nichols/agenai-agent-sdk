// ------------------------------------------------------------------------------------------------
//                desktop-host.test.ts - Real prepared-path host observations, artifact fencing and joins
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createDockerDesktopRouteAuthority } from '../src/node/desktopRouteAuthority.js';
import { parseDesktopHostObservation } from '../src/network/desktop/observation/host.js';
import { captureDockerRouteAuthority } from '../src/network/routeAuthority.js';
import { DockerResponseByteBudget } from '../src/resources/api.js';
import { desktopRouteAuthorityOptions } from './fixtures/desktopRouteAuthority.js';
import { desktopHostDocument } from './fixtures/desktopObservation.js';
import { preparedNodeEnvironment } from './fixtures/preparedNode.js';

async function fixture(program: (log: string) => string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'desktop-host-')));
  const executable = join(directory, 'observer.cjs');
  const log = join(directory, 'entered.json');
  const source = `#!${process.execPath}\n${program(log)}\n`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  const options = desktopRouteAuthorityOptions('desktop-apple-virtualization-native-arm64');
  options.hostObserver.executable = { path: executable, sha256: createHash('sha256').update(source).digest('hex') };
  options.commandTimeoutMs = 3000; options.maxOutputBytes = 16384;
  const bind = () => {
    const binding = captureDockerRouteAuthority(createDockerDesktopRouteAuthority(options));
    if (binding.kind !== 'local_docker_desktop') throw new Error('Expected original Desktop binding.');
    return binding;
  };
  return { directory, executable, log, options, bind, async close() { await rm(directory, { recursive: true, force: true }); } };
}

test('original Desktop binding runs the pinned physical executable with no arguments and a closed environment', async () => {
  const doc = desktopHostDocument();
  const environment = preparedNodeEnvironment({ executable: process.execPath, platform: process.platform });
  const owned = await fixture((log) => `require('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()}));process.stdout.write(${JSON.stringify(JSON.stringify(doc))});`);
  try {
    const result = await owned.bind().observeHost();
    assert.equal(result.proxySafe, true);
    assert(result.excludedCidrs.includes('11.55.1.0/24'));
    assert.deepEqual(JSON.parse(await readFile(owned.log, 'utf8')), { args: [], env: environment, cwd: '/' });
    await writeFile(owned.executable, `${await readFile(owned.executable, 'utf8')}\n// changed\n`);
    await assert.rejects(owned.bind().observeHost(), { name: 'SandboxUnsupportedError' });
    const alias = join(owned.directory, 'alias'); await symlink(owned.executable, alias);
    owned.options.hostObserver.executable.sha256 = createHash('sha256').update(await readFile(owned.executable)).digest('hex');
    owned.options.hostObserver.executable.path = alias;
    await assert.rejects(owned.bind().observeHost());
  } finally { await owned.close(); }
});

test('successful process exit with diagnostics does not establish host authority', async () => {
  const owned = await fixture(() => `process.stderr.write('diagnostic');process.stdout.write(${JSON.stringify(JSON.stringify(desktopHostDocument()))});`);
  try { await assert.rejects(owned.bind().observeHost(), { name: 'SandboxOperationError', code: 'driver_failure' }); }
  finally { await owned.close(); }
});

test('cancelled prepared-path observation joins its actual process group and inherited pipes', { timeout: 10_000 }, async () => {
  const owned = await fixture((log) => `const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});require('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const operation = owned.bind().observeHost(controller.signal);
  void operation.catch(() => {});
  try {
    let pids: number[] | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { pids = JSON.parse(await readFile(owned.log, 'utf8')); break; } catch { await delay(10); }
    }
    if (!pids) throw new Error('Host observation did not enter its real process.');
    controller.abort();
    await assert.rejects(operation, { name: 'SandboxOperationError', code: 'cancelled' });
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { controller.abort(); await operation.catch(() => {}); await owned.close(); }
});

test('overflowing host output is rejected only after the actual producer has joined', { timeout: 10_000 }, async () => {
  const owned = await fixture((log) => `require('node:fs').writeFileSync(${JSON.stringify(log)},String(process.pid));process.stdout.write(Buffer.alloc(32768,120));setInterval(()=>{},1000);`);
  owned.options.maxOutputBytes = 1024;
  try {
    await assert.rejects(owned.bind().observeHost(), { name: 'SandboxOperationError', code: 'output_limit' });
    const pid = Number(await readFile(owned.log, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await owned.close(); }
});

test('host raw budget spans actual stdout and diagnostics across joined observations before JSON parsing', { timeout: 10_000 }, async () => {
  const valid = JSON.stringify(desktopHostDocument());
  const invalid = 'é'.repeat(Buffer.byteLength(valid));
  const diagnostic = 'diagnostic';
  const budget = new DockerResponseByteBudget(Buffer.byteLength(valid) + Buffer.byteLength(invalid) + Buffer.byteLength(diagnostic) - 1);
  const owned = await fixture((log) => `const fs=require('node:fs');const repeated=fs.existsSync(${JSON.stringify(log)});fs.writeFileSync(${JSON.stringify(log)},String(process.pid));process.stdout.write(repeated?${JSON.stringify(invalid)}:${JSON.stringify(valid)});if(repeated)process.stderr.write(${JSON.stringify(diagnostic)});`);
  try {
    const binding = owned.bind();
    const first = await binding.observeHost(undefined, budget);
    assert.equal(first.proxySafe, true);
    assert(first.excludedCidrs.includes('11.55.1.0/24'));
    await assert.rejects(binding.observeHost(undefined, budget), {
      name: 'SandboxOperationError', code: 'output_limit', message: 'Docker JSON responses exceed their cumulative byte bound.',
    });
    const pid = Number(await readFile(owned.log, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await owned.close(); }
});

function linkLocalHost(addresses: Readonly<Record<'awdl0' | 'llw0', readonly Readonly<{ address: string; flags: number }>[]>>) {
  const document = desktopHostDocument();
  const v6 = (address: string, flags: number, scopeId: number) => ({ family: 6, address, netmask: 'ffff:ffff:ffff:ffff::', scopeId, flags,
    peer: null, broadcast: null });
  return { ...document, interfaces: [...document.interfaces, { index: 1, name: 'lo0', flags: 0x8049, addresses: [v6('fe80::1', 0x100, 1)] },
    { index: 14, name: 'awdl0', flags: 0x8863, addresses: addresses.awdl0.map(({ address, flags }) => v6(address, flags, 14)) },
    { index: 15, name: 'llw0', flags: 0x8863, addresses: addresses.llw0.map(({ address, flags }) => v6(address, flags, 15)) }] };
}

test('Darwin link-local address rotation and its duplicate-address-detection states leave host authority unchanged', () => {
  const original = { address: 'fe80::1c2b:3cff:fe4d:5e6f', flags: 0x100 };
  const rotated = { address: 'fe80::a0b1:c2ff:fed3:e4f5', flags: 0x100 };
  const baseline = parseDesktopHostObservation(linkLocalHost({ awdl0: [original], llw0: [original] }));
  for (const addresses of [
    { awdl0: [rotated], llw0: [rotated] },
    { awdl0: [{ ...rotated, flags: 0x102 }], llw0: [{ ...rotated, flags: 0x102 }] },
    { awdl0: [original, rotated], llw0: [rotated] },
    { awdl0: [], llw0: [] },
  ]) {
    const observed = parseDesktopHostObservation(linkLocalHost(addresses));
    assert.equal(observed.fingerprint, baseline.fingerprint);
    assert.deepEqual(observed.excludedCidrs, baseline.excludedCidrs);
  }
});

test('a wall-clock step that moves Darwin kern.boottime leaves host authority unchanged', () => {
  const document = desktopHostDocument();
  const baseline = parseDesktopHostObservation(document);
  // Native rn02r15s1 host monitor: one clock step moved kern.boottime from .473377 to .388480 within the same second.
  for (const boot of [{ ...document.host.boot, microseconds: (document.host.boot.microseconds + 915103) % 1_000_000 },
    { seconds: document.host.boot.seconds - 1, microseconds: 999999 }]) {
    const stepped = parseDesktopHostObservation({ ...document, host: { ...document.host, boot } });
    assert.equal(stepped.fingerprint, baseline.fingerprint);
    assert.deepEqual(stepped.snapshot.host.boot, boot);
  }
});

test('host route, address, interface and proxy authority changes still change the fingerprint', () => {
  const linkLocal = [{ address: 'fe80::1c2b:3cff:fe4d:5e6f', flags: 0x100 }];
  const document = linkLocalHost({ awdl0: linkLocal, llw0: linkLocal });
  const baseline = parseDesktopHostObservation(document).fingerprint;
  const en0 = document.interfaces[0]!;
  const changed = [
    { ...document, interfaces: [{ ...en0, addresses: [{ ...en0.addresses[0]!, address: '11.56.1.22', broadcast: { address: '11.56.1.255', scopeId: 0 } }] },
      ...document.interfaces.slice(1)] },
    { ...document, interfaces: [{ ...en0, addresses: [...en0.addresses, { family: 6, address: '2001:db8:5::22', netmask: 'ffff:ffff:ffff:ffff::',
      scopeId: 0, flags: 0, peer: null, broadcast: null }] }, ...document.interfaces.slice(1)] },
    { ...document, interfaces: [...document.interfaces, { index: 26, name: 'utun4', flags: 0x8051, addresses: [] }] },
    { ...document, interfaces: document.interfaces.map((device) => device.name === 'awdl0' ? { ...device, flags: 0x8822 } : device) },
    { ...document, routes: [{ ...document.routes[0]!, gateway: { kind: 'ip', family: 4, address: '11.55.1.2', scopeId: 0 } }] },
    { ...document, proxy: { ...document.proxy, scopes: 2 } },
    { ...document, host: { ...document.host, osBuild: '25F81' } },
    { ...document, host: { ...document.host, kernel: '25.6.0' } },
  ];
  for (const value of changed) assert.notEqual(parseDesktopHostObservation(value).fingerprint, baseline);
});
