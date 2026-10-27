// ------------------------------------------------------------------------------------------------
//                registry.test.mjs - Scope admission, exact read routing and retained final census
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupDaemonObserver, createDaemonObserver } from './index.mjs';

const image = `sha256:${'a'.repeat(64)}`;
const observerId = 'f'.repeat(64);
const operationId = '12345678-1234-4123-8123-123456789abc';

async function engineFixture(t) {
  const directory = await realpath(await mkdtemp('/var/tmp/agenai-observer-registry-'));
  const socketPath = join(directory, 'e.sock');
  const workloads = new Map(); const executions = new Map(); const queries = []; const sockets = new Set();
  let observer; let nextExec = 0;
  const server = http.createServer((request, response) => { void (async () => {
    const parts = []; for await (const part of request) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
    const path = decodeURIComponent(request.url);
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path === '/v1.52/version') return json(200, { Os: 'linux', Arch: 'arm64' });
    if (path === '/v1.52/info') return json(200, { ID: 'registry-daemon', CgroupVersion: '2' });
    if (path === `/v1.52/images/${image}/json`) return json(200, { Id: image, Os: 'linux', Architecture: 'arm64', Config: { Volumes: null } });
    if (request.method === 'POST' && path.startsWith('/v1.52/containers/create?')) {
      observer = { Id: observerId, Name: `/${new URL(path, 'http://fixture').searchParams.get('name')}`, Image: body.Image,
        Config: body, HostConfig: { ...body.HostConfig, CapAdd: null, Privileged: false }, State: { Running: false },
        Mounts: body.HostConfig.Mounts.map((mount) => ({ Type: mount.Type, Source: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly })) };
      return json(201, { Id: observerId });
    }
    if (request.method === 'POST' && path === `/v1.52/containers/${observerId}/start`) { observer.State.Running = true; return json(204, null); }
    if (request.method === 'POST' && path === `/v1.52/containers/${observerId}/exec`) {
      const id = (++nextExec + 65536).toString(16).padStart(64, '0');
      const query = JSON.parse(body.Cmd.at(-1)); queries.push(query); executions.set(id, query);
      return json(201, { Id: id });
    }
    const exec = /^\/v1\.52\/exec\/([a-f0-9]{64})\/json$/u.exec(path);
    if (exec && executions.has(exec[1])) return json(200, { Running: false, ExitCode: 0 });
    const container = /^\/v1\.52\/containers\/([a-f0-9]{64})\/json$/u.exec(path);
    if (container) {
      const actual = container[1] === observerId ? observer : workloads.get(container[1]);
      return json(actual ? 200 : 404, actual ?? {});
    }
    if (request.method === 'DELETE' && path === `/v1.52/containers/${observerId}?force=true&v=false`) { observer = undefined; return json(204, null); }
    json(500, { message: `Unexpected Engine request ${request.method} ${path}` });
  })().catch((error) => { response.writeHead(500); response.end(JSON.stringify({ message: error.message })); }); });
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    void (async () => {
      socket.pause(); let bytes = Buffer.from(head); const size = Number(request.headers['content-length']);
      while (bytes.length < size) {
        const part = socket.read(size - bytes.length);
        if (part) bytes = Buffer.concat([bytes, part]); else await once(socket, 'readable');
      }
      assert.deepEqual(JSON.parse(bytes.subarray(0, size).toString()), { Detach: false, Tty: false });
      const id = /^\/v1\.52\/exec\/([a-f0-9]{64})\/start$/u.exec(request.url)?.[1]; const query = executions.get(id); assert(query);
      let value;
      if (query.operation === 'probe') value = { node: 'v24.18.0', uid: 0, architecture: 'arm64', selfCgroup: `/docker/${observerId}` };
      else if (query.operation === 'capture') value = { computeId: query.computeId, keeperPid: query.keeperPid,
        relativePath: `/docker/${query.computeId}`, knownPids: [{ pid: query.keeperPid, startClockTicks: '12345' }],
        directoryIdentity: { device: '39', inode: String(query.keeperPid) }, files: { 'memory.max': '67108864\n', 'cgroup.events': 'populated 1\n' } };
      else if (query.operation === 'read') {
        const scope = query.scopes.find((candidate) => query.path === `/sys/fs/cgroup${candidate.relativePath}/memory.max`); assert(scope);
        value = { text: '67108864\n', computeId: scope.computeId };
      } else { assert.equal(query.operation, 'empty'); value = { computeId: query.scope.computeId, kernelEmpty: true }; }
      const output = Buffer.from(JSON.stringify({ ok: true, value })); const frame = Buffer.alloc(8); frame[0] = 1; frame.writeUInt32BE(output.length, 4);
      socket.end(Buffer.concat([Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'), frame, output]));
      socket.resume();
    })().catch(() => socket.destroy());
  });
  server.listen(socketPath); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); });
  return { directory, endpoint: `unix://${socketPath}`, workloads, queries,
    workload(index) {
      const id = index.toString(16).padStart(64, '0');
      workloads.set(id, { Id: id, Image: image, State: { Running: true, Pid: index + 1000 }, Config: { Labels: {
        'ai.agen.sandbox.backend': 'agenai-docker', 'ai.agen.sandbox.role': 'compute', 'ai.agen.sandbox.namespace': 'registry-case',
        'ai.agen.sandbox.operation': operationId, 'ai.agen.sandbox.image': image } } });
      return id;
    } };
}

