import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseAgentInstanceId } from '@agen-ai/agent-protocol';
import { SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import { createDockerDesktopRouteAuthority, createDockerLinuxRouteAuthority, DockerImageInspectionError } from '@agen-ai/sandbox-docker/node';
import { prepareGrokDockerApprovalProfile, prepareGrokDockerProvider } from '../src/docker/index.js';
import type { GrokDockerBackendOptions, GrokDockerProviderOptions } from '../src/docker/index.js';

type File = { kind: 'file'; bytes: Uint8Array; mode: number } | { kind: 'directory'; mode: number }
  | { kind: 'symlink'; target: string; mode: number };
const uuid = 'af34fad3-2c0c-4295-9e57-0d54576fb494';
const imageDigest = `sha256:${'e'.repeat(64)}`;
const containerId = 'f'.repeat(64);
const desktop = process.platform === 'darwin';
const dockerProfile = desktop ? 'desktop-apple-virtualization-native-arm64' : 'linux-x64';
const architecture = desktop ? 'arm64' : 'amd64';

function tar(entries: readonly Readonly<{ name: string; file: File }>[]): Buffer {
  const parts: Uint8Array[] = [];
  for (const { name, file } of entries) {
    const header = Buffer.alloc(512);
    const number = (value: number, offset: number, length: number) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
    header.write(name, 0, 100, 'utf8'); number(file.mode, 100, 8); number(0, 108, 8); number(0, 116, 8);
    const bytes = file.kind === 'file' ? file.bytes : new Uint8Array();
    number(bytes.length, 124, 12); number(0, 136, 12); header.fill(0x20, 148, 156);
    header.write(file.kind === 'file' ? '0' : file.kind === 'directory' ? '5' : '2', 156, 1, 'ascii');
    if (file.kind === 'symlink') header.write(file.target, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agenai-grok-image-')));
  const socket = join(directory, 'engine.sock');
  const bootstrapBytes = Buffer.from('caller compiled helper');
  const profile = { instanceId: parseAgentInstanceId('image-unit-grok'), nativeSessionId: uuid,
    policy: 'provider_auto_review' as const,
    credentialBootstrap: { sha256: createHash('sha256').update(bootstrapBytes).digest('hex') } };
  const prepared = await prepareGrokDockerApprovalProfile({ directory: join(directory, 'context'), profile, dockerProfile,
    baseImageDigest: `sha256:${'b'.repeat(64)}` });
  const files = new Map<string, File>();
  const add = (path: string, file: File): void => {
    files.set(path, file);
    for (let parent = posix.dirname(path); !files.has(parent); parent = posix.dirname(parent)) files.set(parent, { kind: 'directory', mode: 0o755 });
  };
  add('/', { kind: 'directory', mode: 0o755 });
  const walk = async (host: string, guest: string): Promise<void> => {
    for (const entry of await readdir(host, { withFileTypes: true })) {
      const path = `${guest}/${entry.name}`;
      if (entry.isDirectory()) { add(path, { kind: 'directory', mode: 0o755 }); await walk(join(host, entry.name), path); }
      else add(path, { kind: 'file', mode: path.endsWith('/launch-grok') ? 0o555 : 0o444, bytes: await readFile(join(host, entry.name)) });
    }
  };
  await walk(join(prepared.directory, 'rootfs'), '');
  for (const path of ['/etc', '/usr/share', '/root', '/home/node', '/home/sandbox', '/opt/agenai/home',
    '/opt/agenai/grok-home/bundled', '/opt/agenai/grok-home/staged', '/opt/agenai/grok-home/hooks']) add(path, { kind: 'directory', mode: 0o755 });
  add('/opt/agenai/bin/grok', { kind: 'file', mode: 0o111, bytes: Buffer.from('independently wrong native payload') });
  add('/opt/agenai/bin/agenai-credential-bootstrap', { kind: 'file', mode: 0o555, bytes: bootstrapBytes });
  add(`/opt/agenai/grok-home/sessions/%2Fworkspace%2Fwork/${uuid}`, { kind: 'symlink', mode: 0o777, target: '/home/sandbox/session' });
  add('/opt/agenai/grok-home/logs', { kind: 'symlink', mode: 0o777, target: '/home/sandbox/logs' });
  const state = { creates: 0, deletes: 0, live: false, failDelete: false, name: '', labels: {}, requests: [] as string[], bodies: [] as string[] };
  const sockets = new Set<Socket>();
  const errors: unknown[] = [];
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', 'http://engine.invalid');
    const method = request.method ?? 'GET';
    state.requests.push(`${method} ${request.url}`);
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/version') return json(200, { ApiVersion: '1.52', MinAPIVersion: '1.44', Os: 'linux', Arch: architecture });
    if (url.pathname === '/info') return json(200, { ID: 'grok-image-unit', OSType: 'linux', Architecture: architecture,
      OperatingSystem: desktop ? 'Docker Desktop' : 'fixture-linux', CgroupVersion: '2', CgroupDriver: desktop ? 'cgroupfs' : 'systemd',
      SecurityOptions: [...(desktop ? [] : ['name=apparmor']), 'name=seccomp,profile=builtin', 'name=cgroupns'],
      MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true });
    if (url.pathname === `/v1.52/images/${imageDigest}/json`) return json(200, { Id: imageDigest, Os: 'linux', Architecture: architecture,
      Config: { Env: [], Volumes: null } });
    if (url.pathname === '/v1.52/containers/create' && method === 'POST') {
      const chunks: Uint8Array[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString(); state.bodies.push(body);
      const parsed: unknown = JSON.parse(body);
      assert(parsed && typeof parsed === 'object' && 'Labels' in parsed);
      assert(parsed.Labels && typeof parsed.Labels === 'object');
      state.labels = parsed.Labels; state.name = url.searchParams.get('name') ?? '';
      state.creates += 1; state.live = true; return json(201, { Id: containerId, Warnings: [] });
    }
    const match = /^\/v1\.52\/containers\/([^/]+)(?:\/(json|archive))?$/u.exec(url.pathname);
    if (!match) throw new Error(`Unexpected Engine effect ${method} ${url.pathname}`);
    if (!state.live) return json(404, {});
    assert.equal(match[1], containerId);
    if (method === 'DELETE') { state.deletes += 1; if (state.failDelete) return json(500, {}); state.live = false; return json(204, null); }
    if (match[2] === 'json') return json(200, { Id: containerId, Name: `/${state.name}`, Created: '2026-11-11T00:00:00Z', Image: imageDigest,
      Config: { Image: imageDigest, Labels: state.labels }, State: { Running: false, Status: 'created' }, Mounts: [] });
    if (match[2] !== 'archive') throw new Error('Unexpected resource operation.');
    const path = url.searchParams.get('path') ?? '';
    const file = files.get(path);
    if (!file) return json(404, {});
    response.setHeader('x-docker-container-path-stat', Buffer.from(JSON.stringify({ name: path === '/' ? '/' : basename(path),
      size: file.kind === 'file' ? file.bytes.length : 0,
      mode: (file.mode | (file.kind === 'directory' ? 0x80000000 : file.kind === 'symlink' ? 0x08000000 : 0)) >>> 0,
      mtime: '2026-11-11T00:00:00Z', linkTarget: file.kind === 'symlink' ? file.target : '' })).toString('base64'));
    if (method === 'HEAD') { response.writeHead(200); response.end(); return; }
    const selected = [...files].filter(([child]) => child === path || file.kind === 'directory' && child.startsWith(path === '/' ? '/' : `${path}/`));
    // Root directory must be the first header, independently of insertion order.
    selected.sort(([a], [b]) => a === path ? -1 : b === path ? 1 : a.localeCompare(b));
    response.writeHead(200, { 'content-type': 'application/x-tar' });
    response.end(tar(selected.map(([child, item]) => ({ name: child === path ? path === '/' ? '.' : basename(path)
      : path === '/' ? child.slice(1) : `${basename(path)}${child.slice(path.length)}`, file: item }))));
  })().catch((error: unknown) => { errors.push(error); response.writeHead(500); response.end(); }); });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { for (const connection of sockets) connection.destroy(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const endpoint = `unix://${socket}`;
  const helper = { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 };
  const routeAuthority = desktop ? createDockerDesktopRouteAuthority({ kind: 'local_docker_desktop', profile: 'desktop-apple-virtualization-native-arm64',
    stability: 'caller_owned_quiescence', interception: 'caller_owned_no_transparent_or_per_app_interception', engine: { endpoint, id: 'grok-image-unit' },
    deployment: { desktopVersion: 'unit', desktopBuild: 'unit', virtualMachineManager: 'apple_virtualization', rosetta: true,
      enhancedContainerIsolation: false, hostNetworking: false, kernelUdp: false, networkingMode: 'ipv4only', dnsInhibition: 'auto',
      dockerSubnet: '192.168.65.0/24', proxyMode: 'automatic_system', manualProxyConfiguration: false },
    hostObserver: { protocol: 'agenai.desktop-host-network.v1', executable: { path: '/not-executed/host-observer', sha256: 'a'.repeat(64) }, sourceDigest: `sha256:${'b'.repeat(64)}` },
    vmObserver: { protocol: 'agenai.sandbox.desktop-route-observer.v1', observationProtocol: 'agenai.desktop-vm-network.v1',
      imageDigest: `sha256:${'c'.repeat(64)}`, sourceDigest: `sha256:${'d'.repeat(64)}`, executable: '/usr/local/bin/agenai-sandbox-desktop-route',
      user: { uid: 1000, gid: 1000 }, ...helper, control: { heartbeatMs: 100, leaseTimeoutMs: 10000 } },
    pollIntervalMs: 100, commandTimeoutMs: 1000, maxOutputBytes: 65536,
  }) : createDockerLinuxRouteAuthority({ kind: 'local_linux_same_host', stability: 'caller_owned_quiescence',
    ipExecutable: { path: '/not-executed/ip', sha256: 'a'.repeat(64) }, pollIntervalMs: 100, commandTimeoutMs: 1000, maxOutputBytes: 65536 });
  const backend: GrokDockerBackendOptions = { profile: dockerProfile, endpoint, imageDigest, namespace: 'grok-image-unit', spillDirectory: join(directory, 'spill'),
    user: { uid: 1000, gid: 1000 }, egress: { imageDigest: `sha256:${'c'.repeat(64)}`, protocol: 'agenai.sandbox.egress-connect.v1',
      user: { uid: 1000, gid: 1000 }, broker: helper, relay: helper, routeAuthority, control: { heartbeatMs: 100, leaseTimeoutMs: 10000 } } };
  const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
  const secret = 'synthetic-secret-stays-host-only-during-admission';
  const options: GrokDockerProviderOptions = { profile, backend, workload: { resources: { cpus: 1, memoryBytes: 1024 ** 3, pids: 128 },
    temporaryStorage: { homeBytes: 64 * 1024 ** 2, tempBytes: 64 * 1024 ** 2 }, deadlines: { startupMs: 10000, cleanupMs: 10000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS },
    credential: { kind: 'auth_json', bytes: Buffer.from(JSON.stringify({ [scope]: { key: secret, auth_mode: 'oidc', user_id: 'unit-user',
      email: 'synthetic@example.invalid', create_time: '2026-01-01T00:00:00Z', expires_at: '2100-01-01T00:00:00Z',
      oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828', refresh_token: 'synthetic-refresh-is-removed' } })) },
    recovery: { kind: 'in_process' } };
  return { options, state, secret };
}

test('actual wrong native image bytes refuse admission only after original inspection cleanup, without credential or workload dispatch', async (t) => {
  const { options, state, secret } = await fixture(t);
  const backend = { ...options.backend };
  const pending = prepareGrokDockerProvider({ ...options, backend });
  backend.imageDigest = `sha256:${'9'.repeat(64)}`;
  backend.endpoint = 'unix:///mutated-not-contacted.sock';
  await assert.rejects(pending, { name: 'TypeError', message: 'The actual Docker image does not match the controlled Grok profile.' });
  assert.equal(state.creates, 1); assert.equal(state.deletes, 1); assert.equal(state.live, false);
  assert(state.requests.some((request) => request.includes('path=%2Fopt%2Fagenai%2Fbin%2Fgrok')));
  assert(state.requests.includes(`GET /v1.52/images/${imageDigest}/json`));
  assert(state.requests.every((request) => !request.includes('9'.repeat(64))));
  assert(state.requests.every((request) => !request.includes('/start') && !request.includes('/exec')));
  assert(!state.bodies.join('').includes(secret));
});

test('a failed image inspection retains the original cleanup owner and never replays admission after cleanup retry', async (t) => {
  const { options, state } = await fixture(t);
  state.failDelete = true;
  const error: unknown = await prepareGrokDockerProvider(options).catch((failure: unknown) => failure);
  assert(error instanceof DockerImageInspectionError);
  assert(error.cleanup);
  assert.equal(state.creates, 1); assert.equal(state.live, true);
  state.failDelete = false;
  await error.cleanup.retryCleanup();
  assert.equal(state.creates, 1); assert.equal(state.deletes, 2); assert.equal(state.live, false);
  assert(state.requests.every((request) => !request.includes('/start') && !request.includes('/exec')));
});
