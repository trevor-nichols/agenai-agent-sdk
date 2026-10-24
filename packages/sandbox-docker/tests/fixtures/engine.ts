// ------------------------------------------------------------------------------------------------
//                engine.ts - Owned Unix HTTP daemon fixture - Resource lifecycle boundary tests
// ------------------------------------------------------------------------------------------------

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract, pack, type Header } from 'tar-stream';
import { createDockerSandboxBackend } from '../../src/index.js';
import type { DockerSandboxDataset, DockerSandboxProfile } from '../../src/index.js';
import { parseSandboxRequest, SANDBOX_DEFAULT_TRANSFER_BUFFERS, SANDBOX_DEFAULT_STREAM_LIMITS } from '@agen-ai/sandbox';

export const imageDigest = `sha256:${'1'.repeat(64)}`;
export const gate = <Value = void>() => Promise.withResolvers<Value>();

export function sandboxRequest(network: 'isolated' | 'outbound' = 'isolated') {
  return parseSandboxRequest({ policy: { resources: { cpus: 0.5, memoryBytes: 64 * 1024 ** 2, pids: 32 },
    temporaryStorage: { homeBytes: 1024 ** 2, tempBytes: 2 * 1024 ** 2 }, network: { kind: network },
    execution: { kind: 'deadline', timeoutMs: 5000 },
    deadlines: { startupMs: 5000, cleanupMs: 5000 }, transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS } });
}

interface StoredContainer {
  Id: string; Name: string; Image: string; Config: Record<string, unknown>; HostConfig: Record<string, unknown>;
  Mounts: unknown[]; State: { Running: boolean; Status: string }; AppArmorProfile: string;
  NetworkSettings: { Networks: Record<string, { NetworkID: string }>; Ports: Record<string, unknown> };
}

export interface FixtureOptions {
  readonly profile?: DockerSandboxProfile;
  readonly datasets?: readonly DockerSandboxDataset[];
  readonly runningAppArmorProfile?: string;
  readonly handleRequest?: (input: { method: string; path: string; body: unknown; request: IncomingMessage; response: ServerResponse }) => Promise<boolean>;
  readonly unsupportedDaemon?: boolean;
  readonly imageVolumes?: boolean;
  readonly ignoreMemory?: boolean;
  readonly pauseComputeCreate?: PromiseWithResolvers<void>;
  readonly loseComputeReply?: boolean;
  readonly failDeleteVolumeOnce?: boolean;
  readonly normalizeUnsupportedOomOnStart?: boolean;
  readonly containerWarnings?: (role: 'compute' | 'export') => readonly string[];
  readonly networkWarning?: string;
}