for (const capacity of [128, 256]) {
  test(`${capacity === 128 ? 'default' : 'explicit'} observer capacity retains every admitted scope through read and cleanup`, { timeout: 60000 }, async (t) => {
    const fixture = await engineFixture(t);
    const owner = await createDaemonObserver({ endpoint: fixture.endpoint, output: join(fixture.directory, 'observer'),
      imageDigest: image, architecture: 'arm64', allowedImages: [image], namespacePrefixes: ['registry-'],
      ...(capacity === 256 ? { maxScopes: 256 } : {}) });
    const ids = [];
    try {
      for (let index = 1; index <= capacity; index++) {
        const id = fixture.workload(index); ids.push(id);
        await owner.observeResponse({ method: 'POST', target: `/v1.52/containers/${id}/start`, status: 204 });
      }
      const overflow = fixture.workload(capacity + 1);
      await assert.rejects(owner.observeResponse({ method: 'POST', target: `/v1.52/containers/${overflow}/start`, status: 204 }), /finite qualification budget/u);
      const kernel = await owner.listenKernel(join(fixture.directory, 'k.sock'));
      const response = await new Promise((resolve, reject) => {
        const request = http.request({ socketPath: kernel.endpoint.slice(7), method: 'POST', path: '/read', agent: false }, (incoming) => {
          const parts = []; incoming.on('data', (part) => parts.push(part)); incoming.once('end', () => resolve(JSON.parse(Buffer.concat(parts).toString())));
        });
        request.once('error', reject); request.end(JSON.stringify({ path: `/sys/fs/cgroup/docker/${ids.at(-1)}/memory.max` }));
      });
      assert.deepEqual(response, { text: '67108864\n' });
      const reading = fixture.queries.findLast(({ operation }) => operation === 'read');
      assert.deepEqual(reading.scopes.map(({ computeId }) => computeId), ids);
      assert.equal(reading.maxScopes ?? 128, capacity);
      const record = JSON.parse(await readFile(owner.recordPath, 'utf8'));
      assert.equal(record.maxScopes ?? 128, capacity); assert.deepEqual(record.scopes.map(({ computeId }) => computeId), ids);
      fixture.workloads.clear(); await owner.close();
      assert.deepEqual(fixture.queries.filter(({ operation }) => operation === 'empty').map(({ scope }) => scope.computeId), ids);
      const recovered = await cleanupDaemonObserver({ endpoint: fixture.endpoint, recordPath: owner.recordPath });
      assert.deepEqual(recovered.scopes.map(({ computeId }) => computeId), ids);
      assert.deepEqual({ scopes: recovered.finalCensus.scopes, empty: recovered.finalCensus.kernelEmpty }, { scopes: capacity, empty: true });
    } finally { fixture.workloads.clear(); await owner.close(); }
  });
}
