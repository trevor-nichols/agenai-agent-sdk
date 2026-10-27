// ------------------------------------------------------------------------------------------------
//                filesystem.ts - Scripted native peer through the actual Unix Engine attachment boundary
// ------------------------------------------------------------------------------------------------

import type { Duplex } from 'node:stream';
import type { DockerSandboxEgressOptions, DockerSandboxFilesystemOptions } from '../../src/policy/config.js';
import type { DockerSandboxProfile } from '../../src/policy/profiles.js';
import { registerDockerLinuxRouteAuthority } from '../../src/network/routeAuthority.js';
import { engineFixture, gate } from './engine.js';
import { frame } from './process.js';

export function filesystemConfiguration(): DockerSandboxFilesystemOptions {
  return { imageDigest: `sha256:${'8'.repeat(64)}`, protocol: 'agenai.sandbox.filesystem.v1',
    executable: '/usr/local/bin/agenai-sandbox-files', layout: 'agenai.sandbox.workspace.v1', user: { uid: 65534, gid: 65534 },
    resources: { cpus: 0.25, memoryBytes: 32 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2,
    control: { heartbeatMs: 50, leaseTimeoutMs: 2000 } };
}

export async function filesystemFixture(options: { readonly profile?: DockerSandboxProfile; readonly wrongReadyUser?: boolean; readonly loseCommitReply?: boolean;
  readonly holdNext?: PromiseWithResolvers<void>; readonly pauseCreate?: PromiseWithResolvers<void>; readonly listErrno?: number;
  readonly combined?: boolean; readonly foreignNetwork?: boolean } = {}) {
  const filesystem = filesystemConfiguration();
  let attached: Duplex | undefined;
  const sockets = new Set<Duplex>();
  const egressSockets = new Map<string, Duplex>();
  const egress: DockerSandboxEgressOptions | undefined = options.combined ? {
    imageDigest: `sha256:${'9'.repeat(64)}`, protocol: 'agenai.sandbox.egress-connect.v1', user: { uid: 65534, gid: 65534 },
    broker: { resources: { cpus: 0.25, memoryBytes: 32 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2 },
    relay: { resources: { cpus: 0.25, memoryBytes: 32 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2 },
    control: { heartbeatMs: 50, leaseTimeoutMs: 2000 },
    routeAuthority: registerDockerLinuxRouteAuthority({ identity: { kind: 'local_linux_same_host', stability: 'caller_owned_quiescence',
      ipExecutable: { path: '/fixture/controlled-ip', sha256: '1'.repeat(64) }, pollIntervalMs: 1000,
      commandTimeoutMs: 1000, maxOutputBytes: 16384 }, async observe() {
      return { hostname: 'route-unit-host', kernel: 'unit-kernel', excludedCidrs: [] };
    } }),
  } : undefined;
  const nextEntered = gate();
  const committed = gate();
  const creating = gate();
  const commands: Array<{ operation: number; flags: number; path: string; bytes: number }> = [];
  let active:
    | { kind: 'read'; bytes: Buffer; offset: number }
    | { kind: 'list'; entries: Array<{ path: string; type: string; bytes: Uint8Array; mode: number }>; offset: number }
    | { kind: 'write'; path: string; permissions: number; chunks: Buffer[]; bytes: number }
    | undefined;
  const fixture = await engineFixture({ profile: options.profile, filesystem, egress, async handleRequest({ method, path, body }) {
    if (method === 'POST' && path === '/v1.52/containers/create' && typeof body === 'object' && body !== null
      && Reflect.get(body, 'Image') === filesystem.imageDigest) {
      creating.resolve(); await options.pauseCreate?.promise;
    }
    const helper = [...fixture.containers.values()].find((container) => container.Name.endsWith('-filesystem'));
    if (method === 'POST' && path === `/v1.52/containers/${helper?.Id}/start`) {
      if (options.foreignNetwork && helper) helper.NetworkSettings.Networks = { foreign: { NetworkID: 'a'.repeat(64) } };
      setImmediate(() => send(4, { protocol: filesystem.protocol, layout: filesystem.layout,
        uid: options.wrongReadyUser ? 65533 : 65534, gid: 65534 }));
    }
    if (method === 'DELETE' && path === `/v1.52/containers/${helper?.Id}`) attached?.destroy();
    for (const [id, socket] of egressSockets) {
      if (method === 'DELETE' && path === `/v1.52/containers/${id}`) socket.destroy();
      if (method === 'POST' && path === `/v1.52/containers/${id}/start`) {
        const role = fixture.containers.get(id)?.Name.endsWith('-egress_broker') ? 'broker' : 'relay';
        setImmediate(() => socket.write(frame(1, Buffer.from(`${JSON.stringify({ protocol: 'agenai.sandbox.egress-connect.v1', kind: 'ready', role })}\n`))));
      }
    }
    return false;
  } });
  function send(kind: number, input: unknown) {
    const bytes = input instanceof Uint8Array ? input : input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input));
    const header = Buffer.alloc(8);
    header.writeUInt32BE(kind, 0); header.writeUInt32BE(bytes.byteLength, 4);
    attached?.write(frame(1, Buffer.concat([header, bytes])));
  }
  function terminal(status: string, count = 0, extra: Record<string, unknown> = {}) {
    send(3, { status, effect: 'none', errno: 0, count: String(count), mode: null, entry: null, ...extra });
  }
  function metadata(path: string) {
    const value = fixture.tree.get(path);
    return value ? { kind: value.header.type === 'directory' ? 'directory' : 'file', byteLength: value.bytes.byteLength,
      mode: (value.header.mode ?? 0o644) & 0o777 } : undefined;
  }
  async function command(operation: number, flags: number, path: string, bytes: Buffer) {
    commands.push({ operation, flags, path, bytes: bytes.length });
    const full = path === '.' ? '/workspace/work' : `/workspace/work/${path}`;
    if (operation === 10) { send(5, undefined); return; }
    if (operation === 8) { active = undefined; terminal('cancelled'); return; }
    if (operation === 1 || operation === 2 || operation === 3) {
      const entry = metadata(full);
      const value = fixture.tree.get(full);
      if (!entry || !value) { terminal('rejected', 0, { errno: 2 }); return; }
      if (operation === 1) { terminal('complete', 0, { entry }); return; }
      if (operation === 2) active = { kind: 'read', bytes: Buffer.from(value.bytes), offset: 0 };
      else active = { kind: 'list', offset: 0, entries: [...fixture.tree.entries()]
        .filter(([candidate]) => candidate.startsWith(`${full}/`) && !candidate.slice(full.length + 1).includes('/'))
        .map(([candidate, value]) => ({ path: candidate.slice(full.length + 1), type: value.header.type ?? 'file', bytes: value.bytes,
          mode: value.header.mode ?? 0o644 })) };
      terminal('ready', 0, { entry }); return;
    }
    if (operation === 4) {
      nextEntered.resolve(); await options.holdNext?.promise;
      if (active?.kind === 'read') {
        if (active.offset === active.bytes.length) { terminal('complete', active.offset); active = undefined; return; }
        const part = active.bytes.subarray(active.offset, active.offset + 65536); active.offset += part.length; send(1, part); return;
      }
      if (active?.kind === 'list') {
        if (options.listErrno !== undefined) { terminal('rejected', active.offset, { errno: options.listErrno }); active = undefined; return; }
        const value = active.entries[active.offset];
        if (!value) { terminal('complete', active.offset); active = undefined; return; }
        active.offset += 1;
        send(2, { nameHex: Buffer.from(value.path).toString('hex'), kind: value.type === 'directory' ? 'directory' : 'file',
          byteLength: value.bytes.byteLength, mode: value.mode & 0o777 }); return;
      }
    }
    if (operation === 5) {
      const existing = fixture.tree.get(full);
      if (existing && flags === 1) { terminal('rejected', 0, { errno: 17 }); return; }
      active = { kind: 'write', path: full, permissions: existing?.header.mode ?? 0o644, chunks: [], bytes: 0 };
      terminal('ready', 0, { effect: 'staged' }); return;
    }
    if (operation === 6 && active?.kind === 'write') {
      active.chunks.push(Buffer.from(bytes)); active.bytes += bytes.length;
      terminal('ready', active.bytes, { effect: 'staged' }); return;
    }
    if (operation === 7 && active?.kind === 'write') {
      fixture.tree.set(active.path, { header: { name: active.path.slice('/workspace/'.length), type: 'file', mode: active.permissions },
        bytes: Buffer.concat(active.chunks) });
      committed.resolve();
      if (options.loseCommitReply) { active = undefined; attached?.destroy(); return; }
      terminal('complete', active.bytes, { effect: 'published', mode: active.permissions & 0o777 }); active = undefined; return;
    }
    throw new Error(`Unexpected scripted filesystem operation ${operation}`);
  }
  fixture.server.on('upgrade', (request, socket, initial) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    void (async () => {
      socket.pause();
      if (request.headers['content-length'] !== '0' || request.headers['content-type'] !== 'text/plain'
        || request.headers['transfer-encoding'] !== undefined) throw new Error('Helper attach must not send an HTTP body.');
      const match = /^\/v1\.52\/containers\/([a-f0-9]{64})\/attach\?/u.exec(request.url ?? '');
      if (!match) throw new Error('Unexpected filesystem attachment');
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      if (!fixture.containers.get(match[1])?.Name.endsWith('-filesystem')) {
        egressSockets.set(match[1], socket);
        let pending = '';
        socket.on('data', (part: Buffer) => {
          pending += part.toString('utf8');
          while (pending.includes('\n')) {
            const end = pending.indexOf('\n');
            const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
            if (message.kind === 'stop') { socket.end(); return; }
            if (message.kind !== 'heartbeat') { socket.destroy(); return; }
            socket.write(frame(1, Buffer.from(`${JSON.stringify({ protocol: 'agenai.sandbox.egress-connect.v1',
              kind: 'heartbeat', sequence: message.sequence })}\n`)));
          }
        });
        socket.resume(); return;
      }
      attached = socket;
      let buffered = Buffer.from(initial);
      let tail = Promise.resolve();
      socket.on('data', (part: Buffer) => {
        buffered = Buffer.concat([buffered, part]);
        while (buffered.length >= 16) {
          const operation = buffered.readUInt32BE(0), flags = buffered.readUInt32BE(4);
          const pathBytes = buffered.readUInt32BE(8), dataBytes = buffered.readUInt32BE(12);
          const length = 16 + pathBytes + dataBytes;
          if (buffered.length < length) break;
          const path = buffered.subarray(16, 16 + pathBytes).toString('utf8');
          const data = Buffer.from(buffered.subarray(16 + pathBytes, length)); buffered = buffered.subarray(length);
          tail = tail.then(() => command(operation, flags, path, data));
          void tail.catch(() => socket.destroy());
        }
      });
      socket.resume();
    })().catch(() => socket.destroy());
  });
  return { ...fixture, filesystem, commands, nextEntered, committed, creating, async close() {
    options.holdNext?.resolve(); options.pauseCreate?.resolve(); for (const socket of sockets) socket.destroy(); await fixture.close();
  } };
}
