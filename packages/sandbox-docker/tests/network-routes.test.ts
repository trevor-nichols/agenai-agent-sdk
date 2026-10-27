// ------------------------------------------------------------------------------------------------
//                network-routes.test.ts - Real pinned observer execution, clean environment and joined abort
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createDockerLinuxRouteAuthority } from '../src/node/routeAuthority.js';
import { captureDockerLinuxRouteAuthority } from '../src/network/routeAuthority.js';

test('observer construction is inert and rejects forged/cloned authority handles', () => {
  const authority = createDockerLinuxRouteAuthority({ kind: 'local_linux_same_host', stability: 'caller_owned_quiescence',
    ipExecutable: { path: '/does-not-exist/ip', sha256: '1'.repeat(64) }, pollIntervalMs: 100, commandTimeoutMs: 1000, maxOutputBytes: 16384 });
  assert.deepEqual(captureDockerLinuxRouteAuthority(authority).identity.ipExecutable, { path: '/does-not-exist/ip', sha256: '1'.repeat(64) });
  assert.throws(() => captureDockerLinuxRouteAuthority({ ...authority }), { name: 'SandboxValidationError' });
});

test('actual descriptor-pinned observer receives only fixed arguments/environment and changed bytes reject', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agenai-route-command-'));
  const executable = join(directory, 'ip.cjs');
  const log = join(directory, 'calls.jsonl');
  const source = `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),env:Object.keys(process.env).sort()})+'\\n');process.stdout.write(JSON.stringify(process.argv.includes('address')?[{addr_info:[{family:'inet',local:'11.230.251.1',prefixlen:24}]}]:process.argv.includes('-4')?[{dst:'default',gateway:'192.168.1.1'},{dst:'11.230.251.0/24'}]:[{dst:'fd12::/64'}]));\n`;
  try {
    await writeFile(executable, source, { mode: 0o700 });
    await chmod(executable, 0o700);
    const authority = createDockerLinuxRouteAuthority({ kind: 'local_linux_same_host', stability: 'caller_owned_quiescence',
      ipExecutable: { path: executable, sha256: createHash('sha256').update(source).digest('hex') }, pollIntervalMs: 100, commandTimeoutMs: 2000, maxOutputBytes: 16384 });
    const observer = captureDockerLinuxRouteAuthority(authority);
    const census = await observer.observe();
    assert.equal(census.excludedCidrs.includes('11.230.251.0/24'), true);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      { args: ['-json', '-4', 'route', 'show', 'table', 'all'], env: ['LANG', 'LC_ALL', 'PATH'] },
      { args: ['-json', '-6', 'route', 'show', 'table', 'all'], env: ['LANG', 'LC_ALL', 'PATH'] },
      { args: ['-json', 'address', 'show'], env: ['LANG', 'LC_ALL', 'PATH'] },
    ]);
    await writeFile(executable, `${source}\n// changed\n`);
    await assert.rejects(observer.observe(), { name: 'SandboxUnsupportedError' });
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancelled real observation joins the owned process before returning', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agenai-route-abort-'));
  const executable = join(directory, 'ip.cjs');
  const pidFile = join(directory, 'pid');
  const source = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`;
  const controller = new AbortController();
  let observation: Promise<unknown> | undefined;
  try {
    await writeFile(executable, source, { mode: 0o700 });
    const authority = createDockerLinuxRouteAuthority({ kind: 'local_linux_same_host', stability: 'caller_owned_quiescence',
      ipExecutable: { path: executable, sha256: createHash('sha256').update(source).digest('hex') }, pollIntervalMs: 100, commandTimeoutMs: 3000, maxOutputBytes: 16384 });
    observation = captureDockerLinuxRouteAuthority(authority).observe(controller.signal);
    void observation.catch(() => {});
    let pid: number | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(10); }
    }
    assert.equal(typeof pid, 'number');
    if (pid === undefined) throw new Error('Observer did not start.');
    controller.abort();
    await assert.rejects(observation, { name: 'SandboxOperationError', code: 'cancelled' });
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await observation?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
