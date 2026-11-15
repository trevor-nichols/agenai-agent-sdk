import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pack, type Header } from 'tar-stream';
import { DockerImageInspectionError, inspectDockerImageFiles } from '../src/node/index.js';
import type { DockerImageInspectionOptions } from '../src/node/index.js';

const imageDigest = `sha256:${'7'.repeat(64)}`;
const id = '1'.repeat(64);
const daemonId = 'inspection-test-original';
const desktop = process.platform === 'darwin';
const profile = desktop ? 'desktop-apple-virtualization-native-arm64' : 'linux-x64';
const architecture = desktop ? 'arm64' : 'amd64';
const limits = { maxFiles: 32, maxMembers: 64, maxBytes: 16 * 1024 ** 2, maxArchiveBytes: 20 * 1024 ** 2, timeoutMs: 2000 };
type Node = { kind: 'directory' | 'file' | 'symlink'; mode: number; uid?: number; gid?: number; bytes?: Uint8Array; target?: string };
type Container = { Id: string; Name: string; Created: string; Image: string; Config: { Image: string; Labels: Record<string, string> };
  State: { Running: boolean; Status: string }; Mounts: unknown[] };

async function archive(entries: readonly (Partial<Header> & { name: string; bytes?: Uint8Array })[]): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => { for await (const chunk of tar) { assert(chunk instanceof Uint8Array); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks); })();
  for (const { bytes, ...header } of entries) tar.entry({ mode: 0o644, uid: 0, gid: 0, ...header }, bytes ?? new Uint8Array());
  tar.finalize();
  return collected;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agenai-image-inspect-'));
  const socketPath = join(directory, 'engine.sock');
  const sockets = new Set<Socket>();
  const tree = new Map<string, Node>([
    ['/', { kind: 'directory', mode: 0o755 }], ['/opt', { kind: 'directory', mode: 0o755 }],
    ['/opt/control', { kind: 'directory', mode: 0o755 }], ['/opt/control/tool', { kind: 'file', mode: 0o111, bytes: Buffer.from('native-binary') }],
    ['/opt/control/config', { kind: 'file', mode: 0o640, uid: 12, gid: 34, bytes: Buffer.from('fixed configuration\n') }],
    ['/opt/control/link', { kind: 'symlink', mode: 0o777, target: '/home/sandbox/state' }],
    ['/opt/control/empty', { kind: 'directory', mode: 0o755 }],
  ]);
  const state = { daemonId, imageArchitecture: architecture, imageVolumes: false, container: undefined as Container | undefined,
    original: undefined as Container | undefined, creates: 0, deletes: 0, starts: 0, createReply: 'normal' as 'normal' | 'lost' | 'lost_absent',
    deleteFails: false, deletePause: undefined as Promise<void> | undefined, deleteEntered: Promise.withResolvers<void>(),
    archiveOverride: undefined as ((path: string, response: ServerResponse) => Promise<boolean>) | undefined,
    inspectOverride: undefined as ((value: Container) => Container) | undefined,
    observed: [] as Array<{ method: string; path: string }>, prefixClosed: 0 };
  const errors: unknown[] = [];
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    state.observed.push({ method, path: request.url ?? '' });
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path === '/version') return json(200, { ApiVersion: '1.52', MinAPIVersion: '1.44', Os: 'linux', Arch: architecture });
    if (path === '/info') return json(200, { ID: state.daemonId, OSType: 'linux', Architecture: architecture,
      OperatingSystem: desktop ? 'Docker Desktop' : 'fixture-linux', CgroupVersion: '2', CgroupDriver: desktop ? 'cgroupfs' : 'systemd',
      SecurityOptions: [...(desktop ? [] : ['name=apparmor']), 'name=seccomp,profile=builtin', 'name=cgroupns'],
      MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true });
    if (path === `/v1.52/images/${imageDigest}/json`) return json(200, { Id: imageDigest, Os: 'linux', Architecture: state.imageArchitecture,
      Config: { Env: [], Entrypoint: ['/image/default'], Cmd: ['argument'], User: '65534:65534', WorkingDir: '/workspace/work',
        Labels: { source: 'independent-fixture' }, Volumes: state.imageVolumes ? { '/hidden': {} } : null } });
    if (path === '/v1.52/containers/create' && method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      assert(body && typeof body === 'object' && 'Labels' in body && 'Image' in body);
      assert.equal(url.searchParams.get('platform'), `linux/${architecture}`);
      const labels = body.Labels;
      assert(labels && typeof labels === 'object' && Object.values(labels).every((value) => typeof value === 'string'));
      const parsedLabels: Record<string, string> = {};
      for (const [key, value] of Object.entries(labels)) { assert.equal(typeof value, 'string'); parsedLabels[key] = String(value); }
      state.creates += 1;
      state.original = { Id: id, Name: `/${url.searchParams.get('name')}`, Created: '2026-11-11T00:00:00Z', Image: String(body.Image),
        Config: { Image: String(body.Image), Labels: parsedLabels }, State: { Running: false, Status: 'created' }, Mounts: [] };
      state.container = state.createReply === 'lost_absent' ? undefined : structuredClone(state.original);
      if (state.createReply !== 'normal') { response.destroy(); return; }
      return json(201, { Id: id, Warnings: [] });
    }
    const match = /^\/v1\.52\/containers\/([^/]+)(?:\/(json|archive|start))?$/u.exec(path);
    if (match) {
      const reference = decodeURIComponent(match[1]);
      const container = state.container;
      if (!container || reference !== id && reference !== container.Name.slice(1)) return json(404, {});
      if (match[2] === 'json') return json(200, state.inspectOverride?.(container) ?? container);
      if (match[2] === 'start') { state.starts += 1; return json(204, null); }
      if (method === 'DELETE') {
        state.deletes += 1; state.deleteEntered.resolve();
        await state.deletePause;
        if (state.deleteFails) return json(500, { message: 'retained failure' });
        state.container = undefined; return json(204, null);
      }
      if (match[2] === 'archive') {
        const selected = url.searchParams.get('path') ?? '';
        const node = tree.get(selected);
        if (!node) { response.writeHead(404); response.end(); return; }
        const mode = node.mode & 0o777 | (node.mode & 0o4000 ? 0x0080_0000 : 0) | (node.mode & 0o2000 ? 0x0040_0000 : 0)
          | (node.mode & 0o1000 ? 0x0010_0000 : 0) | (node.kind === 'directory' ? 0x8000_0000 : node.kind === 'symlink' ? 0x0800_0000 : 0);
        response.setHeader('x-docker-container-path-stat', Buffer.from(JSON.stringify({ name: selected === '/' ? '/' : basename(selected),
          size: node.bytes?.length ?? 0, mode: mode >>> 0, mtime: '2026-11-11T00:00:00Z',
          linkTarget: node.kind === 'symlink' ? posix.resolve(posix.dirname(selected), node.target ?? '') : '' })).toString('base64'));
        if (method === 'HEAD') { response.writeHead(200); response.end(); return; }
        if (await state.archiveOverride?.(selected, response)) return;
        response.writeHead(200, { 'content-type': 'application/x-tar' });
        const tar = pack();
        response.once('close', () => { if (!response.writableFinished) state.prefixClosed += 1; tar.destroy(); });
        tar.on('error', () => {});
        tar.pipe(response);
        for (const [entryPath, entry] of tree) {
          if (entryPath !== selected && (node.kind !== 'directory' || !entryPath.startsWith(selected === '/' ? '/' : `${selected}/`))) continue;
          const name = entryPath === selected ? selected === '/' ? '.' : basename(selected)
            : selected === '/' ? entryPath.slice(1) : `${basename(selected)}${entryPath.slice(selected.length)}`;
          tar.entry({ name, type: entry.kind === 'file' ? 'file' : entry.kind, mode: entry.mode,
            uid: entry.uid ?? 0, gid: entry.gid ?? 0, ...(entry.kind === 'symlink' ? { linkname: entry.target } : {}) }, entry.bytes ?? new Uint8Array());
        }
        tar.finalize();
        return;
      }
    }
    throw new Error(`Unexpected Engine fixture request ${method} ${path}`);
  })().catch((error: unknown) => { errors.push(error); if (!response.destroyed) { response.writeHead(500); response.end(); } }); });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const options: DockerImageInspectionOptions = { endpoint: `unix://${socketPath}`, imageDigest, profile,
    selections: [{ path: '/opt/control/tool', kind: 'file' }], limits };
  return { state, tree, options };
}

