// ------------------------------------------------------------------------------------------------
//                container.mjs - Exact diagnostic container ownership and bounded serialized kernel RPC
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Engine } from '../../engine.mjs';

const label = 'org.agenai.sandbox.qualification.observer';

export class ObserverContainer {
  constructor(record, persist) {
    this.record = record; this.persist = persist;
    this.engine = new Engine(record.endpoint.slice(7), '1.52', { requestMs: 30_000, outputBytes: 1024 * 1024 });
    this.pending = Promise.resolve(); this.waiting = 0;
  }

  static planned({ endpoint, imageDigest, architecture }) {
    const operationId = randomUUID();
    return { format: 'agenai.sandbox-daemon-observer.v1', endpoint, imageDigest, architecture, operationId,
      name: `agenai-kernel-observer-${operationId}`, daemonId: null, containerId: null, acquisition: 'planned',
      observerRemoved: false, scopes: [], failures: [], pendingExecs: [], probe: null };
  }

  async inspect(reference = this.record.containerId ?? this.record.name) {
    return (await this.engine.request('GET', `/containers/${encodeURIComponent(reference)}/json`, undefined, { allowed: [200, 404] }));
  }

  verify(object) {
    assert(object && /^[a-f0-9]{64}$/u.test(object.Id) && object.Name === `/${this.record.name}` && object.Image === this.record.imageDigest);
    if (this.record.containerId) assert.equal(object.Id, this.record.containerId);
    assert.equal(object.Config?.Labels?.[label], this.record.operationId);
    assert.equal(object.Config?.User, '0:0'); assert.equal(object.HostConfig?.ReadonlyRootfs, true);
    assert.equal(object.HostConfig.Privileged, false); assert.deepEqual(object.HostConfig.CapDrop, ['ALL']);
    assert.equal(object.HostConfig.CapAdd, null);
    assert.equal(object.HostConfig.Memory, 256 * 1024 ** 2); assert.equal(object.HostConfig.MemorySwap, 256 * 1024 ** 2);
    assert.equal(object.HostConfig.NanoCpus, 1_000_000_000); assert.equal(object.HostConfig.PidsLimit, 32);
    assert.deepEqual(object.Config.Entrypoint, ['/usr/local/bin/node']); assert.deepEqual(object.Config.Cmd, ['-e', 'setInterval(()=>{},1000)']);
    assert.equal(object.HostConfig.NetworkMode, 'none'); assert.equal(object.HostConfig.PidMode, 'host'); assert.equal(object.HostConfig.CgroupnsMode, 'host');
    assert((object.HostConfig.SecurityOpt ?? []).some((value) => value === 'no-new-privileges:true' || value === 'no-new-privileges'));
    const mounts = object.Mounts;
    assert(Array.isArray(mounts) && mounts.length === 2);
    for (const [Source, Destination] of [['/proc', '/observer/proc'], ['/sys/fs/cgroup', '/observer/cgroup']]) {
      assert(mounts.some((mount) => mount.Type === 'bind' && mount.Source === Source && mount.Destination === Destination && mount.RW === false));
    }
    return object;
  }

