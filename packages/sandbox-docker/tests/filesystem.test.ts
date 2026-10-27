// ------------------------------------------------------------------------------------------------
//                filesystem.test.ts - Public live file ownership, immutable admission and Engine lifecycle
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { extract } from 'tar-stream';
import { SandboxStartError, SandboxStateError, SandboxUnsupportedError, SandboxValidationError, fileFromBytes, parseSandboxRequest } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '../src/index.js';
import { engineFixture, gate, imageDigest, sandboxRequest } from './fixtures/engine.js';
import { filesystemConfiguration, filesystemFixture } from './fixtures/filesystem.js';

const bounded = { timeout: 10_000 };
function request(kind: 'read_only' | 'read_write') {
  return parseSandboxRequest({ policy: { ...sandboxRequest().policy, files: { kind } } });
}

test('live grants require explicit prepared configuration and bind its complete identity before Engine effects', bounded, async () => {
  const filesystem = filesystemConfiguration();
  const options = { endpoint: 'unix:///absent-live-engine.sock', namespace: 'live-identity', spillDirectory: '/absent-live-spill',
    imageDigest, user: { uid: 65534, gid: 65534 } };
  assert.throws(() => createDockerSandboxBackend(options).reserve(request('read_only'), { kind: 'in_process' }), SandboxUnsupportedError);
  const backend = createDockerSandboxBackend({ ...options, filesystem });
  const original = backend.reserve(request('read_write'), { kind: 'in_process' }).recoveryRecord;
  assert.deepEqual(original.resources.map(({ role }) => role), ['compute', 'storage', 'export', 'filesystem']);
  for (const changed of [
    { ...filesystem, imageDigest: `sha256:${'9'.repeat(64)}` },
    { ...filesystem, resources: { ...filesystem.resources, cpus: 0.5 } },
    { ...filesystem, temporaryBytes: 2 * 1024 ** 2 },
    { ...filesystem, control: { ...filesystem.control, leaseTimeoutMs: 3000 } },
  ]) assert.equal((await createDockerSandboxBackend({ ...options, filesystem: changed }).reconcile(original)).kind, 'conflict');
  for (const invalid of [
    { ...filesystem, user: { uid: 12001, gid: 65534 } }, { ...filesystem, executable: '/bin/unapproved' },
    { ...filesystem, control: { heartbeatMs: 2000, leaseTimeoutMs: 2000 } },
  ]) assert.throws(() => Reflect.apply(createDockerSandboxBackend, undefined, [{ ...options, filesystem: invalid }]), SandboxValidationError);
  const baseline = createDockerSandboxBackend(options).reserve(sandboxRequest(), { kind: 'in_process' }).recoveryRecord;
  const absent = createDockerSandboxBackend({ ...options, filesystem: undefined }).reserve(sandboxRequest(), { kind: 'in_process' }).recoveryRecord;
  assert.equal(absent.configurationDigest, baseline.configurationDigest);
  assert.deepEqual(absent.resources.map(({ role }) => role), ['compute', 'storage', 'export']);
});

