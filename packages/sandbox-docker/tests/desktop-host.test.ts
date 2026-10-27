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
import { captureDockerRouteAuthority } from '../src/network/routeAuthority.js';
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