  async start() {
    const version = (await this.engine.request('GET', '/version')).data;
    const info = (await this.engine.request('GET', '/info')).data;
    assert.equal(version.Os, 'linux'); assert.equal(version.Arch, this.record.architecture); assert.equal(info.CgroupVersion, '2');
    this.record.daemonId = info.ID;
    const image = (await this.engine.request('GET', `/images/${encodeURIComponent(this.record.imageDigest)}/json`)).data;
    assert.equal(image.Id, this.record.imageDigest); assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, this.record.architecture);
    assert.equal(Object.keys(image.Config?.Volumes ?? {}).length, 0);
    this.record.acquisition = 'creating'; await this.persist();
    const created = await this.engine.request('POST', `/containers/create?name=${this.record.name}&platform=linux%2F${this.record.architecture}`, {
      Image: this.record.imageDigest, User: '0:0', Entrypoint: ['/usr/local/bin/node'], Cmd: ['-e', 'setInterval(()=>{},1000)'],
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'], WorkingDir: '/', Labels: { [label]: this.record.operationId },
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        PidMode: 'host', CgroupnsMode: 'host', NanoCpus: 1_000_000_000, Memory: 256 * 1024 ** 2, MemorySwap: 256 * 1024 ** 2, PidsLimit: 32,
        Mounts: [{ Type: 'bind', Source: '/proc', Target: '/observer/proc', ReadOnly: true },
          { Type: 'bind', Source: '/sys/fs/cgroup', Target: '/observer/cgroup', ReadOnly: true }] },
    });
    assert(/^[a-f0-9]{64}$/u.test(created.data.Id)); this.record.containerId = created.data.Id;
    this.record.acquisition = 'created'; await this.persist();
    this.verify((await this.inspect()).data);
    await this.engine.request('POST', `/containers/${this.record.containerId}/start`);
    const running = this.verify((await this.inspect()).data); assert.equal(running.State.Running, true);
    this.record.acquisition = 'running'; await this.persist();
    this.record.probe = await this.call({ operation: 'probe' });
    assert.equal(this.record.probe.node, 'v24.18.0'); assert.equal(this.record.probe.uid, 0);
    assert.equal(this.record.probe.architecture, this.record.architecture === 'amd64' ? 'x64' : 'arm64');
    assert(this.record.probe.selfCgroup.includes(this.record.containerId));
    await this.persist();
  }

  call(query) {
    assert(this.waiting < 16, 'Observer RPC queue exceeds its finite qualification bound.');
    this.waiting += 1;
    const actual = this.pending.then(() => this.execute(query));
    this.pending = actual.catch(() => {});
    return actual.finally(() => { this.waiting -= 1; });
  }

  async execute(query) {
    const source = await readFile(new URL('./peer.mjs', import.meta.url), 'utf8');
    const encoded = JSON.stringify(query); assert(Buffer.byteLength(source) + Buffer.byteLength(encoded) <= 64 * 1024);
    this.verify((await this.inspect()).data);
    const created = await this.engine.request('POST', `/containers/${this.record.containerId}/exec`, {
      AttachStdout: true, AttachStderr: true, Tty: false, User: '0:0',
      Cmd: ['/usr/local/bin/node', '--input-type=module', '-e', source, encoded], Env: [], WorkingDir: '/',
    });
    const execId = created.data.Id; assert(/^[a-f0-9]{64}$/u.test(execId));
    this.record.pendingExecs.push(execId); await this.persist();
    let stream;
    let timer;
    try {
      stream = await this.engine.hijack(`/exec/${execId}/start`, { Detach: false, Tty: false });
      await Promise.race([stream.completion, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Bounded kernel observation RPC did not settle within thirty seconds.')), 30_000);
      })]);
      if (stream.failure) throw stream.failure;
      assert.equal(stream.stderr.length, 0, stream.stderr.toString('utf8'));
      const exit = (await this.engine.request('GET', `/exec/${execId}/json`)).data;
      assert.equal(exit.Running, false); assert.equal(exit.ExitCode, 0);
      this.record.pendingExecs = this.record.pendingExecs.filter((entry) => entry !== execId); await this.persist();
      const result = JSON.parse(stream.stdout.toString('utf8'));
      if (result.ok !== true) throw Object.assign(new Error(result.error?.message ?? 'Kernel observer rejected its query.'), { code: result.error?.code });
      return result.value;
    } finally { clearTimeout(timer); if (stream) await stream.close(); }
  }

  async destroy() {
    await this.pending;
    if (this.record.acquisition === 'planned') {
      this.record.observerRemoved = true; this.record.acquisition = 'not-created'; await this.persist(); return;
    }
    assert.equal((await this.engine.request('GET', '/info')).data.ID, this.record.daemonId);
    const state = await this.inspect();
    if (state.status === 404) {
      assert(this.record.containerId, 'Uncertain observer create has no observed exact ID; current name absence cannot exclude a late create.');
    } else {
      const object = this.verify(state.data); this.record.containerId = object.Id; await this.persist();
      await this.engine.request('DELETE', `/containers/${object.Id}?force=true&v=false`, undefined, { allowed: [204, 404] });
      assert.equal((await this.inspect()).status, 404);
    }
    this.record.observerRemoved = true; this.record.acquisition = 'removed'; await this.persist();
  }
}