test('prepared filesystem user and executable metadata reject before creating storage or helpers', bounded, async () => {
  const filesystem = filesystemConfiguration();
  const fixture = await engineFixture({ filesystem, async handleRequest({ path, response }) {
    if (path !== `/v1.52/images/${filesystem.imageDigest}/json`) return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ Id: filesystem.imageDigest, Os: 'linux', Architecture: 'amd64',
      Config: { User: '0:0', Entrypoint: [filesystem.executable], Cmd: null, Env: null, Volumes: null,
        Labels: { 'ai.agen.sandbox.filesystem.protocol': filesystem.protocol, 'ai.agen.sandbox.filesystem.layout': filesystem.layout,
          'ai.agen.sandbox.filesystem.user': '65534:65534', 'ai.agen.sandbox.filesystem.source': imageDigest } } }));
    return true;
  } });
  const owner = fixture.backend.reserve(request('read_only'), { kind: 'in_process' });
  try {
    await assert.rejects(owner.start(), (error: unknown) => error instanceof SandboxStartError
      && error.cause instanceof SandboxUnsupportedError && /Prepared filesystem image/u.test(error.cause.message));
    assert.deepEqual(fixture.effects, []);
    await owner.destroy();
    assert.deepEqual(owner.state, { kind: 'destroyed' });
    assert.deepEqual(fixture.effects, []);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('helper acquisition precedes guest mounts and public streaming files settle before work-only final export', bounded, async () => {
  const fixture = await filesystemFixture();
  const checkpoint = gate(), release = gate();
  const phases: SandboxRecoveryRecord[] = [];
  const owner = fixture.backend.reserve(request('read_write'), { kind: 'persisted', async persist(record) {
    phases.push(record);
    if (record.resources.find(({ role }) => role === 'filesystem')?.identity.kind === 'creating') {
      checkpoint.resolve(); await release.promise;
    }
  } });
  const starting = owner.start();
  try {
    await Promise.race([checkpoint.promise, starting.then(() => { throw new Error('Startup settled before its filesystem create checkpoint.'); })]);
    assert.equal(fixture.containers.size, 0);
    assert.equal(fixture.volumes.size, 1);
    release.resolve();
    const sandbox = await starting;
    assert.equal(sandbox.files.kind, 'read_write');
    if (sandbox.files.kind !== 'read_write') throw new Error('Missing admitted write authority.');
    const helper = [...fixture.containers.values()].find((container) => container.Name.endsWith('-filesystem'));
    assert(helper);
    assert.deepEqual(helper.HostConfig.Mounts, [{ Type: 'volume', Source: owner.recoveryRecord.resources.find(({ role }) => role === 'storage')?.name,
      Target: '/store', ReadOnly: false, VolumeOptions: { NoCopy: false } }]);
    for (const guest of [...fixture.containers.values()].filter((container) => !container.Name.endsWith('-filesystem'))) {
      const mounts = guest.HostConfig.Mounts;
      assert(Array.isArray(mounts));
      assert.deepEqual(mounts.map((mount) => ({ target: mount.Target, options: mount.VolumeOptions })),
        [{ target: '/workspace/work', options: { NoCopy: true, Subpath: 'work' } }]);
    }
    const expected = Buffer.alloc(140_000, 0x6d);
    await sandbox.importTree([fileFromBytes('program.bin', expected, { executable: true }), fileFromBytes('second.txt', Buffer.from('old'))]);
    const uploads = fixture.requests.filter(({ method, path }) => method === 'PUT' && path.endsWith('/archive'));
    assert.deepEqual(uploads.map(({ target }) => new URL(target, 'http://fixture.invalid').searchParams.get('path')),
      ['/workspace/work', '/workspace/work']);
    const members: string[][] = [];
    for (const archive of fixture.uploadedArchives) {
      const decoder = extract(); const names: string[] = [];
      decoder.end(archive);
      for await (const member of decoder) {
        names.push(member.header.name);
        for await (const _bytes of member) { /* Drain the independent decoder's bounded payload. */ }
      }
      members.push(names);
    }
    assert.deepEqual(members, [[], ['program.bin', 'second.txt']]);
    assert.deepEqual(await sandbox.files.stat('program.bin'), { kind: 'completed', entry: {
      path: 'program.bin', kind: 'file', byteLength: 140_000, permissions: 0o700 } });
    const listed: string[] = [];
    assert.deepEqual(await sandbox.files.list('.', async (entry) => { listed.push(entry.path); }), { kind: 'completed', entries: 2n });
    assert.deepEqual(listed.sort(), ['program.bin', 'second.txt']);
    const observed: Buffer[] = [];
    assert.deepEqual(await sandbox.files.readFile('program.bin', async ({ chunks }) => {
      for await (const part of chunks) observed.push(Buffer.from(part));
    }), { kind: 'completed', bytes: 140_000n });
    assert.deepEqual(Buffer.concat(observed), expected);
    assert.deepEqual(await sandbox.files.readFile('program.bin', async ({ chunks }) => {
      for await (const _part of chunks) throw new Error('Quota must be checked before delivery.');
    }, { quotas: { maxBytes: 1 } }), { kind: 'rejected', reason: 'quota_exceeded', bytes: 0n });
    assert.deepEqual(await sandbox.files.writeFile('new.txt', [Buffer.from('new')], { mode: 'create' }),
      { kind: 'completed', effect: 'published', bytes: 3n, permissions: 0o644 });
    assert.deepEqual(await sandbox.files.writeFile('program.bin', [Buffer.from('replacement')], { mode: 'replace' }),
      { kind: 'completed', effect: 'published', bytes: 11n, permissions: 0o700 });
    assert.deepEqual(await sandbox.files.writeFile('new.txt', [Buffer.from('forbidden')], { mode: 'create' }),
      { kind: 'rejected', effect: 'none', reason: 'already_exists', bytes: 0n });
    await sandbox.stop();
    assert.deepEqual([...fixture.containers.values()].map((container) => container.Name.split('-').at(-1)), ['export']);
    const exported = new Map<string, Buffer>();
    await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
      if (entry.kind === 'file') { const bytes: Buffer[] = []; for await (const part of entry.bytes) bytes.push(Buffer.from(part)); exported.set(entry.path, Buffer.concat(bytes)); }
    });
    assert.deepEqual([...exported.keys()].sort(), ['new.txt', 'program.bin', 'second.txt']);
    assert.equal(exported.get('program.bin')?.toString(), 'replacement');
    assert.equal(fixture.requests.filter(({ method, path, target }) => method === 'GET' && path.endsWith('/archive') && target.includes('path=%2Fworkspace%2Fwork')).length, 1);
    assert.equal(phases.at(-1)?.phase, 'stopped');
    await sandbox.destroy(); await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { release.resolve(); await starting.catch(() => {}); await owner.destroy(); await fixture.close(); }
});

