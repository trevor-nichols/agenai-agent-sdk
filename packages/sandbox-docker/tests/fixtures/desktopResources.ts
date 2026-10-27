// ------------------------------------------------------------------------------------------------
//                desktopResources.ts - Exact public Desktop inputs and independent Engine image replies
// ------------------------------------------------------------------------------------------------

import type { DockerSandboxBackendOptions } from '../../src/index.js';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { createDockerSandboxBackend } from '../../src/index.js';
import { createDockerDesktopRouteAuthority } from '../../src/node/index.js';
import { desktopRouteAuthorityOptions } from './desktopRouteAuthority.js';
import { engineFixture, imageDigest } from './engine.js';
import type { FixtureOptions } from './engine.js';
import { desktopBridgeFixture, desktopHostDocument, desktopVmDocument } from './desktopObservation.js';
import { filesystemConfiguration } from './filesystem.js';
import { frame } from './process.js';

type DesktopProfile = 'desktop-apple-virtualization-native-arm64' | 'desktop-apple-virtualization-rosetta-amd64';

export async function desktopResourcesFixture(profile: DesktopProfile, handleRequest?: FixtureOptions['handleRequest'],
  faults: Pick<FixtureOptions, 'loseContainerReplyForRole'> = {},
  observeVm: (options: Parameters<typeof desktopVmDocument>[0]) => ReturnType<typeof desktopVmDocument> = desktopVmDocument,
  observeNetwork: (inspection: ReturnType<typeof networkInspection>) => unknown = (inspection) => inspection) {
  const descriptor = desktopRouteAuthorityOptions(profile);
  const filesystem = filesystemConfiguration();
  const sockets = new Map<string, Duplex>();
  const commands: Array<{ id: string; kind: string }> = [];
  const hostId = 'f'.repeat(63) + '1';
  const noneId = 'f'.repeat(63) + '2';
  const observerImage = { Id: descriptor.vmObserver.imageDigest, Os: 'linux', Architecture: 'arm64', Config: {
    User: '1000:1000', WorkingDir: '/', Volumes: null,
    Entrypoint: ['/usr/local/bin/node', '--input-type=module', '--eval',
      'import { runDesktopVmRouteObserverHelper } from "/opt/agenai/desktop-route/network/desktop/entry.js"; await runDesktopVmRouteObserverHelper();'],
    Cmd: [] as string[], Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp'], Labels: {
      'ai.agen.sandbox.desktop-route.protocol': 'agenai.sandbox.desktop-route-observer.v1',
      'ai.agen.sandbox.desktop-route.observation': 'agenai.desktop-vm-network.v1',
      'ai.agen.sandbox.desktop-route.source': `sha256:${'d'.repeat(64)}`,
      'ai.agen.sandbox.desktop-route.user': '1000:1000',
    } } };
  const egressImage = { Id: `sha256:${'e'.repeat(64)}`, Os: 'linux', Architecture: 'arm64', Config: {
    User: '65534:65534', WorkingDir: '/', Volumes: null,
    Entrypoint: ['/usr/local/bin/node'], Cmd: ['--version'], Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp'],
    Labels: { 'ai.agen.sandbox.egress.protocol': 'agenai.sandbox.egress-connect.v1',
      'ai.agen.sandbox.egress.source': imageDigest, 'ai.agen.sandbox.egress.user': '65534:65534' },
  } };
  const fixture = await engineFixture({ ...faults, profile, filesystem, kernelVersion: '6.12.54-linuxkit', async handleRequest(input) {
    if (await handleRequest?.(input)) return true;
    const deletingId = input.method === 'DELETE' && input.path.match(/^\/v1\.52\/containers\/([a-f0-9]{64})$/u)?.[1];
    if (deletingId) {
      const socket = sockets.get(deletingId);
      if (socket) await new Promise<void>((resolve) => { socket.once('close', resolve); socket.destroy(); });
    }
    const json = (value: unknown) => {
      input.response.writeHead(200, { 'content-type': 'application/json' }); input.response.end(JSON.stringify(value)); return true;
    };
    const builtin = (id: string, name: string, driver: string) => networkInspection({ Id: id, Name: name, Driver: driver, Scope: 'local',
      Created: '2026-10-26T00:00:00Z', Internal: false, Attachable: false, Ingress: false, EnableIPv6: false, ConfigOnly: false,
      IPAM: { Driver: 'default', Config: null, Options: null }, Options: {}, Labels: {} },
      Object.fromEntries([...fixture.containers.values()].filter((container) => container.State.Running
        && container.HostConfig.NetworkMode === name).map((container) => [container.Id,
        { Name: container.Name.slice(1), EndpointID: '', MacAddress: '', IPv4Address: '', IPv6Address: '' }])), false);
    if (input.path === '/v1.52/networks') return json([{ Id: hostId }, { Id: noneId }, ...[...fixture.networks.keys()].map((Id) => ({ Id }))]);
    if (input.path === `/v1.52/networks/${hostId}`) return json(observeNetwork(builtin(hostId, 'host', 'host')));
    if (input.path === `/v1.52/networks/${noneId}`) return json(observeNetwork(builtin(noneId, 'none', 'null')));
    const networkId = input.path.match(/^\/v1\.52\/networks\/([a-f0-9]{64})$/u)?.[1];
    const network = networkId && fixture.networks.get(networkId);
    if (network && input.method === 'GET') {
      network.IPAM = { Driver: 'default', Options: null, Config: [{ Subnet: desktopBridgeFixture.subnet, Gateway: desktopBridgeFixture.gateway }] };
      const containers = Object.fromEntries([...fixture.containers.values()].filter((container) => container.State.Running
        && container.HostConfig.NetworkMode === networkId).map((container) => [container.Id, {
        Name: container.Name.slice(1), EndpointID: 'b'.repeat(64), MacAddress: desktopBridgeFixture.brokerMacAddress,
        IPv4Address: `${desktopBridgeFixture.brokerAddress}/${desktopBridgeFixture.prefix}`, IPv6Address: '',
      }]));
      network.Containers = containers;
      return json(observeNetwork(networkInspection(network, containers, true)));
    }
    const containerId = input.path.match(/^\/v1\.52\/containers\/([a-f0-9]{64})\/(?:start|json)$/u)?.[1];
    const container = containerId && fixture.containers.get(containerId);
    if (container && input.method === 'POST' && input.path.endsWith('/start')) {
      const socket = sockets.get(container.Id);
      const role = container.Config.Labels && typeof container.Config.Labels === 'object'
        ? Reflect.get(container.Config.Labels, 'ai.agen.sandbox.role') : undefined;
      if (role === 'egress_broker') container.NetworkSettings.Networks = { owned: { NetworkID: String(container.HostConfig.NetworkMode),
        EndpointID: 'b'.repeat(64), MacAddress: desktopBridgeFixture.brokerMacAddress, IPAddress: desktopBridgeFixture.brokerAddress,
        IPPrefixLen: desktopBridgeFixture.prefix, Gateway: desktopBridgeFixture.gateway } };
      if (socket) setImmediate(() => {
        if (role === 'filesystem') sendFilesystem(socket, 4, { protocol: 'agenai.sandbox.filesystem.v1', layout: 'agenai.sandbox.workspace.v1', uid: 65534, gid: 65534 });
        else send(socket, { protocol: role === 'route_observer' ? 'agenai.sandbox.desktop-route-observer.v1' : 'agenai.sandbox.egress-connect.v1',
          kind: 'ready', ...(role === 'route_observer' ? { observationProtocol: 'agenai.desktop-vm-network.v1' } : { role: role === 'egress_broker' ? 'broker' : 'relay' }) });
      });
    }
    const image = input.path === `/v1.52/images/${descriptor.vmObserver.imageDigest}/json` ? observerImage
      : input.path === `/v1.52/images/${egressImage.Id}/json` ? egressImage : undefined;
    if (!image) return false;
    return json(image);
  } });
  const endpoint = `unix://${await realpath(fixture.endpoint.slice(7))}`;
  const directory = await realpath(fixture.spillDirectory);
  const hostDocumentPath = join(directory, 'host-document.json');
  const hostCalls = join(directory, 'host-calls.jsonl');
  fixture.server.on('upgrade', (request, socket, head) => {
    const id = request.url?.match(/^\/v1\.52\/containers\/([a-f0-9]{64})\/attach\?/u)?.[1];
    if (!id || request.headers['content-length'] !== '0' || request.headers['content-type'] !== 'text/plain'
      || request.headers['transfer-encoding'] !== undefined || head.byteLength !== 0) { socket.destroy(); return; }
    sockets.set(id, socket); socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(id); });
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    let pending = Buffer.alloc(0);
    socket.on('data', (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes]);
      const container = fixture.containers.get(id);
      if (container?.Name.endsWith('-filesystem')) {
        while (pending.length >= 16) {
          if (pending.readUInt32BE(0) !== 10 || pending.readUInt32BE(8) !== 0 || pending.readUInt32BE(12) !== 0) { socket.destroy(); return; }
          pending = pending.subarray(16); sendFilesystem(socket, 5);
        }
        return;
      }
      while (pending.includes(10)) {
        const end = pending.indexOf(10); const message: unknown = JSON.parse(pending.subarray(0, end).toString('utf8')); pending = pending.subarray(end + 1);
        if (!message || typeof message !== 'object') { socket.destroy(); return; }
        const kind = String(Reflect.get(message, 'kind'));
        const protocol = Reflect.get(message, 'protocol'); const sequence = Reflect.get(message, 'sequence');
        commands.push({ id, kind });
        if (kind === 'stop') {
          if (container?.Name.endsWith('-route_observer')) send(socket, { protocol, kind: 'closed', reason: 'stop' });
          socket.end(); return;
        }
        if (kind === 'heartbeat') send(socket, { protocol, kind, sequence });
        else if (kind === 'observe') {
          const network = [...fixture.networks.values()][0];
          const options = network?.Options;
          const bridgeName = options && typeof options === 'object' ? Reflect.get(options, 'com.docker.network.bridge.name') : undefined;
          const broker = [...fixture.containers.values()].some((candidate) => candidate.State.Running && candidate.Name.endsWith('-egress_broker'));
          send(socket, { protocol, kind: 'observation', sequence,
            document: observeVm({ ...(typeof bridgeName === 'string' ? { bridgeName } : {}), broker }) });
        } else { socket.destroy(); return; }
      }
    });
  });
  descriptor.engine.endpoint = endpoint;
  descriptor.engine.id = 'daemon-unit-1';
  const options = (): DockerSandboxBackendOptions => ({ profile, endpoint, spillDirectory: directory,
    namespace: 'unit-tests', imageDigest, user: { uid: 65534, gid: 65534 }, egress: {
      imageDigest: egressImage.Id, protocol: 'agenai.sandbox.egress-connect.v1', user: { uid: 65534, gid: 65534 },
      broker: { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 },
      relay: { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 8 }, temporaryBytes: 1024 ** 2 },
      control: { heartbeatMs: 100, leaseTimeoutMs: 60_000 }, routeAuthority: createDockerDesktopRouteAuthority(descriptor),
    } });
  return { ...fixture, endpoint, descriptor, observerImage, filesystem, options, commands, sockets,
    backend: () => createDockerSandboxBackend(options()), hostDocumentPath,
    async enableObservation() {
      const executable = join(directory, 'host-observer.cjs');
      const source = `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(hostCalls)},JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n');process.stdout.write(fs.readFileSync(${JSON.stringify(hostDocumentPath)}));\n`;
      await writeFile(hostDocumentPath, JSON.stringify(desktopHostDocument()));
      await writeFile(executable, source, { mode: 0o700 });
      descriptor.hostObserver.executable = { path: executable, sha256: createHash('sha256').update(source).digest('hex') };
    },
    async observedHostCalls(): Promise<unknown[]> { return (await readFile(hostCalls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); },
    async close() { for (const socket of sockets.values()) socket.destroy(); await fixture.close(); },
  };
}

function networkInspection(network: Record<string, unknown>, containers: Record<string, unknown>, allocated: boolean) {
  const Subnets: Record<string, { IPsInUse: number; DynamicIPsAvailable: number }> = {};
  if (allocated) {
    const endpoints = Object.keys(containers).length;
    // API 1.52 native N5: one endpoint consumes one address after the three IPv4 reservations.
    Subnets[desktopBridgeFixture.subnet] = { IPsInUse: 3 + endpoints,
      DynamicIPsAvailable: 2 ** (32 - desktopBridgeFixture.prefix) - 3 - endpoints };
  }
  return { ...network, Containers: containers, Status: { IPAM: allocated ? { Subnets } : {} } };
}

function send(socket: Duplex, value: unknown) { socket.write(frame(1, Buffer.from(`${JSON.stringify(value)}\n`))); }
function sendFilesystem(socket: Duplex, kind: number, value?: unknown) {
  const payload = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(8); header.writeUInt32BE(kind); header.writeUInt32BE(payload.length, 4);
  socket.write(frame(1, Buffer.concat([header, payload])));
}