async function inspectionError(operation: Promise<unknown>): Promise<DockerImageInspectionError> {
  try { await operation; assert.fail('Image admission unexpectedly succeeded.'); }
  catch (error) { assert(error instanceof DockerImageInspectionError); return error; }
}

function causes(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message} ${error.errors.map(causes).join(' ')}`;
  return error instanceof Error ? `${error.message} ${error.cause === undefined ? '' : causes(error.cause)}` : String(error);
}

test('observes actual image configuration, owners, modes, hashes, literal links, empty roots and absences only after cleanup', async (t) => {
  const { state, options } = await fixture(t);
  const release = Promise.withResolvers<void>();
  state.deletePause = release.promise;
  let settled = false;
  const pending = inspectDockerImageFiles({ ...options, selections: [
    { path: '/opt/control/tool', kind: 'file' }, { path: '/opt/control/config', kind: 'file' },
    { path: '/opt/control/link', kind: 'symlink' }, { path: '/opt/control/empty', kind: 'directory', recursive: true },
    { path: '/opt/control/missing', kind: 'absent' },
  ] }).finally(() => { settled = true; });
  await state.deleteEntered.promise;
  assert.equal(settled, false);
  assert(state.container);
  release.resolve();
  const result = await pending;
  assert.equal(state.container, undefined);
  assert.equal(state.creates, 1); assert.equal(state.deletes, 1); assert.equal(state.starts, 0);
  assert.match(state.original?.Name ?? '', /^\/agenai-image-inspection-[a-f0-9-]{36}$/u);
  assert.equal(result.endpoint, options.endpoint); assert.equal(result.imageDigest, imageDigest);
  assert.equal(result.daemonId, daemonId); assert.equal(result.platform, `linux/${architecture}`);
  assert.deepEqual(result.imageConfig, { env: [], entrypoint: ['/image/default'], cmd: ['argument'], user: '65534:65534',
    workingDirectory: '/workspace/work', labels: { source: 'independent-fixture' } });
  assert.deepEqual(result.entries, [
    { path: '/', mode: 0o755, uid: 0, gid: 0, kind: 'directory' },
    { path: '/opt', mode: 0o755, uid: 0, gid: 0, kind: 'directory' },
    { path: '/opt/control', mode: 0o755, uid: 0, gid: 0, kind: 'directory' },
    { path: '/opt/control/tool', mode: 0o111, uid: 0, gid: 0, kind: 'file', size: 13, sha256: createHash('sha256').update('native-binary').digest('hex') },
    { path: '/opt/control/config', mode: 0o640, uid: 12, gid: 34, kind: 'file', size: 20, sha256: createHash('sha256').update('fixed configuration\n').digest('hex') },
    { path: '/opt/control/link', mode: 0o777, uid: 0, gid: 0, kind: 'symlink', target: '/home/sandbox/state' },
    { path: '/opt/control/empty', mode: 0o755, uid: 0, gid: 0, kind: 'directory' },
  ]);
  assert.deepEqual(result.absences, ['/opt/control/missing']);
  assert(Object.isFrozen(result.entries)); assert(Object.isFrozen(result.imageConfig.env));
});

test('hashes an executable larger than the JSON response bound through the real streaming Engine route', async (t) => {
  const { tree, options, state } = await fixture(t);
  const bytes = Buffer.alloc(8 * 1024 ** 2, 0x53);
  tree.set('/opt/control/tool', { kind: 'file', mode: 0o111, bytes });
  const result = await inspectDockerImageFiles(options);
  assert.deepEqual(result.entries.at(-1), { path: '/opt/control/tool', mode: 0o111, uid: 0, gid: 0, kind: 'file',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  assert(state.prefixClosed > 0, 'Ancestor archives terminate their recursive suffix before EOF.');
  assert.equal(state.container, undefined);
});

test('image root stat tolerates Docker mount timestamp changes while preserving root mode and non-root timestamp checks', async (t) => {
  for (const kind of ['root_mtime', 'root_mode', 'non_root_mtime'] as const) await t.test(kind, async (t) => {
    const { state, options } = await fixture(t);
    state.archiveOverride = async (path, response) => {
      if (path !== (kind === 'non_root_mtime' ? '/opt' : '/')) return false;
      const header = response.getHeader('x-docker-container-path-stat');
      assert.equal(typeof header, 'string');
      assert(typeof header === 'string');
      const stat: unknown = JSON.parse(Buffer.from(header, 'base64').toString());
      assert(stat !== null && typeof stat === 'object');
      response.setHeader('x-docker-container-path-stat', Buffer.from(JSON.stringify({ ...stat,
        ...(kind === 'root_mode' ? { mode: (0x8000_0000 | 0o777) >>> 0 } : { mtime: '2026-11-11T00:00:00.004Z' }),
      })).toString('base64'));
      return false;
    };
    const operation = inspectDockerImageFiles({ ...options, selections: [{ path: '/opt', kind: 'directory' }] });
    if (kind === 'root_mtime') {
      const result = await operation;
      assert.deepEqual(result.entries, [
        { path: '/', mode: 0o755, uid: 0, gid: 0, kind: 'directory' },
        { path: '/opt', mode: 0o755, uid: 0, gid: 0, kind: 'directory' },
      ]);
    } else {
      const error = await inspectionError(operation);
      assert.match(causes(error), /selected path metadata changed/u);
      assert.equal(error.cleanup, undefined);
    }
    assert.equal(state.container, undefined); assert.equal(state.creates, 1); assert.equal(state.deletes, 1);
  });
});

test('rejects unqualified images and invalid boundary input before acquiring any inspection resource', async (t) => {
  const { state, options } = await fixture(t);
  state.imageVolumes = true;
  await inspectionError(inspectDockerImageFiles(options));
  state.imageVolumes = false; state.imageArchitecture = architecture === 'amd64' ? 'arm64' : 'amd64';
  await inspectionError(inspectDockerImageFiles(options));
  for (const path of ['/opt/../tool', '//opt/tool', '/opt/tool/', '/opt/./tool']) {
    await assert.rejects(inspectDockerImageFiles({ ...options, selections: [{ path, kind: 'file' }] }));
  }
  let getterCalls = 0;
  const invalidInput = { ...options, get selections() { getterCalls += 1; return options.selections; } };
  await assert.rejects(inspectDockerImageFiles(invalidInput), /accessors/u);
  assert.equal(getterCalls, 0); assert.equal(state.creates, 0);
});

test('required absences and artifacts cannot pass through missing or symbolic-link directory ancestors', async (t) => {
  for (const kind of ['missing', 'symlink', 'present_absence'] as const) await t.test(kind, async (t) => {
    const { tree, options, state } = await fixture(t);
    if (kind === 'missing') tree.delete('/opt');
    if (kind === 'symlink') tree.set('/opt', { kind: 'symlink', mode: 0o777, target: '/elsewhere' });
    const error = await inspectionError(inspectDockerImageFiles({ ...options,
      selections: [{ path: kind === 'present_absence' ? '/opt/control/tool' : '/opt/control/missing', kind: 'absent' }] }));
    assert.equal(error.cleanup, undefined); assert.equal(state.container, undefined); assert.equal(state.deletes, 1);
    if (kind !== 'present_absence') assert(!state.observed.some((request) => request.path.includes('path=%2Fopt%2Fcontrol')));
  });
});

test('archive confinement, duplicates, hardlinks, truncation and cumulative limits fence admission and still settle cleanup', async (t) => {
  const cases = ['escape', 'duplicate', 'hardlink', 'truncated', 'prefix_wrong_root', 'prefix_wrong_kind', 'prefix_pax_link', 'prefix_pax_excess', 'files', 'members', 'bytes', 'wire'] as const;
  for (const kind of cases) await t.test(kind, async (t) => {
    const { state, options } = await fixture(t);
    state.archiveOverride = async (path, response) => {
      if (path === '/opt' && (kind === 'prefix_wrong_root' || kind === 'prefix_wrong_kind')) {
        response.writeHead(200); response.end(await archive([{ name: kind === 'prefix_wrong_root' ? 'elsewhere' : 'opt',
          type: kind === 'prefix_wrong_kind' ? 'file' : 'directory', mode: 0o755 }])); return true;
      }
      if (path === '/opt' && (kind === 'prefix_pax_link' || kind === 'prefix_pax_excess')) {
        response.writeHead(200); response.end(await archive([{ name: 'opt', type: 'directory', mode: 0o755,
          pax: kind === 'prefix_pax_link' ? { linkpath: '/other' } : { mtime: '0'.repeat(16_384) } }])); return true;
      }
      if (kind.startsWith('prefix_')) return false;
      if (path !== '/opt/control/tool' || ['files', 'members', 'bytes', 'wire'].includes(kind)) return false;
      const normal = { name: 'tool', mode: 0o111, bytes: Buffer.from('native-binary') };
      let tar = await archive(kind === 'escape' ? [{ ...normal, name: '../tool' }]
        : kind === 'duplicate' ? [normal, normal]
        : kind === 'hardlink' ? [{ name: 'tool', type: 'link', linkname: 'elsewhere', mode: 0o111 }] : [normal]);
      if (kind === 'truncated') tar = tar.subarray(0, 518);
      response.writeHead(200); response.end(tar); return true;
    };
    const selectedLimits = { ...limits, ...(kind === 'files' ? { maxFiles: 0 } : kind === 'members' ? { maxMembers: 1 }
      : kind === 'bytes' ? { maxBytes: 1 } : kind === 'wire' ? { maxArchiveBytes: 511 } : {}) };
    const error = await inspectionError(inspectDockerImageFiles({ ...options, limits: selectedLimits }));
    assert.equal(error.cleanup, undefined); assert.equal(state.container, undefined); assert.equal(state.deletes, 1);
    const expected = kind === 'escape' ? /canonical relative paths/u : kind === 'duplicate' ? /duplicate member/u
      : kind === 'hardlink' ? /hardlinks and special files/u : kind === 'truncated' ? /unexpected EOF/u
      : kind === 'prefix_wrong_root' || kind === 'prefix_wrong_kind' ? /exact requested root/u
      : kind === 'prefix_pax_link' ? /PAX metadata contains a link target/u : kind === 'prefix_pax_excess' ? /excessive PAX bytes/u
      : kind === 'wire' ? /wire byte quota/u : /cumulative file, member, payload/u;
    assert.match(causes(error), expected);
  });
});

test('directory prefix metadata applies one bounded local PAX root override without trusting fallback names', async (t) => {
  const { state, options } = await fixture(t);
  state.archiveOverride = async (path, response) => {
    if (path !== '/opt') return false;
    const bytes = await archive([{ name: 'opt', type: 'directory', mode: 0o755, uid: 42, gid: 43, pax: { mtime: '0' } }]);
    const following = bytes.subarray(1024, 1536);
    following.fill(0, 0, 100); following.write('fallback', 0, 'utf8');
    following.fill(32, 148, 156);
    following.write(`${following.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    response.writeHead(200); response.end(bytes); return true;
  };
  const result = await inspectDockerImageFiles({ ...options, selections: [{ path: '/opt', kind: 'directory' }] });
  assert.deepEqual(result.entries.at(-1), { path: '/opt', mode: 0o755, uid: 42, gid: 43, kind: 'directory' });
  assert.equal(state.container, undefined); assert.equal(state.deletes, 1);
});