test('read-only authority requires exact helper user and an empty disabled-network census before compute admission', bounded, async () => {
  for (const options of [{}, { wrongReadyUser: true }, { foreignNetwork: true }]) {
    const fixture = await filesystemFixture(options);
    const owner = fixture.backend.reserve(request('read_only'), { kind: 'in_process' });
    try {
      if (options.wrongReadyUser || options.foreignNetwork) {
        await assert.rejects(owner.start(), SandboxStartError);
        assert.equal(fixture.effects.filter(({ path, body }) => path.endsWith('/containers/create')
          && typeof body === 'object' && body !== null && Reflect.get(body, 'Image') === imageDigest).length, 0);
      } else {
        const sandbox = await owner.start();
        assert.equal(sandbox.files.kind, 'read_only'); assert.equal('writeFile' in sandbox.files, false);
        const helper = [...fixture.containers.values()].find((container) => container.Name.endsWith('-filesystem'));
        assert(helper); const mounts = helper.HostConfig.Mounts; assert(Array.isArray(mounts));
        assert.deepEqual(mounts.map((mount) => ({ readOnly: mount.ReadOnly, copy: mount.VolumeOptions.NoCopy })), [{ readOnly: true, copy: false }]);
        assert.deepEqual(helper.NetworkSettings.Networks, {});
      }
      await owner.destroy();
      assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
    } finally { await owner.destroy(); await fixture.close(); }
  }
});

test('stop retains and removes a filesystem create that returns after storage initialization admission closes', bounded, async () => {
  const pauseCreate = gate();
  const fixture = await filesystemFixture({ pauseCreate });
  const owner = fixture.backend.reserve(request('read_only'), { kind: 'in_process' });
  let stopping: Promise<void> | undefined;
  const startup = owner.start().then(() => 'ready', () => 'failed');
  try {
    await fixture.creating.promise;
    let stopped = false;
    stopping = owner.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(owner.recoveryRecord.resources.find(({ role }) => role === 'filesystem')?.identity.kind, 'creating');
    pauseCreate.resolve();
    assert.equal(await startup, 'failed');
    await stopping;
    assert.equal(fixture.containers.size, 0);
    assert.equal(fixture.volumes.size, 1);
    assert.equal(fixture.requests.filter(({ path }) => path.endsWith('/start') || path.endsWith('/attach')).length, 0);
    await owner.destroy();
    assert.equal(fixture.volumes.size, 0);
  } finally { pauseCreate.resolve(); await startup; await stopping?.catch(() => {}); await owner.destroy(); await fixture.close(); }
});

test('an unrepresentable native child name rejects its listing without retiring valid read authority', bounded, async () => {
  const fixture = await filesystemFixture({ listErrno: 84 });
  const owner = fixture.backend.reserve(request('read_only'), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    if (sandbox.files.kind === 'disabled') throw new Error('Missing live read authority.');
    assert.deepEqual(await sandbox.files.list('.', async () => { throw new Error('Invalid child names must not reach the consumer.'); }),
      { kind: 'rejected', reason: 'path_resolution', entries: 0n });
    assert.deepEqual(await sandbox.files.stat('.'), { kind: 'completed', entry: {
      path: '.', kind: 'directory', byteLength: 0, permissions: 0o700 } });
    assert.deepEqual(sandbox.state, { kind: 'ready' });
  } finally { await owner.destroy(); await fixture.close(); }
});