export async function engineFixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agenai-docker-unit-'));
  const socket = join(directory, 'engine.sock');
  const containers = new Map<string, StoredContainer>();
  const volumes = new Map<string, Record<string, unknown>>();
  const networks = new Map<string, Record<string, unknown>>();
  const effects: Array<{ method: string; path: string; body: unknown }> = [];
  const requests: Array<{ method: string; path: string; target: string }> = [];
  const computeCreating = gate();
  const computeDeleted = gate();
  let nextId = 0;
  let deleteVolumeAttempts = 0;
  let daemonId = 'daemon-unit-1';
  const tree = new Map<string, { header: Partial<Header> & Pick<Header, 'name'>; bytes: Uint8Array }>([['/workspace', { header: { name: 'workspace', type: 'directory', mode: 0o755 }, bytes: new Uint8Array() }]]);
  const uploadedArchives: Uint8Array[] = [];
  const id = () => (++nextId).toString(16).padStart(64, '0');
  const server = createServer((request, response) => { void handle(request, response).catch((error: unknown) => {
    if (!response.destroyed) { response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failure' })); }
  }); });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    requests.push({ method, path, target: request.url ?? '' });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body: unknown = bytes.length && request.headers['content-type'] === 'application/json' ? JSON.parse(bytes.toString()) : null;
    if (method !== 'GET' && method !== 'HEAD') effects.push({ method, path, body });
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (await options.handleRequest?.({ method, path, body, request, response })) return;
    if (path === '/version') return json(200, { Version: '29.1.4', ApiVersion: '1.52', MinAPIVersion: '1.44', Os: 'linux', Arch: 'amd64' });
    if (path === '/info') return json(200, { ID: daemonId, OSType: 'linux', Architecture: 'x86_64', CgroupVersion: options.unsupportedDaemon ? '1' : '2',
      Driver: 'overlayfs', DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
      CgroupDriver: 'systemd', SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'],
      MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true });
    if (path === `/v1.52/images/${imageDigest}/json`) return json(200, { Id: imageDigest, Os: 'linux', Architecture: 'amd64',
      RootFS: { Type: 'layers' }, Config: { Volumes: options.imageVolumes ? { '/image-volume': {} } : null } });
    if (path === '/v1.52/volumes/create' && method === 'POST') {
      const parsed = volumeInput(body);
      volumes.set(parsed.Name, { Name: parsed.Name, Driver: 'local', Mountpoint: `/fixture/${parsed.Name}`, CreatedAt: '2026-10-24T00:00:00Z', Labels: parsed.Labels, Options: null, Scope: 'local' });
      return json(201, { Name: parsed.Name });
    }
    if (path === '/v1.52/networks/create' && method === 'POST') {
      const parsed = networkInput(body); const networkId = id();
      networks.set(networkId, { Id: networkId, Name: parsed.Name, Created: '2026-10-24T00:00:00Z', Driver: 'bridge', Scope: 'local',
        Internal: false, Attachable: false, Ingress: false, EnableIPv6: false, ConfigOnly: false, IPAM: { Driver: 'default' }, Options: {}, Labels: parsed.Labels });
      return json(201, { Id: networkId, Warning: options.networkWarning ?? '' });
    }
    if (path === '/v1.52/containers/create' && method === 'POST') {
      const parsed = containerInput(body); const containerId = id();
      const name = url.searchParams.get('name') ?? 'missing';
      const mounts = parsed.HostConfig.Mounts;
      if (!Array.isArray(mounts) || typeof mounts[0] !== 'object' || mounts[0] === null) throw new Error('invalid fixture mount');
      const inspectedMounts = mounts.map((value, index) => {
        const mount = dataRecord(value);
        return { Type: mount.Type, Name: mount.Source,
          Source: mount.Type === 'image' ? `/fixture/image-layers/${containerId}/${index}` : `/fixture/${String(mount.Source)}`,
          Destination: mount.Target, RW: mount.ReadOnly !== true, Driver: mount.Type === 'image' ? '' : 'local',
          Propagation: mount.Type === 'image' ? 'rprivate' : '' };
      });
      const actualHostConfig = structuredClone(parsed.HostConfig);
      if (options.normalizeUnsupportedOomOnStart) actualHostConfig.OomKillDisable = false;
      if (options.ignoreMemory) actualHostConfig.Memory = 0;
      const { HostConfig: _host, ...configuration } = parsed;
      containers.set(containerId, { Id: containerId, Name: `/${name}`, Image: imageDigest,
        Config: { ...configuration, Labels: { 'fixture.image.label': 'inherited', ...parsed.Labels } }, HostConfig: actualHostConfig,
        Mounts: inspectedMounts,
        State: { Running: false, Status: 'created' }, AppArmorProfile: '',
        NetworkSettings: { Networks: { [String(parsed.HostConfig.NetworkMode)]: { NetworkID: String(parsed.HostConfig.NetworkMode) } }, Ports: {} } });
      if (name.endsWith('-compute')) {
        computeCreating.resolve(); await options.pauseComputeCreate?.promise;
        if (options.loseComputeReply) { response.destroy(); return; }
      }
      return json(201, { Id: containerId, Warnings: options.containerWarnings?.(name.endsWith('-compute') ? 'compute' : 'export') ?? [] });
    }
    const containerMatch = /^\/v1\.52\/containers\/([^/]+)(?:\/(json|archive|start))?$/u.exec(path);
    if (containerMatch) {
      const reference = decodeURIComponent(containerMatch[1]);
      const container = containers.get(reference) ?? [...containers.values()].find((value) => value.Name === `/${reference}`);
      if (!container) return json(404, {});
      if (containerMatch[2] === 'json') return json(200, container);
      if (containerMatch[2] === 'start') {
        container.State = { Running: true, Status: 'running' }; container.AppArmorProfile = options.runningAppArmorProfile ?? 'docker-default';
        if (options.normalizeUnsupportedOomOnStart) container.HostConfig.OomKillDisable = null;
        return json(204, null);
      }
      if (containerMatch[2] === 'archive' && method === 'PUT') {
        uploadedArchives.push(bytes);
        const decoder = extract();
        const iterator = decoder[Symbol.asyncIterator]();
        decoder.end(bytes);
        for await (const entry of { [Symbol.asyncIterator]: () => iterator }) {
          const content: Uint8Array[] = [];
          for await (const chunk of entry) { if (!(chunk instanceof Uint8Array)) throw new Error('Invalid fixture tar bytes.'); content.push(chunk); }
          tree.set(`/workspace/${entry.header.name.replace(/\/$/u, '')}`, { header: entry.header, bytes: Buffer.concat(content) });
        }
        return json(200, {});
      }
      if (containerMatch[2] === 'archive' && (method === 'GET' || method === 'HEAD')) {
        const selectedPath = url.searchParams.get('path') ?? '';
        const selected = tree.get(selectedPath);
        if (!selected) return json(404, {});
        const mode = selected.header.mode ?? 0o600;
        const type = selected.header.type === 'directory' ? 0x80000000 : selected.header.type === 'symlink' ? 0x08000000 : selected.header.type === 'fifo' ? 0x02000000 : 0;
        response.setHeader('x-docker-container-path-stat', Buffer.from(JSON.stringify({ name: selectedPath.split('/').at(-1), size: selected.bytes.length,
          mode: type + mode, mtime: '2026-10-24T00:00:00Z', linkTarget: selected.header.type === 'symlink' ? selected.header.linkname : '' })).toString('base64'));
        if (method === 'HEAD') { response.end(); return; }
        const encoder = pack();
        const writing = (async () => { for await (const chunk of encoder) if (!response.write(chunk)) await new Promise<void>((resolve) => response.once('drain', resolve)); response.end(); })();
        const choices = selected.header.type === 'directory'
          ? [...tree.entries()].filter(([entryPath]) => entryPath === selectedPath || entryPath.startsWith(`${selectedPath}/`))
          : [[selectedPath, selected] as const];
        const parent = selectedPath.slice(0, selectedPath.lastIndexOf('/') + 1);
        for (const [entryPath, entry] of choices) {
          const name = entryPath.slice(parent.length);
          if (entry.header.type === 'directory') encoder.entry({ ...entry.header, name });
          else encoder.entry({ ...entry.header, name }, entry.bytes);
        }
        encoder.finalize();
        await writing;
        return;
      }
      if (method === 'DELETE') { containers.delete(container.Id); if (container.Name.endsWith('-compute')) computeDeleted.resolve(); return json(204, null); }
    }
    const volumeMatch = /^\/v1\.52\/volumes\/([^/]+)$/u.exec(path);
    if (volumeMatch) {
      const name = decodeURIComponent(volumeMatch[1]); const volume = volumes.get(name);
      if (!volume) return json(404, {});
      if (method === 'DELETE') {
        deleteVolumeAttempts += 1;
        if (options.failDeleteVolumeOnce && deleteVolumeAttempts === 1) return json(500, {});
        volumes.delete(name); return json(204, null);
      }
      return json(200, volume);
    }
    const networkMatch = /^\/v1\.52\/networks\/([^/]+)$/u.exec(path);
    if (networkMatch) {
      const network = networks.get(networkMatch[1]);
      if (!network) return json(404, {});
      if (method === 'DELETE') { networks.delete(networkMatch[1]); return json(204, null); }
      return json(200, network);
    }
    json(404, {});
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  return { backend: createDockerSandboxBackend({ endpoint: `unix://${socket}`, namespace: 'unit-tests', imageDigest, spillDirectory: directory,
    profile: options.profile, datasets: options.datasets, user: { uid: 65534, gid: 65534 } }),
    endpoint: `unix://${socket}`, spillDirectory: directory, server, containers, volumes, networks, effects, requests, computeCreating, computeDeleted, uploadedArchives, tree,
    setDaemonId(value: string) { daemonId = value; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid fixture request');
  return Object.fromEntries(Object.entries(value));
}

function volumeInput(value: unknown) {
  const parsed = dataRecord(value);
  if (typeof parsed.Name !== 'string') throw new Error('invalid fixture volume');
  return { Name: parsed.Name, Labels: dataRecord(parsed.Labels) };
}

function networkInput(value: unknown) { return volumeInput(value); }

function containerInput(value: unknown) {
  const parsed = dataRecord(value);
  return { ...parsed, Labels: dataRecord(parsed.Labels), HostConfig: dataRecord(parsed.HostConfig) };
}