test('recursive directory census preserves descendants and refuses members beneath a symbolic-link parent', async (t) => {
  const { state, tree, options } = await fixture(t);
  tree.set('/opt/control/empty/child', { kind: 'file', mode: 0o444, bytes: Buffer.from('child') });
  const observed = await inspectDockerImageFiles({ ...options, selections: [{ path: '/opt/control/empty', kind: 'directory', recursive: true }] });
  assert.deepEqual(observed.entries.at(-1), { path: '/opt/control/empty/child', mode: 0o444, uid: 0, gid: 0,
    kind: 'file', size: 5, sha256: 'ddc9e669194254cef019a29d3619a2c16592e5d52e1a81e98b01bd52319149a3' });
  state.archiveOverride = async (path, response) => {
    if (path !== '/opt/control/empty') return false;
    response.writeHead(200); response.end(await archive([
      { name: 'empty', type: 'directory', mode: 0o755 },
      { name: 'empty/alias', type: 'symlink', linkname: '/other' },
      { name: 'empty/alias/child', bytes: Buffer.from('escaped') },
    ])); return true;
  };
  const error = await inspectionError(inspectDockerImageFiles({ ...options, selections: [{ path: '/opt/control/empty', kind: 'directory', recursive: true }] }));
  assert.equal(error.cleanup, undefined); assert.equal(state.container, undefined);
});

