// ------------------------------------------------------------------------------------------------
//                workspace.test.ts - Public streaming workspace ownership - Real Unix Engine fixtures
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { pack, type Header } from 'tar-stream';
import { SandboxOperationError, SandboxStartError, SandboxValidationError, type SandboxTreeSelection } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '../src/index.js';
import { engineFixture, imageDigest, sandboxRequest } from './fixtures/engine.js';
import { exportFixtures, inputFiles } from './fixtures/trees.js';

test('public import streams caller trees, owns implied parents, and reports logical counts plus complete wire bytes', async () => {
  const fixture = await engineFixture();
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    const summary = await sandbox.importTree([
      { kind: 'directory', path: 'empty' },
      ...inputFiles([{ path: 'nested/a.bin', bytes: Uint8Array.of(0, 255, 10), executable: false },
        { path: 'bin/run', bytes: Buffer.from('#!'), executable: true }]),
    ]);
    assert.deepEqual(summary, { files: 2n, directories: 1n, symlinks: 0n, payloadBytes: 5n, archiveBytes: BigInt(fixture.uploadedArchives[1].length) });
    assert.deepEqual([...fixture.tree.entries()].map(([path, entry]) => [path, entry.header.type, entry.header.uid, entry.header.gid, entry.header.mode]), [
      ['/workspace', 'directory', undefined, undefined, 0o755],
      ['/workspace/work', 'directory', 65534, 65534, 0o700],
      ['/workspace/work/empty', 'directory', 65534, 65534, 0o700],
      ['/workspace/work/nested', 'directory', 65534, 65534, 0o700],
      ['/workspace/work/nested/a.bin', 'file', 65534, 65534, 0o600],
      ['/workspace/work/bin', 'directory', 65534, 65534, 0o700],
      ['/workspace/work/bin/run', 'file', 65534, 65534, 0o700],
    ]);
    await sandbox.stop();
    const files = await exportFixtures(sandbox, ['bin/run', 'nested/a.bin']);
    assert.deepEqual(files, [
      { path: 'bin/run', executable: true, bytes: Buffer.from('#!') },
      { path: 'nested/a.bin', executable: false, bytes: Buffer.from([0, 255, 10]) },
    ]);
    const targets = fixture.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/archive')).map((request) => new URL(request.target, 'http://fixture').searchParams.get('path'));
    assert.deepEqual(targets, ['/workspace/work/bin/run', '/workspace/work/nested/a.bin']);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('exact file export ignores unrelated symlinks while explicit whole-workspace export validates every entry', async () => {
  const fixture = await engineFixture();
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    await sandbox.importTree(inputFiles([{ path: 'safe.txt', bytes: Buffer.from('safe'), executable: false }]));
    fixture.tree.set('/workspace/work/unsafe', { header: { name: 'unsafe', type: 'symlink', linkname: '/etc/passwd', mode: 0o777 }, bytes: new Uint8Array() });
    await sandbox.stop();
    assert.deepEqual(await exportFixtures(sandbox, ['safe.txt']), [{ path: 'safe.txt', executable: false, bytes: Buffer.from('safe') }]);
    await assert.rejects(sandbox.exportTree({ kind: 'workspace' }, async (entry) => { if (entry.kind === 'file') for await (const _chunk of entry.bytes) { /* Drain provisional bytes. */ } }), /regular|links/);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('subtree export preserves its workspace-relative root and fetches only that checked directory', async () => {
  const fixture = await engineFixture();
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    await sandbox.importTree([
      { kind: 'directory', path: 'reports/selected/empty' },
      ...inputFiles([
        { path: 'reports/selected/bin/run', bytes: Uint8Array.of(0, 255, 10), executable: true },
        { path: 'reports/selected/zero', bytes: new Uint8Array(), executable: false },
        { path: 'reports/selected-other/ignore', bytes: Buffer.from('unrelated'), executable: false },
      ]),
    ]);
    fixture.tree.set('/workspace/work/reports/unrelated-link', {
      header: { name: 'unrelated-link', type: 'symlink', linkname: '/etc/passwd', mode: 0o777 }, bytes: new Uint8Array(),
    });
    await sandbox.stop();
    const directories: string[] = [];
    const files: Array<{ path: string; executable: boolean; bytes: number[] }> = [];
    const summary = await sandbox.exportTree({ kind: 'subtree', path: 'reports/selected' }, async (entry) => {
      if (entry.kind === 'directory') directories.push(entry.path);
      else if (entry.kind === 'file') {
        const bytes: number[] = [];
        for await (const chunk of entry.bytes) bytes.push(...chunk);
        files.push({ path: entry.path, executable: entry.executable, bytes });
      }
    });
    assert.deepEqual(directories.sort(), ['reports/selected', 'reports/selected/bin', 'reports/selected/empty']);
    assert.deepEqual(files, [
      { path: 'reports/selected/bin/run', executable: true, bytes: [0, 255, 10] },
      { path: 'reports/selected/zero', executable: false, bytes: [] },
    ]);
    assert.equal(summary.files, 2n);
    assert.equal(summary.directories, 3n);
    assert.equal(summary.payloadBytes, 3n);
    assert.deepEqual(fixture.requests.filter((request) => request.path.endsWith('/archive') && request.method !== 'PUT')
      .map((request) => [request.method, new URL(request.target, 'http://fixture').searchParams.get('path')]), [
      ['HEAD', '/workspace'], ['HEAD', '/workspace/work'], ['HEAD', '/workspace/work/reports'],
      ['HEAD', '/workspace/work/reports/selected'], ['GET', '/workspace/work/reports/selected'],
    ]);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('preserving imports check emptiness, emit links last and export raw targets without enabling file dereference', async () => {
  const fixture = await engineFixture();
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    const summary = await sandbox.importTree([
      { kind: 'symlink', path: 'aliases/current', target: '../bin/run' },
      ...inputFiles([{ path: 'bin/run', bytes: Uint8Array.of(0, 255, 10), executable: true }]),
      { kind: 'directory', path: 'empty' },
    ], { symlinks: 'preserve_internal' });
    assert.deepEqual(summary, { files: 1n, directories: 1n, symlinks: 1n, payloadBytes: 3n, archiveBytes: BigInt(fixture.uploadedArchives[1].length) });
    const order = [...fixture.tree.entries()].map(([path, entry]) => ({ path, type: entry.header.type }));
    assert.equal(order.at(-1)?.path, '/workspace/work/aliases/current');
    assert.equal(order.at(-1)?.type, 'symlink');
    assert.deepEqual(fixture.tree.get('/workspace/work/aliases/current')?.header.linkname, '../bin/run');
    assert.deepEqual(fixture.tree.get('/workspace/work/bin/run')?.bytes, Buffer.from([0, 255, 10]));
    assert.equal(fixture.requests.filter(({ method, target }) => method === 'GET'
      && new URL(target, 'http://fixture').searchParams.get('path') === '/workspace/work').length, 1);
    await sandbox.stop();
    const entries: unknown[] = [];
    const exported = await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
      if (entry.kind === 'symlink') entries.push({ kind: entry.kind, path: entry.path, target: entry.target });
      if (entry.kind === 'file') {
        const parts: Uint8Array[] = [];
        for await (const part of entry.bytes) parts.push(part);
        entries.push({ kind: entry.kind, path: entry.path, executable: entry.executable, bytes: [...Buffer.concat(parts)] });
      }
    }, { symlinks: 'preserve_internal' });
    assert.deepEqual(entries, [
      { kind: 'file', path: 'bin/run', executable: true, bytes: [0, 255, 10] },
      { kind: 'symlink', path: 'aliases/current', target: '../bin/run' },
    ]);
    assert.equal(exported.files, 1n); assert.equal(exported.symlinks, 1n); assert.equal(exported.payloadBytes, 3n);
    const before = fixture.requests.length;
    await assert.rejects(sandbox.exportTree({ kind: 'files', paths: ['aliases/current'] }, async () => assert.fail('Exact-file export followed a link.'),
      { symlinks: 'preserve_internal' }), /symlink/);
    assert.equal(fixture.requests.slice(before).filter(({ method, path }) => method === 'GET' && path.endsWith('/archive')).length, 0);
    await assert.rejects(sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
      if (entry.kind === 'file') for await (const _part of entry.bytes) { /* Provisional regular bytes precede default link rejection. */ }
    }), /symbolic links/);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('every preserving import rejects existing files or links before PUT or caller source entry', async (context) => {
  for (const kind of ['file', 'symlink'] as const) await context.test(kind, async () => {
    const fixture = await engineFixture();
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    try {
      const sandbox = await owner.start();
      if (kind === 'file') await sandbox.importTree(inputFiles([{ path: 'existing', bytes: Uint8Array.of(1), executable: false }]));
      else fixture.tree.set('/workspace/work/existing', { header: { name: 'existing', type: 'symlink', linkname: 'dangling', mode: 0o777 }, bytes: new Uint8Array() });
      const uploads = fixture.uploadedArchives.length;
      let entered = false;
      async function* source() { entered = true; yield { kind: 'symlink' as const, path: 'new-link', target: 'safe' }; }
      await assert.rejects(sandbox.importTree(source(), { symlinks: 'preserve_internal' }), /actually empty workspace/);
      assert.equal(entered, false);
      assert.equal(fixture.uploadedArchives.length, uploads);
    } finally { await owner.destroy(); await fixture.close(); }
  });
});

test('empty admission rejects a first non-root header without pulling its declared large file payload', { timeout: 10000 }, async () => {
  const archive = pack();
  archive.entry({ name: 'work/', type: 'directory', mode: 0o700 });
  archive.entry({ name: 'work/existing', type: 'file', mode: 0o600 }, new Uint8Array());
  archive.finalize();
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive) { assert(chunk instanceof Uint8Array); chunks.push(chunk); }
  const prefix = Buffer.concat(chunks).subarray(0, 1024);
  const fileHeader = prefix.subarray(512);
  fileHeader.write((1024 ** 3).toString(8).padStart(11, '0'), 124, 11, 'ascii');
  fileHeader.fill(32, 148, 156);
  fileHeader.write(`${fileHeader.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const fixture = await engineFixture({ async handleRequest({ method, path, request, response }) {
    if (method !== 'GET' || !path.endsWith('/archive') || new URL(request.url ?? '/', 'http://fixture').searchParams.get('path') !== '/workspace/work') return false;
    response.setHeader('x-docker-container-path-stat', Buffer.from(JSON.stringify({ name: 'work', size: 0,
      mode: 0x800001c0, mtime: '2026-10-24T00:00:00Z', linkTarget: '' })).toString('base64'));
    response.end(prefix);
    return true;
  } });
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    const uploads = fixture.uploadedArchives.length;
    await assert.rejects(sandbox.importTree([{ kind: 'symlink', path: 'new-link', target: 'file' }], { symlinks: 'preserve_internal' }), /actually empty workspace/);
    assert.equal(fixture.uploadedArchives.length, uploads);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('a workspace-confined link can reject under a subtree publication root', async () => {
  const fixture = await engineFixture();
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    await sandbox.importTree([{ kind: 'directory', path: 'reports/shared' }, { kind: 'directory', path: 'reports/selected' },
      { kind: 'symlink', path: 'reports/selected/near', target: '../shared' }], { symlinks: 'preserve_internal' });
    await sandbox.stop();
    const targets: string[] = [];
    await sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
      if (entry.kind === 'symlink') targets.push(entry.target);
    }, { symlinks: 'preserve_internal' });
    assert.deepEqual(targets, ['../shared']);
    await assert.rejects(sandbox.exportTree({ kind: 'subtree', path: 'reports/selected' }, async () => {},
      { symlinks: 'preserve_internal' }), (error) => error instanceof SandboxValidationError
        && error.issues.some((issue) => issue.message.includes('target escapes the selected publication root')));
  } finally { await owner.destroy(); await fixture.close(); }
});

test('selected subtree rejects mismatched roots and escaped or unsupported entries before exposing them', async (context) => {
  const root: Partial<Header> & Pick<Header, 'name'> = { name: 'selected/', type: 'directory', mode: 0o700 };
  const safe: Partial<Header> & Pick<Header, 'name'> = { name: 'selected/safe', type: 'file', mode: 0o600 };
  const cases: Array<{ name: string; entries: Array<Partial<Header> & Pick<Header, 'name'>>; exposed: string[] }> = [
    { name: 'prefix lookalike', entries: [root, safe, { ...safe, name: 'selected-other/secret' }], exposed: ['reports/selected', 'reports/selected/safe'] },
    { name: 'traversal', entries: [root, { ...safe, name: 'selected/../secret' }], exposed: ['reports/selected'] },
    { name: 'link', entries: [root, { ...safe, name: 'selected/link', type: 'symlink', linkname: '/etc/passwd' }], exposed: ['reports/selected'] },
    { name: 'duplicate root', entries: [root, root], exposed: ['reports/selected'] },
    { name: 'wrong root type', entries: [{ ...safe, name: 'selected' }], exposed: [] },
    { name: 'root mode mismatch', entries: [{ ...root, mode: 0o755 }], exposed: [] },
    { name: 'missing root', entries: [safe], exposed: ['reports/selected/safe'] },
  ];
  for (const row of cases) await context.test(row.name, async () => {
    const fixture = await engineFixture({ async handleRequest({ method, path, response }) {
      if (method !== 'GET' || !path.endsWith('/archive')) return false;
      response.setHeader('x-docker-container-path-stat', Buffer.from(JSON.stringify({ name: 'selected', size: 0,
        mode: 0x800001c0, mtime: '2026-10-24T00:00:00Z', linkTarget: '' })).toString('base64'));
      const archive = pack();
      for (const entry of row.entries) archive.entry(entry, new Uint8Array());
      archive.finalize();
      for await (const chunk of archive) response.write(chunk);
      response.end();
      return true;
    } });
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    try {
      const sandbox = await owner.start();
      await sandbox.importTree([{ kind: 'directory', path: 'reports/selected' }]);
      await sandbox.stop();
      const exposed: string[] = [];
      await assert.rejects(sandbox.exportTree({ kind: 'subtree', path: 'reports/selected' }, async (entry) => {
        exposed.push(entry.path);
        if (entry.kind === 'file') for await (const _chunk of entry.bytes) { /* All fixture bodies are empty. */ }
      }), (error) => error instanceof SandboxOperationError && error.code === 'driver_failure');
      assert.deepEqual(exposed, row.exposed);
    } finally { await owner.destroy(); await fixture.close(); }
  });
});

test('ancestor and final symlinks are rejected before selected GET, including both fixed roots', async (context) => {
  const selections: SandboxTreeSelection[] = [{ kind: 'files', paths: ['nested/result.bin'] }, { kind: 'subtree', path: 'nested' }];
  for (const selection of selections) {
    const paths = ['/workspace', '/workspace/work', '/workspace/work/nested',
      ...(selection.kind === 'files' ? ['/workspace/work/nested/result.bin'] : [])];
    for (const path of paths) await context.test(`${selection.kind} ${path}`, async () => {
      const fixture = await engineFixture();
      const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
      try {
        const sandbox = await owner.start();
        await sandbox.importTree(inputFiles([{ path: 'nested/result.bin', bytes: Buffer.from('owned'), executable: false }]));
        fixture.tree.set(path, { header: { name: 'link', type: 'symlink', linkname: '/etc/passwd', mode: 0o777 }, bytes: new Uint8Array() });
        await sandbox.stop();
        await assert.rejects(sandbox.exportTree(selection, async () => { assert.fail('Unsafe selection reached its consumer.'); }), /symlink/);
        assert.deepEqual(fixture.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/archive')), []);
        const heads = fixture.requests.filter((request) => request.method === 'HEAD').map((request) => new URL(request.target, 'http://fixture').searchParams.get('path'));
        assert.equal(heads.at(-1), path);
        assert(heads.every((target) => target !== null && !target.endsWith('/') && !target.endsWith('/.')));
      } finally { await owner.destroy(); await fixture.close(); }
    });
  }
});

test('export rechecks exact never-started accessor state and private storage before reading files', async () => {
  const fixture = await engineFixture();
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    await sandbox.stop();
    const accessor = [...fixture.containers.values()].find((container) => container.Name.endsWith('-export'));
    assert(accessor);
    accessor.State = { Running: false, Status: 'exited' };
    await assert.rejects(sandbox.exportTree({ kind: 'workspace' }, async () => {}), /readback/);
    assert.deepEqual(fixture.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/archive')), []);
    accessor.State = { Running: false, Status: 'created' };
  } finally { await owner.destroy(); await fixture.close(); }
});

test('spill-directory admission happens before daemon or resource effects', async () => {
  const fixture = await engineFixture();
  const backend = createDockerSandboxBackend({ endpoint: fixture.endpoint, namespace: 'missing-spill', imageDigest,
    spillDirectory: `${fixture.spillDirectory}/absent`, user: { uid: 65534, gid: 65534 } });
  const owner = backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    await assert.rejects(owner.start(), SandboxStartError);
    assert.deepEqual(fixture.requests, []);
    assert.deepEqual(fixture.effects, []);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('caller archive quota counts generated headers and exact-file logical quota rejects before consumer publication', async () => {
  const fixture = await engineFixture();
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  try {
    const sandbox = await owner.start();
    await sandbox.importTree(inputFiles([{ path: 'safe.txt', bytes: Buffer.from('safe'), executable: false }]));
    await sandbox.stop();
    let published = false;
    await assert.rejects(sandbox.exportTree({ kind: 'files', paths: ['safe.txt'] }, async () => { published = true; }, { quotas: { maxFileBytes: 3 } }),
      (error) => error instanceof SandboxOperationError && error.code === 'output_limit');
    assert.equal(published, false);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('wire quota rejects before opening a file whose archive headers do not fit', async () => {
  const fixture = await engineFixture();
  const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
  let opened = false;
  try {
    const sandbox = await owner.start();
    await assert.rejects(sandbox.importTree([{ kind: 'file', path: 'a', byteLength: 1, executable: false,
      open() { opened = true; return [Uint8Array.of(1)]; } }], { quotas: { maxArchiveBytes: 0 } }),
    (error) => error instanceof SandboxOperationError && error.code === 'input_limit');
    assert.equal(opened, false);
  } finally { await owner.destroy(); await fixture.close(); }
});

test('malformed or duplicate Docker stat headers fail before selected archive GET', async (context) => {
  for (const duplicate of [false, true]) await context.test(duplicate ? 'duplicate' : 'malformed', async () => {
    const encoded = Buffer.from(JSON.stringify({ name: 'workspace', size: 0, mode: 0x800001ed, mtime: '2026-10-24T00:00:00Z', linkTarget: '' })).toString('base64');
    const fixture = await engineFixture({ async handleRequest({ method, path, response }) {
      if (method !== 'HEAD' || !path.endsWith('/archive')) return false;
      response.setHeader('x-docker-container-path-stat', duplicate ? [encoded, encoded] : 'invalid,base64');
      response.end();
      return true;
    } });
    const owner = fixture.backend.reserve(sandboxRequest(), { kind: 'in_process' });
    try {
      const sandbox = await owner.start();
      await sandbox.stop();
      await assert.rejects(exportFixtures(sandbox, ['a']), /stat header/);
      assert.deepEqual(fixture.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/archive')), []);
    } finally { await owner.destroy(); await fixture.close(); }
  });
});
