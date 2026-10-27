// ------------------------------------------------------------------------------------------------
//                peer.test.mjs - Actual kernel-reader entrypoint rejects arbitrary host read authority
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const peer = new URL('./peer.mjs', import.meta.url).pathname;

test('kernel reader rejects unknown operations and process arguments/environment before touching kernel roots', async () => {
  for (const query of [{ operation: 'execute', command: 'anything' },
    { operation: 'read', path: '/etc/passwd', scopes: [] },
    { operation: 'read', path: '/proc/1/environ', scopes: [] },
    { operation: 'read', path: '/proc/1/cmdline', scopes: [] },
    { operation: 'read', path: '/sys/fs/cgroup/unregistered/memory.max', scopes: [] }]) {
    const result = await execute(process.execPath, [peer, JSON.stringify(query)], { timeout: 5000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.stderr, '');
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false);
    assert.equal(response.error.name, 'AssertionError');
    assert.notEqual(response.error.code, 'ENOENT', 'Input denial must precede access to the unmounted diagnostic roots.');
  }
});

test('kernel reader honors admitted scope capacity while preserving its exact path authority', async () => {
  const scopes = (count) => Array.from({ length: count }, (_, index) => {
    const computeId = (index + 1).toString(16).padStart(64, '0');
    return { computeId, relativePath: `/docker/${computeId}`, knownPids: [] };
  });
  for (const [query, message] of [
    [{ operation: 'read', path: '/etc/passwd', scopes: scopes(129) }, 'Kernel read exceeds its admitted scope capacity.'],
    [{ operation: 'read', path: '/etc/passwd', maxScopes: 256, scopes: scopes(256) }, 'Only fixed kernel observation paths are accepted.'],
    [{ operation: 'read', path: '/etc/passwd', maxScopes: 256, scopes: scopes(257) }, 'Kernel read exceeds its admitted scope capacity.'],
    [{ operation: 'read', path: '/etc/passwd', maxScopes: 129, scopes: [] }, 'Kernel scope capacity must select 128 or 256.'],
  ]) {
    const result = await execute(process.execPath, [peer, JSON.stringify(query)], { timeout: 5000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.stderr, ''); const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false); assert.equal(response.error.name, 'AssertionError'); assert.equal(response.error.message, message);
  }
});