test('unknown create is never replayed and transient name absence preserves an actionable original cleanup owner', async (t) => {
  const { state, options } = await fixture(t);
  state.createReply = 'lost_absent';
  const error = await inspectionError(inspectDockerImageFiles(options));
  assert(error.cleanup);
  assert.equal(error.cleanup.identity.endpoint, options.endpoint);
  assert.equal(error.cleanup.identity.daemonId, daemonId);
  assert.equal(error.cleanup.identity.name, state.original?.Name.slice(1));
  await assert.rejects(error.cleanup.retryCleanup(), /absent inspection name/u);
  assert.equal(state.creates, 1); assert.equal(state.deletes, 0);
  state.container = structuredClone(state.original);
  await error.cleanup.retryCleanup();
  await error.cleanup.retryCleanup();
  assert.equal(state.container, undefined); assert.equal(state.creates, 1); assert.equal(state.deletes, 1);
});

test('a lost create acknowledgement cleans the matching late original container while withholding observations', async (t) => {
  const { state, options } = await fixture(t);
  state.createReply = 'lost';
  const error = await inspectionError(inspectDockerImageFiles(options));
  assert.equal(error.cleanup, undefined); assert.equal(state.container, undefined); assert.equal(state.creates, 1); assert.equal(state.deletes, 1);
});

