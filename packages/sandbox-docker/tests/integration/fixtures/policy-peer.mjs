// ------------------------------------------------------------------------------------------------
//                policy-peer.mjs - Bounded guest filesystem and network probes - No credentials
// ------------------------------------------------------------------------------------------------

import { access, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { get } from 'node:http';
import { isIPv4 } from 'node:net';
import assert from 'node:assert/strict';

assert.equal(process.version, 'v24.18.0');
const mode = process.argv[2];
let result;
if (mode === 'filesystem') {
  const denied = {};
  for (const [label, pathname, operation] of [
    ['host-sentinel', process.argv[3], () => readFile(process.argv[3])],
    ['docker-socket', '/var/run/docker.sock', () => access('/var/run/docker.sock')],
    ['readonly-root', '/etc/agenai-sandbox-write-probe', () => writeFile('/etc/agenai-sandbox-write-probe', 'forbidden')],
  ]) {
    try { await operation(); throw new Error(`${label} unexpectedly succeeded at ${pathname}`); }
    catch (error) {
      assert(['ENOENT', 'EROFS', 'EACCES'].includes(error.code));
      denied[label] = error.code;
    }
  }
  await writeFile('/home/sandbox/private-home', 'home');
  await writeFile('/tmp/private-temp', 'temp');
  const input = await readFile('input.txt', 'utf8');
  assert.equal(input, 'original input\n');
  result = { mode, node: process.version, uid: process.getuid(), denied, input, privateHome: true, privateTemp: true };
  await writeFile('artifact.json', `${JSON.stringify(result)}\n`);
} else if (mode === 'fifo' || mode === 'symlink' || mode === 'oversized') {
  await writeFile('safe.txt', 'selected safe file\n');
  if (mode === 'fifo') execFileSync('/usr/bin/mkfifo', ['unsafe'], { timeout: 2000 });
  if (mode === 'symlink') await symlink('/etc/passwd', 'unsafe');
  if (mode === 'oversized') await writeFile('oversized.bin', Buffer.alloc(16 * 1024, 0x6d));
  result = { mode, node: process.version, created: true };
} else if (mode === 'resolve-host') {
  const hostname = 'host.docker.internal';
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  const timer = setTimeout(() => resolver.cancel(), 2000);
  try {
    const addresses = await resolver.resolve4(hostname);
    assert(addresses.length > 0 && addresses.length <= 16 && addresses.every(isIPv4));
    result = { mode, node: process.version, hostname, address: addresses[0], family: 4 };
  } finally { clearTimeout(timer); }
} else if (mode === 'network') {
  result = await new Promise((resolve) => {
    const request = get(process.argv[3], { agent: false }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024) request.destroy(new Error('Bounded guest response exceeded 1 KiB.'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ mode, node: process.version, status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', (error) => resolve({ mode, node: process.version, error: error.code ?? error.message }));
    });
    const timer = setTimeout(() => request.destroy(new Error('guest-network-deadline')), 2000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', (error) => resolve({ mode, node: process.version, error: error.code ?? error.message }));
  });
} else throw new Error('An explicit policy probe mode is required.');
process.stdout.write(`${JSON.stringify(result)}\n`);
