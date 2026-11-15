import assert from 'node:assert/strict';
import test from 'node:test';
import { openNodeProviderToolOwner } from '../src/node/index.js';
import type { NodeProviderToolOptions } from '../src/index.js';

const NATIVE = { path: '/opt/native/bin', sha256: { 'linux-x64': '0'.repeat(64), 'linux-arm64': '0'.repeat(64) }, maxBytes: 1 };
const VALID: NodeProviderToolOptions = {
  workspace: { storeDirectory: '/var/tmp/store', workspaceDirectory: '/var/tmp/store/work' },
  stateParentDirectory: '/var/tmp/state', bubblewrapPath: '/usr/bin/bwrap', filesystemHelperPath: '/usr/local/bin/helper',
};

test('unsupported helper identities reject before inspecting executables or acquiring a workspace', async (t) => {
  const descriptors = ['platform', 'arch', 'version', 'geteuid', 'getegid'].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)!] as const);
  Object.defineProperties(process, { platform: { value: 'linux' }, arch: { value: 'x64' }, version: { value: 'v24.18.0' } });
  t.after(() => { for (const [key, descriptor] of descriptors) Object.defineProperty(process, key, descriptor); });
  for (const [uid, gid] of [[262_144, 1000], [1000, 262_144], [0, 1000], [1000, 0]]) {
    Object.defineProperties(process, { geteuid: { value: () => uid }, getegid: { value: () => gid } });
    await assert.rejects(openNodeProviderToolOwner(VALID, NATIVE), (error: Error & { code?: string }) =>
      error.code === 'platform_unsupported' && /filesystem helper range/u.test(error.message));
  }
});

test('materialization refuses options outside the documented contract before touching the host', async () => {
  const cases: readonly [string, unknown][] = [
    ...['/usr', '/usr/local/private', '/bin/private', '/lib/private', '/lib64/private', '/sbin/private'].flatMap((path) => [
      [`state exposed through ${path}`, { ...VALID, stateParentDirectory: path }],
      [`store exposed through ${path}`, { ...VALID, workspace: { storeDirectory: path, workspaceDirectory: `${path}/work` } }],
    ] satisfies readonly [string, unknown][]),
    ['workspace outside the store', { ...VALID, workspace: { storeDirectory: '/var/tmp/store', workspaceDirectory: '/var/tmp/elsewhere' } }],
    ['relative path', { ...VALID, bubblewrapPath: 'bwrap' }],
    ['non-canonical path', { ...VALID, filesystemHelperPath: '/usr/local/../bin/helper' }],
    ['limit above the package maximum', { ...VALID, limits: { commandTimeoutMs: 600_001 } }],
    ['fractional limit', { ...VALID, limits: { pendingCalls: 1.5 } }],
    ['negated selector', { ...VALID, restrictions: { denyRead: ['!keep'] } }],
    ['parent selector', { ...VALID, restrictions: { askEdit: ['../outside'] } }],
    ['too many selectors', { ...VALID, restrictions: { denyEdit: Array.from({ length: 65 }, (_, index) => `f${index}`) } }],
    ['unknown option', { ...VALID, environment: { PATH: '/bin' } }],
    ['accessor', Object.defineProperty({ ...VALID }, 'bubblewrapPath', { enumerable: true, get: () => '/usr/bin/bwrap' })],
  ];
  for (const [name, options] of cases) {
    await assert.rejects(openNodeProviderToolOwner(options as NodeProviderToolOptions, NATIVE), { name: 'NodeProviderToolsError', code: 'invalid_options' }, name);
  }
});

test('sixty-four caller selectors remain valid alongside the built-in protected entries', async () => {
  const restrictions = { askEdit: Array.from({ length: 64 }, (_, index) => `generated/${index}/**`) };
  await assert.rejects(openNodeProviderToolOwner({ ...VALID, restrictions }, NATIVE),
    (error: Error & { code?: string }) => error.code !== 'invalid_options');
});

test('private paths beside system mounts and system executable paths remain admissible', async () => {
  await assert.rejects(openNodeProviderToolOwner({ ...VALID,
    workspace: { storeDirectory: '/usr-other/store', workspaceDirectory: '/usr-other/store/work' },
    stateParentDirectory: '/usr-other/state',
  }, NATIVE), (error: Error & { code?: string }) => error.code !== 'invalid_options');
});