test('cleanup failure retains one shared retry operation and never deletes a replaced resource or another daemon', async (t) => {
  for (const kind of ['deletion', 'name', 'labels', 'id', 'daemon'] as const) await t.test(kind, async (t) => {
    const { state, options } = await fixture(t);
    if (kind === 'deletion') state.deleteFails = true;
    if (kind === 'name') state.inspectOverride = (value) => ({ ...value, Name: '/unrelated' });
    if (kind === 'labels') state.inspectOverride = (value) => ({ ...value, Config: { ...value.Config, Labels: {} } });
    if (kind === 'id') state.inspectOverride = (value) => ({ ...value, Id: '2'.repeat(64) });
    if (kind === 'daemon') state.archiveOverride = async (path) => { if (path === '/opt/control/tool') state.daemonId = 'replacement'; return false; };
    const error = await inspectionError(inspectDockerImageFiles(options));
    assert(error.cleanup); assert(state.container);
    assert.equal(state.deletes, kind === 'deletion' ? 1 : 0);
    state.deleteFails = false; state.inspectOverride = undefined; state.daemonId = daemonId;
    const release = Promise.withResolvers<void>(); state.deletePause = release.promise;
    const first = error.cleanup.retryCleanup(); const second = error.cleanup.retryCleanup();
    assert.equal(first, second);
    release.resolve(); await first;
    assert.equal(state.container, undefined); assert.equal(state.creates, 1);
  });
});

test('deadline closes an entered archive before original cleanup settles and never returns partial hashes', { timeout: 3000 }, async (t) => {
  const { state, options } = await fixture(t);
  const closed = Promise.withResolvers<void>();
  state.archiveOverride = async (path, response) => {
    if (path !== '/opt/control/tool') return false;
    response.writeHead(200); response.flushHeaders();
    response.once('close', () => closed.resolve());
    return true;
  };
  const error = await inspectionError(inspectDockerImageFiles({ ...options, limits: { ...limits, timeoutMs: 150 } }));
  await closed.promise;
  assert.equal(error.cleanup, undefined); assert.equal(state.container, undefined); assert.equal(state.creates, 1); assert.equal(state.deletes, 1);
});