test('restricted egress and live files share exactly eight owned roles through stop and cleanup-only reconciliation', bounded, async () => {
  const fixture = await filesystemFixture({ combined: true });
  const input = parseSandboxRequest({ policy: { ...request('read_write').policy,
    network: { kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] } } });
  const owner = fixture.backend.reserve(input, { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    assert.deepEqual(sandbox.recoveryRecord.resources.map(({ role }) => role),
      ['compute', 'storage', 'export', 'network', 'egress_socket', 'egress_broker', 'egress_relay', 'filesystem']);
    assert.equal(sandbox.files.kind, 'read_write');
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
      { containers: 5, volumes: 2, networks: 1 });
    await sandbox.stop();
    assert.deepEqual([...fixture.containers.values()].map((container) => ({ name: container.Name.split('-').at(-1), running: container.State.Running })),
      [{ name: 'export', running: false }]);
    const acquired = fixture.effects.filter(({ method }) => method === 'POST').length;
    const recovered = await fixture.backend.reconcile(sandbox.recoveryRecord);
    assert.equal(recovered.kind, 'matched');
    if (recovered.kind !== 'matched') throw new Error('Expected retained storage cleanup ownership.');
    await recovered.owner.destroy(); await recovered.owner.destroy();
    await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size, networks: fixture.networks.size },
      { containers: 0, volumes: 0, networks: 0 });
    assert.equal(fixture.effects.filter(({ method }) => method === 'POST').length, acquired);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('stop aborts an entered native read, removes its helper and joins the callback before final export', bounded, async () => {
  const holdNext = gate();
  const fixture = await filesystemFixture({ holdNext });
  const owner = fixture.backend.reserve(request('read_only'), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    await sandbox.importTree([fileFromBytes('held.txt', Buffer.from('settled-before-export'))]);
    if (sandbox.files.kind === 'disabled') throw new Error('Missing live read authority.');
    let callbackSettled = false;
    const reading = sandbox.files.readFile('held.txt', async ({ chunks }) => {
      try { for await (const _part of chunks) throw new Error('Held response must not arrive after stop.'); }
      finally { callbackSettled = true; }
    });
    await fixture.nextEntered.promise;
    await sandbox.stop();
    const result = await reading;
    assert.equal(result.kind, 'cancelled'); assert.equal(result.bytes, 0n);
    assert.equal(callbackSettled, true);
    assert.equal([...fixture.containers.values()].filter((container) => container.State.Running).length, 0);
    assert.equal(sandbox.recoveryRecord.phase, 'stopped');
    assert.throws(() => sandbox.files.kind !== 'disabled' && sandbox.files.stat('held.txt'), SandboxStateError);
    holdNext.resolve();
    await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { holdNext.resolve(); await owner.destroy(); await fixture.close(); }
});

test('a lost publication acknowledgement preserves actual bytes, fences new writes and never replays commit', bounded, async () => {
  const fixture = await filesystemFixture({ loseCommitReply: true });
  const owner = fixture.backend.reserve(request('read_write'), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    if (sandbox.files.kind !== 'read_write') throw new Error('Missing live write authority.');
    const result = await sandbox.files.writeFile('published.txt', [Buffer.from('published-once')], { mode: 'create' });
    await fixture.committed.promise;
    assert(result.kind === 'uncertain' || result.kind === 'cancelled');
    assert.equal(result.effect, 'unknown');
    assert.equal(fixture.tree.get('/workspace/work/published.txt')?.bytes.toString(), 'published-once');
    assert.equal(fixture.commands.filter(({ operation }) => operation === 7).length, 1);
    assert.throws(() => sandbox.files.kind === 'read_write'
      && sandbox.files.writeFile('published.txt', [Buffer.from('replayed')], { mode: 'replace' }), SandboxStateError);
    await sandbox.stop(); await sandbox.destroy();
    assert.deepEqual({ containers: fixture.containers.size, volumes: fixture.volumes.size }, { containers: 0, volumes: 0 });
  } finally { await owner.destroy(); await fixture.close(); }
});
