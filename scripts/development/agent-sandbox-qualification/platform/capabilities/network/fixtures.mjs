import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { startMarkerServer } from '../../../capabilities/desktop/fixtures.mjs';
import { until } from '../../../engine.mjs';
import { failure, jsonWriter } from '../live/evidence.mjs';
import { identified } from './resources.mjs';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = encodeURIComponent;
const ownerLabel = 'org.agenai.sandbox.platform-network.owner';
const roleLabel = 'org.agenai.sandbox.platform-network.role';
const interval = (cidr) => {
  const [address, prefixText = '32'] = cidr.split('/'); const parts = address.split('.').map(Number); const prefix = Number(prefixText);
  assert(parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255));
  assert(Number.isInteger(prefix) && prefix >= 0 && prefix <= 32);
  const value = parts.reduce((result, part) => result * 256 + part, 0), size = 2 ** (32 - prefix);
  const first = Math.floor(value / size) * size; return [first, first + size - 1];
};
function allocations(network) {
  assert(network.IPAM && typeof network.IPAM === 'object' && !Array.isArray(network.IPAM), 'Complete network IPAM is required.');
  const unallocated = (network.Name === 'host' && network.Driver === 'host'
    || network.Name === 'none' && network.Driver === 'null') && network.Scope === 'local' && network.IPAM.Config === null;
  if (unallocated) return [];
  const configurations = network.IPAM.Config;
  assert(Array.isArray(configurations) && configurations.length > 0, 'Allocated network omitted its IPAM configuration.');
  assert(configurations.length <= 16);
  for (const config of configurations) {
    assert(config && typeof config === 'object' && typeof config.Subnet === 'string', 'Allocated network requires subnet coverage.');
    const parts = config.Subnet.split('/'); assert.equal(parts.length, 2, 'Allocated subnet requires exactly one CIDR separator.');
    const [address, prefixText] = parts;
    const family = isIP(address); assert(family === 4 || family === 6);
    assert(/^(0|[1-9][0-9]*)$/u.test(prefixText)); const prefix = Number(prefixText);
    assert(prefix <= (family === 4 ? 32 : 128));
    if (config.Gateway !== undefined) assert.equal(isIP(config.Gateway), family);
  }
  return configurations;
}
export function assertNoOverlap(candidate, exclusions, networks) {
  const [first, last] = interval(candidate);
  const cidrs = [...exclusions.filter((cidr) => !cidr.includes(':'))];
  for (const network of networks) {
    for (const config of allocations(network)) if (!config.Subnet.includes(':')) cidrs.push(config.Subnet);
  }
  for (const cidr of cidrs) {
    const [start, end] = interval(cidr); assert(first > end || start > last, `Public fixture overlaps observed ${cidr}.`);
  }
}
const hostFacts = () => Object.fromEntries(Object.entries(networkInterfaces()).sort().map(([name, addresses]) => [name,
  addresses.map(({ address, netmask, family, internal, cidr, mac, scopeid }) => ({ address, netmask, family, internal, cidr, mac,
    ...(scopeid === undefined ? {} : { scopeid }) })).sort((a, b) => a.address.localeCompare(b.address))]));
const networkFacts = (networks, ownedNetwork, ownedContainers) => networks.filter(({ Id }) => Id !== ownedNetwork)
  .map(({ Id, Name, Driver, Internal, EnableIPv6, IPAM, Options, Containers, Labels }) => ({ Id, Name, Driver, Internal, EnableIPv6,
    IPAM, Options, Containers: Object.keys(Containers).filter((id) => !((Name === 'host' && Driver === 'host'
      || Name === 'none' && Driver === 'null') && ownedContainers.includes(id))).sort(), Labels })).sort((a, b) => a.Id.localeCompare(b.Id));
async function dns(hostname, timeoutMs, signal) {
  const resolver = new Resolver({ timeout: Math.min(timeoutMs, 2000), tries: 1 });
  const cancel = () => resolver.cancel(); signal?.addEventListener('abort', cancel, { once: true });
  const read = async (family) => { try { return (await (family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname))).sort(); }
    catch (error) { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error; } };
  try { signal?.throwIfAborted(); const results = await Promise.allSettled([read(4), read(6)]);
    const rejected = results.find(({ status }) => status === 'rejected'); if (rejected) throw rejected.reason;
    const [ipv4, ipv6] = results.map(({ value }) => value);
    assert(ipv4.length + ipv6.length <= 16); return { ipv4, ipv6 };
  } finally { signal?.removeEventListener('abort', cancel); resolver.cancel(); }
}
async function completeNetworks(engine) {
  const list = async () => {
    const response = await engine.request('GET', '/networks'); assert(Array.isArray(response.data) && response.data.length <= 256);
    const ids = response.data.map(({ Id }) => { assert(/^[a-f0-9]{64}$/u.test(Id)); return Id; }).sort();
    assert.equal(new Set(ids).size, ids.length); return ids;
  };
  const before = await list(); const networks = [];
  for (const id of before) {
    const actual = (await engine.request('GET', `/networks/${id}`)).data;
    assert.equal(actual.Id, id); allocations(actual);
    assert(actual.Containers && typeof actual.Containers === 'object' && !Array.isArray(actual.Containers));
    for (const [memberId, member] of Object.entries(actual.Containers)) {
      assert(/^[a-f0-9]{64}$/u.test(memberId)); assert(member && typeof member === 'object' && typeof member.Name === 'string');
    }
    networks.push(actual);
  }
  assert.deepEqual(await list(), before, 'Engine network census changed during preparation.'); return networks;
}
function assertUnpublishedFixture(actual) {
  assert.equal(actual.HostConfig.PublishAllPorts, false, 'Fixture must not publish ports implicitly.');
  assert.equal(Object.keys(actual.Config.ExposedPorts ?? {}).length, 0, 'Fixture acquired exposed ports.');
  assert.equal(Object.keys(actual.HostConfig.PortBindings ?? {}).length, 0, 'Fixture acquired port bindings.');
  assert.equal(Object.keys(actual.NetworkSettings.Ports ?? {}).length, 0, 'Fixture acquired published ports.');
}

// The fixture owns one Node primary; census and prerequisite reads do not start extra Node processes.
async function markerMain() {
  const { createServer } = await import('node:net'); const { createSocket } = await import('node:dgram');
  const { open } = await import('node:fs/promises');
  const { networkInterfaces } = await import('node:os');
  const configuration = JSON.parse(process.argv[1]); const sockets = new Set(); const servers = [];
  const counts = { connections: 0, requests: 0, invalidRequests: 0, datagrams: 0 };
  let udp;
  for (const port of configuration.ports) {
    const server = createServer((socket) => {
      counts.connections++; sockets.add(socket); let bytes = Buffer.alloc(0); let answered = false;
      socket.on('error', () => {}); socket.setTimeout(5000, () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
      socket.on('data', (chunk) => {
        if (answered) return; bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 1024) { answered = true; counts.invalidRequests++; socket.destroy(); return; }
        if (bytes.length >= Buffer.byteLength(configuration.probe)) {
          answered = true;
          if (bytes.toString() === configuration.probe) { counts.requests++; socket.end(configuration.marker); }
          else { counts.invalidRequests++; socket.destroy(); }
        }
      });
    });
    server.maxConnections = 16;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); }); servers.push(server);
  }
  if (configuration.udp) {
    udp = createSocket('udp4'); udp.on('message', (bytes, peer) => {
      counts.datagrams++; if (bytes.length <= 1024 && bytes.toString() === configuration.probe) udp.send(configuration.marker, peer.port, peer.address);
    });
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(configuration.udp, '0.0.0.0', resolve); });
  }
  const snapshot = () => ({ ...counts, active: sockets.size });
  const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  emit({ ready: true, ports: servers.map((server) => server.address().port), udpPort: udp?.address().port ?? null,
    facts: { platform: process.platform, architecture: process.arch, node: process.version, uid: process.getuid(), gid: process.getgid(), pid: process.pid,
      ...(configuration.role === 'vm_marker' ? { primaryInterface: { name: configuration.primaryInterface,
        addresses: networkInterfaces()[configuration.primaryInterface] ?? [] } } : {}) } });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      pending = Buffer.concat([pending, chunk]); if (pending.length > 16 * 1024) throw new Error('Fixture input bound.');
      for (;;) {
        const end = pending.indexOf(10); if (end < 0) break;
        const command = JSON.parse(pending.subarray(0, end).toString()); pending = pending.subarray(end + 1);
        if (command.kind === 'census') emit({ id: command.id, result: snapshot() });
        else if (command.kind === 'quiescence' && configuration.role === 'vm_marker') {
          const file = await open('/proc/net/if_inet6', 'r'); const bytes = Buffer.alloc(16 * 1024 + 1); let offset = 0;
          try { while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; } }
          finally { await file.close(); }
          if (offset > 16 * 1024) throw new Error('Fixture IPv6 prerequisite exceeds its read bound.');
          emit({ id: command.id, result: { observedAt: new Date().toISOString(), raw: bytes.subarray(0, offset).toString('ascii') } });
        }
        else if (command.kind === 'close') { emit({ id: command.id, result: snapshot() }); return; }
        else throw new Error('Unknown fixed marker operation.');
      }
    }
  } finally {
    const joined = [...sockets].map((socket) => new Promise((resolve) => socket.once('close', resolve)));
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    if (udp) await new Promise((resolve) => udp.close(resolve)); await Promise.all(joined);
  }
}

class MarkerChannel {
  constructor(stream, timeoutMs) { this.stream = stream; this.timeoutMs = timeoutMs; this.offset = 0; this.sequence = 0; }
  async line() {
    return until(() => {
      if (this.stream.failure) throw this.stream.failure;
      assert.equal(this.stream.stderr.length, 0, 'Marker fixture wrote stderr.');
      const bytes = this.stream.stdout.subarray(this.offset); const end = bytes.indexOf(10);
      assert(bytes.length <= 32 * 1024, 'Marker frame bound.');
      if (end >= 0) { this.offset += end + 1; return JSON.parse(bytes.subarray(0, end).toString()); }
      assert(!this.stream.closed, 'Marker fixture closed before its response.'); return false;
    }, this.timeoutMs, 'Marker fixture response deadline.');
  }
  async request(kind, extra = {}) {
    const id = ++this.sequence; assert(id <= 512);
    const bytes = JSON.stringify({ id, kind, ...extra }) + '\n';
    let timer;
    const writing = new Promise((resolve, reject) => this.stream.socket.write(bytes, (error) => error ? reject(error) : resolve()));
    void writing.catch(() => {});
    try {
      await Promise.race([writing, new Promise((_, reject) => { timer = setTimeout(() => {
        this.stream.socket.destroy(); reject(new Error('Original marker write observation deadline.'));
      }, this.timeoutMs); })]);
      const result = await this.line(); assert.equal(result.id, id); return result.result;
    } finally { clearTimeout(timer); await writing.catch(() => {}); }
  }
}

export async function createFixtures(context) {
  const { config, engine } = context; const selected = config.capabilities.network.fixtures;
  const record = { format: 'agenai.sandbox-platform-network-fixtures.v1', owner: config.fixtureOwner,
    resources: [], executions: [], preparation: [], host: null, bootstrap: null, closed: false, controlFailures: [] };
  const write = jsonWriter(`${config.output}/fixtures.json`);
  const persist = () => write(record); let host; let vm; let sibling; let foreign; const channels = new Map(); let closing;
  const createActuals = new Map();
  const resolveFixture = () => dns(selected.publicHostname, config.capabilities.limits.requestMs, context.signal);
  const expectedFixtureDns = { ipv4: [selected.publicAddress], ipv6: [] };
  const note = async (kind, value) => {
    assert(record.preparation.length < 128); record.preparation.push({ kind, observedAt: new Date().toISOString(), ...value }); await persist();
  };
  const reserve = async (kind, role, body) => {
    assert(record.resources.length < 8);
    const item = { kind, role, name: `platform-net-${config.fixtureOwner}-${record.resources.length}`, id: null,
      state: 'reserved', body: structuredClone(body), labels: { [ownerLabel]: config.fixtureOwner, [roleLabel]: role } };
    record.resources.push(item); await persist(); return item;
  };
  const path = (item) => item.kind === 'network' ? `/networks/${encode(item.id ?? item.name)}` : `/containers/${encode(item.id ?? item.name)}/json`;
  const inspect = (item) => engine.request('GET', path(item), undefined, { allowed: [200, 404] });
  const verify = (item, actual) => {
    assert.equal(actual.Id, item.id); assert.equal(actual.Name, item.kind === 'network' ? item.name : `/${item.name}`);
    const labels = actual.Config?.Labels ?? actual.Labels;
    for (const [key, value] of Object.entries(item.labels)) assert.equal(labels[key], value);
    if (item.kind === 'container') {
      assert.equal(actual.Image, selected.imageDigest); assert.equal(actual.Config.User, '1000:1000');
      assert.equal(actual.HostConfig.ReadonlyRootfs, true); assert.equal(actual.HostConfig.Privileged, false);
      assert.deepEqual(actual.HostConfig.CapDrop, ['ALL']); assert.equal(actual.HostConfig.Memory, 64 * 1024 ** 2);
      assert.equal(actual.HostConfig.NanoCpus, 250_000_000); assert.equal(actual.HostConfig.PidsLimit, 32);
      assert.equal(actual.HostConfig.NetworkMode, item.body.HostConfig.NetworkMode); assert.equal(actual.HostConfig.PidMode, '');
      assert.equal(actual.HostConfig.CgroupnsMode, 'private');
      assert((actual.HostConfig.SecurityOpt ?? []).some((value) => value === 'no-new-privileges:true' || value === 'no-new-privileges'));
      assert.equal((actual.HostConfig.CapAdd ?? []).length, 0);
      assert.equal((actual.Mounts ?? []).length, 0);
    }
  };
  const acquire = async (item, target, body) => {
    item.state = 'creating'; await persist();
    try {
      const creating = engine.request('POST', target, body); createActuals.set(item, creating);
      const created = await creating; item.id = created.data.Id;
      assert(/^[a-f0-9]{64}$/u.test(item.id)); item.state = 'created'; await persist();
      const found = await inspect(item); assert.equal(found.status, 200); verify(item, found.data);
      if (item.kind === 'container') assertUnpublishedFixture(found.data);
      return item;
    } catch (error) { item.failure = failure(error); item.state = 'uncertain'; await persist(); throw error; }
  };
  const createMarker = async (role, network, address) => {
    const instance = record.resources.length;
    const marker = `AGENAI-NETWORK-${config.fixtureOwner}-${role}-${instance}\n`, probe = `PROBE-${config.fixtureOwner}-${role}-${instance}\n`;
    const fixedAddress = role === 'public_marker' && address !== undefined;
    const interfaceNames = Object.entries(hostFacts()).filter(([, addresses]) => addresses.some(({ address }) => address === selected.hostAddress)).map(([name]) => name);
    if (config.profile === 'linux-x64' && role === 'vm_marker') assert.equal(interfaceNames.length, 1,
      'Linux fixture requires one exact controller interface for its selected host address.');
    const fixtureConfig = { role, marker, probe, ports: role === 'vm_marker' ? [0] : [443, 8080], udp: role === 'vm_marker' ? 0 : 8080,
      primaryInterface: config.profile === 'linux-x64' ? interfaceNames[0] : 'eth0' };
    const body = { Image: selected.imageDigest, User: '1000:1000', Entrypoint: ['/usr/local/bin/node'],
      Cmd: ['--input-type=module', '--eval', `(${markerMain.toString()})();`, JSON.stringify(fixtureConfig)],
      Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp'], WorkingDir: '/', Tty: false,
      OpenStdin: true, StdinOnce: true, AttachStdin: true, AttachStdout: true, AttachStderr: true,
      HostConfig: { NetworkMode: network ?? 'host', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [],
        SecurityOpt: ['no-new-privileges:true'], PidMode: '', CgroupnsMode: 'private',
        NanoCpus: 250_000_000, Memory: 64 * 1024 ** 2, MemorySwap: 64 * 1024 ** 2, PidsLimit: 32,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=4m' }, Mounts: [], PublishAllPorts: false,
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        ...(role === 'public_marker' ? { Sysctls: { 'net.ipv4.ip_unprivileged_port_start': '0' } } : {}) },
      ...(fixedAddress ? { NetworkingConfig: { EndpointsConfig: { [network]: { IPAMConfig: { IPv4Address: address } } } } } : {}) };
    const item = await reserve('container', role, body); body.Labels = item.labels;
    const architecture = config.profile === 'linux-x64' ? 'amd64' : 'arm64';
    await acquire(item, `/containers/create?name=${encode(item.name)}&platform=linux%2F${architecture}`, body);
    item.attachmentEntered = true; await persist();
    const stream = await engine.hijack(`/containers/${item.id}/attach?stream=1&stdin=1&stdout=1&stderr=1`);
    const channel = new MarkerChannel(stream, config.capabilities.limits.requestMs); channels.set(item, channel);
    item.startEntered = true; await persist(); await engine.request('POST', `/containers/${item.id}/start`);
    const ready = await channel.line(); assert.equal(ready.ready, true);
    assert.equal(ready.facts.platform, 'linux'); assert.equal(ready.facts.architecture, config.profile === 'linux-x64' ? 'x64' : 'arm64');
    assert.equal(ready.facts.node, `v${config.guestNodeVersion}`); assert.equal(ready.facts.uid, 1000); assert.equal(ready.facts.gid, 1000);
    item.state = 'running'; item.marker = marker; item.probe = probe; item.ready = ready; item.address = address ?? null;
    const found = await inspect(item); verify(item, found.data); item.inspection = found.data; await persist();
    assertUnpublishedFixture(found.data);
    if (fixedAddress) {
      const endpoints = Object.values(found.data.NetworkSettings.Networks); assert.equal(endpoints.length, 1);
      assert.equal(endpoints[0].NetworkID, network); assert.equal(endpoints[0].IPAddress, address);
    }
    return item;
  };
  const createBridge = async (role = 'public_bridge') => {
    const body = { Driver: 'bridge', Internal: false, EnableIPv6: false, Attachable: false, Ingress: false,
      CheckDuplicate: true, IPAM: { Driver: 'default', Config: [{ Subnet: selected.publicSubnet, Gateway: selected.publicGateway }] },
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'nat-unprotected' } };
    const item = await reserve('network', role, body);
    await acquire(item, '/networks/create', { ...body, Name: item.name, Labels: item.labels });
    const found = await inspect(item); item.inspection = found.data; await persist();
    assert.equal(found.data.Options['com.docker.network.bridge.gateway_mode_ipv4'], 'nat-unprotected');
    assert.equal(found.data.IPAM.Config[0].Subnet, selected.publicSubnet); assert.equal(found.data.IPAM.Config[0].Gateway, selected.publicGateway);
    return item;
  };
  const remove = async (item) => {
    if (item.state === 'removed') { assert.equal((await inspect(item)).status, 404); return; }
    await createActuals.get(item)?.catch(() => {});
    if (!item.id) {
      const found = await inspect(item);
      if (found.status === 200) {
        const actual = found.data; const labels = actual.Config?.Labels ?? actual.Labels;
        assert.equal(actual.Name, item.kind === 'network' ? item.name : `/${item.name}`);
        for (const [key, value] of Object.entries(item.labels)) assert.equal(labels[key], value);
        assert(/^[a-f0-9]{64}$/u.test(actual.Id)); item.id = actual.Id; item.state = 'identified-for-cleanup'; await persist();
      } else throw new Error('Unacknowledged create retains ownership; current name absence cannot exclude a late create.');
    }
    const channel = channels.get(item);
    let closeActual;
    if (channel) {
      item.closeEnteredAt = new Date().toISOString(); await persist();
      closeActual = channel.stream.closed ? Promise.resolve() : channel.request('close').then((counts) => { item.finalCounts = counts; });
      void closeActual.catch(() => {});
      let timer;
      try { await Promise.race([closeActual.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, Math.min(1000, config.capabilities.limits.requestMs)); })]); }
      finally { clearTimeout(timer); }
    }
    const found = await inspect(item); if (found.status === 200) verify(item, found.data);
    item.state = 'removing'; await persist();
    await engine.request('DELETE', item.kind === 'network' ? `/networks/${item.id}` : `/containers/${item.id}?force=true&v=false`,
      undefined, { allowed: [204, 404] });
    assert.equal((await inspect(item)).status, 404);
    if (channel) {
      const physicalJoin = channel.stream.close();
      const outcomes = await Promise.allSettled([closeActual, physicalJoin, channel.stream.completion]);
      item.controlSettlement = outcomes.map((outcome) => outcome.status === 'fulfilled' ? { status: 'fulfilled' }
        : { status: 'rejected', failure: failure(outcome.reason) });
      channels.delete(item);
    }
    item.state = 'removed'; item.closedAt = new Date().toISOString(); await persist();
  };
  const foreignNetworks = async () => {
    assert(foreign && foreign.state === 'running');
    const found = await inspect(foreign); assert.equal(found.status, 200); verify(foreign, found.data);
    assert.equal(found.data.State.Running, true);
    const networks = found.data.NetworkSettings.Networks;
    assert.deepEqual(networks.bridge, foreign.defaultEndpoint, 'Foreign marker default endpoint changed.');
    return networks;
  };
  const owner = {
    record, persist, note, createBridge, remove,
    async startBase() {
      const addresses = hostFacts(); assert(Object.values(addresses).flat().some((entry) => entry.address === selected.hostAddress && entry.internal === false),
        'Selected host marker address is not an actual noninternal host interface address.');
      const image = (await engine.request('GET', `/images/${encode(selected.imageDigest)}/json`)).data;
      assert.equal(image.Id, selected.imageDigest); assert.equal(image.Architecture, config.profile === 'linux-x64' ? 'amd64' : 'arm64'); assert.equal(image.Os, 'linux');
      assert.equal(Object.keys(image.Config?.Volumes ?? {}).length, 0);
      record.host = { state: 'listen-entered', address: '0.0.0.0', hostAddress: selected.hostAddress, hostInterfaces: addresses }; await persist();
      host = await startMarkerServer({ host: '0.0.0.0', ports: [0], marker: `AGENAI-NETWORK-${config.fixtureOwner}-host\n`, probe: `PROBE-${config.fixtureOwner}-host\n` });
      Object.assign(record.host, { state: 'listening', port: host.ports[0], marker: host.marker, probe: host.probe }); await persist();
      vm = await createMarker('vm_marker');
      const primary = vm.ready.facts.primaryInterface;
      if (config.profile !== 'linux-x64') assert.equal(primary.name, 'eth0');
      assert(Array.isArray(primary.addresses) && primary.addresses.length <= 16);
      const ipv4 = primary.addresses.filter((entry) => entry.family === 'IPv4' && entry.internal === false);
      assert.equal(ipv4.length, 1, 'VM marker requires one observed noninternal eth0 IPv4 address.');
      if (config.profile !== 'linux-x64') {
        const [first, last] = interval(config.capabilities.network.routeAuthority.deployment.dockerSubnet);
        const [address] = interval(ipv4[0].address); assert(address > first && address < last, 'VM marker address is outside captured DockerSubnet.');
      }
      vm.vmAddress = ipv4[0].address; await persist();
      await owner.prepareForeign();
      await owner.awaitQuiescence();
    },
    async brokerPolicy(entry) {
      const broker = identified(entry.owner.recoveryRecord, 'egress_broker');
      const actual = (await engine.request('GET', `/containers/${broker.identity.id}/json`)).data;
      assert.equal(actual.Id, broker.identity.id); assert.equal(actual.State.Running, true);
      const values = actual.Config.Env.filter((entry) => entry.startsWith('AGENAI_EGRESS_CONFIG=')); assert.equal(values.length, 1);
      assert(Buffer.byteLength(values[0]) <= 64 * 1024); const helper = JSON.parse(values[0].slice('AGENAI_EGRESS_CONFIG='.length));
      assert.equal(helper.protocol, config.capabilities.network.egress.configuration.protocol); assert.equal(helper.role, 'broker');
      assert.equal(helper.leaseTimeoutMs, config.capabilities.network.egress.configuration.control.leaseTimeoutMs);
      assert(Array.isArray(helper.excludedCidrs) && helper.excludedCidrs.length <= 4096 && helper.excludedCidrs.every((value) => typeof value === 'string'));
      return { brokerId: broker.identity.id, configuration: helper, environment: values[0], environmentSha256: sha(values[0]) };
    },
    async captureBootstrap(run, opened) {
      const policy = await owner.brokerPolicy(opened.entry); const helper = policy.configuration;
      const targets = owner.targets();
      const byDestination = (left, right) => left.hostname.localeCompare(right.hostname) || left.port - right.port;
      assert.deepEqual(helper.destinations.toSorted(byDestination), [{ hostname: config.capabilities.network.positive.hostname, port: 443 },
        { hostname: selected.publicHostname, port: 443 }, { hostname: 'host.docker.internal', port: targets.specialHost.port }].toSorted(byDestination));
      const resolved = await owner.probeBroker(run, opened.entry, { kind: 'lookup', hostname: selected.publicHostname });
      assert.deepEqual({ ipv4: [...resolved.ipv4].sort(), ipv6: resolved.ipv6 }, expectedFixtureDns);
      const hostDns = await resolveFixture(); assert.deepEqual(hostDns, expectedFixtureDns);
      const networks = await completeNetworks(engine);
      assertNoOverlap(selected.publicSubnet, helper.excludedCidrs, networks);
      const [first, last] = interval(selected.publicSubnet), [address] = interval(selected.publicAddress);
      assert(address > first + 1 && address < last, 'Fixture DNS address must be a non-gateway fixture member of publicSubnet.');
      const ownedNetwork = identified(opened.owner.recoveryRecord, 'network').identity.id;
      const ownedContainers = opened.owner.recoveryRecord.resources.filter(({ role, identity }) => identity.kind === 'identified'
        && ['compute', 'export', 'egress_broker', 'egress_relay', 'route_observer'].includes(role)).map(({ identity }) => identity.id);
      record.bootstrap = { observedAt: new Date().toISOString(), originalOwnerNamespace: opened.entry.namespace,
        brokerId: policy.brokerId, helperEnvironment: policy.environment, helperEnvironmentSha256: policy.environmentSha256,
        excludedCidrs: helper.excludedCidrs, fixtureHostname: selected.publicHostname, dns: hostDns, hostInterfaces: hostFacts(),
        originalOwnerProjection: { ownedNetwork, ownedContainers }, actualNetworks: networks,
        networks: networkFacts(networks, ownedNetwork, ownedContainers),
        scope: 'Actual configured coverage of an installed public owner; no independent native-policy decoder and no continuous lease after original owner closure.' };
      await note('public-fixture-bootstrap-captured', { bootstrap: record.bootstrap });
    },
    async activatePublic() {
      assert(record.bootstrap, 'Public fixtures require the closed original bootstrap owner.');
      await context.assertNoActiveOwners();
      const before = await completeNetworks(engine);
      const projection = record.bootstrap.originalOwnerProjection;
      assert.deepEqual(networkFacts(before, projection.ownedNetwork, projection.ownedContainers), record.bootstrap.networks, 'Engine topology changed during the caller-owned preparation gap.');
      assert.deepEqual(hostFacts(), record.bootstrap.hostInterfaces, 'Host interfaces changed during fixture preparation.');
      assert.deepEqual(await resolveFixture(), expectedFixtureDns, 'Explicit fixture DNS changed; no automatic fixture adaptation.');
      assertNoOverlap(selected.publicSubnet, record.bootstrap.excludedCidrs, before);
      await note('public-fixture-bridge-creation-entered', { publicHostname: selected.publicHostname, publicAddress: selected.publicAddress, before });
      const bridge = await createBridge(); sibling = await createMarker('public_marker', bridge.id, selected.publicAddress);
      await owner.awaitQuiescence();
      await note('public-fixture-preparation-complete', { bridge, sibling, hostInterfaces: hostFacts(),
        fixtureHostname: selected.publicHostname, dns: await resolveFixture(), networks: await completeNetworks(engine) });
      assert.deepEqual(await resolveFixture(), expectedFixtureDns);
    },
    targets() {
      return { host: { host: selected.hostAddress, port: record.host.port, marker: host.marker, probe: host.probe },
        specialHost: { host: 'host.docker.internal', port: record.host.port, marker: host.marker, probe: host.probe },
        vmHost: { host: vm.vmAddress, port: vm.ready.ports[0], marker: vm.marker, probe: vm.probe },
        gateway: { host: selected.publicGateway, port: vm.ready.ports[0], marker: vm.marker, probe: vm.probe },
        ...(sibling ? { sibling: { host: sibling.address, port: 443, marker: sibling.marker, probe: sibling.probe },
          siblingMarker: { host: sibling.address, port: 8080, marker: sibling.marker, probe: sibling.probe } } : {}) };
    },
    async census() { return { host: host.snapshot(), vm: await channels.get(vm).request('census'),
      ...(sibling ? { sibling: await channels.get(sibling).request('census') } : {}) }; },
    async probeBroker(run, entry, command) {
      const broker = identified(entry.owner.recoveryRecord, 'egress_broker'); return owner.execute(run, broker.identity.id, command);
    },
    async execute(run, containerId, command) {
      assert(record.executions.length < 256); assert(Buffer.byteLength(JSON.stringify(command)) <= 4096);
      const execution = { containerId, command, state: 'reserved', enteredAt: new Date().toISOString(), id: null };
      record.executions.push(execution); await persist();
      const source = await context.probeSource();
      const created = await engine.request('POST', `/containers/${containerId}/exec`, { AttachStdout: true, AttachStderr: true, Tty: false,
        User: '1000:1000', Cmd: ['/usr/local/bin/node', '--input-type=module', '--eval', source, JSON.stringify(command)], Env: [], WorkingDir: '/' });
      execution.id = created.data.Id; execution.state = 'entered'; await persist();
      const stream = await engine.hijack(`/exec/${execution.id}/start`, { Detach: false, Tty: false });
      try {
        await until(() => stream.closed, config.capabilities.limits.requestMs, 'Independent fixture execution did not close.');
        execution.stdout = { bytes: stream.stdout.length, sha256: sha(stream.stdout), text: stream.stdout.subarray(0, 16 * 1024).toString() };
        execution.stderr = { bytes: stream.stderr.length, sha256: sha(stream.stderr), text: stream.stderr.subarray(0, 4096).toString() };
        execution.inspection = (await engine.request('GET', `/exec/${execution.id}/json`)).data;
        execution.state = 'settled'; execution.finishedAt = new Date().toISOString(); await persist();
        assert.equal(execution.inspection.Running, false); assert.equal(execution.inspection.ExitCode, 0);
        assert.equal(execution.stderr.bytes, 0); assert(execution.stdout.bytes <= 16 * 1024);
        const answer = JSON.parse(execution.stdout.text); assert.equal(answer.ok, true, execution.stdout.text); return answer.result;
      } catch (error) { execution.failure = failure(error); await persist(); throw error; }
      finally { await stream.close(); }
    },
    async prepareForeign(run) {
      assert(!sibling);
      if (!foreign) {
        foreign = await createMarker('public_marker', 'bridge');
        const networks = foreign.inspection.NetworkSettings.Networks;
        assert.deepEqual(Object.keys(networks), ['bridge']);
        assert.match(networks.bridge.NetworkID, /^[a-f0-9]{64}$/u);
        assert.match(networks.bridge.EndpointID, /^[a-f0-9]{64}$/u);
        assert.match(networks.bridge.MacAddress, /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u);
        assert.equal(typeof networks.bridge.IPAddress, 'string'); assert(networks.bridge.IPAddress.length > 0);
        assert(Number.isInteger(networks.bridge.IPPrefixLen) && networks.bridge.IPPrefixLen > 0 && networks.bridge.IPPrefixLen <= 32);
        foreign.defaultEndpoint = structuredClone(networks.bridge); await persist();
      }
      if (run) {
        assert.equal(foreign.membership, undefined);
        const membership = { networkId: null, endpoint: null, state: 'prepared' };
        foreign.membership = membership;
        run.beforeCleanup.push(async () => {
          const networks = await foreignNetworks();
          const added = Object.entries(networks).filter(([name]) => name !== 'bridge');
          assert(added.length <= 1 && added.every(([, endpoint]) => endpoint.NetworkID === membership.networkId),
            'Foreign marker acquired an unrelated network endpoint.');
          if (added.length) {
            if (membership.endpoint) assert.deepEqual(added[0][1], membership.endpoint);
            membership.disconnectEnteredAt = new Date().toISOString(); await persist();
            try {
              const response = await engine.request('POST', `/networks/${membership.networkId}/disconnect`,
                { Container: foreign.id, Force: false }, { allowed: [200] });
              membership.disconnectStatus = response.status;
            } catch (error) { membership.disconnectFailure = failure(error); await persist(); throw error; }
          }
          const after = await foreignNetworks(); assert.deepEqual(Object.keys(after), ['bridge']);
          membership.state = 'detached'; membership.detachedAt = new Date().toISOString(); await persist();
          await run.observe({ kind: 'foreign-marker-default-endpoint-preserved', containerId: foreign.id,
            detachedNetworkId: membership.networkId, disconnectStatus: membership.disconnectStatus ?? null,
            defaultEndpoint: foreign.defaultEndpoint, state: foreign.state, scope: 'Row-owned marker remains running until final fixture closure.' });
        });
        await persist();
      }
      return foreign;
    },
    async foreignMember(_run, entry, marker) {
      assert(marker === foreign && foreign.state === 'running' && foreign.membership?.state === 'prepared');
      assert.deepEqual(Object.keys(await foreignNetworks()), ['bridge']);
      const network = identified(entry.owner.recoveryRecord, 'network');
      const membership = foreign.membership; membership.networkId = network.identity.id; membership.state = 'attaching'; await persist();
      await note('foreign-membership-entered', { containerId: foreign.id, networkId: network.identity.id });
      try {
        await engine.request('POST', `/networks/${network.identity.id}/connect`, { Container: foreign.id });
        const networks = await foreignNetworks(); const added = Object.entries(networks).filter(([name]) => name !== 'bridge');
        assert.equal(added.length, 1); assert.equal(added[0][1].NetworkID, network.identity.id);
        assert.match(added[0][1].EndpointID, /^[a-f0-9]{64}$/u);
        membership.endpoint = structuredClone(added[0][1]); membership.state = 'attached'; await persist();
        return foreign;
      } catch (error) { membership.state = 'unknown'; membership.failure = failure(error); await persist(); throw error; }
    },
    async awaitQuiescence() {
      const sequence = record.preparation.length; let attempt = 0;
      await note('fixture-native-address-quiescence-entered', { sequence, source: '/proc/net/if_inet6', noSdkOwner: true });
      return until(async () => {
        assert(++attempt <= 64, 'Fixture address prerequisite exceeded its finite observation count.');
        const observation = await channels.get(vm).request('quiescence');
        const raw = Buffer.from(observation.raw, 'ascii'); assert(raw.length <= 16 * 1024);
        const rows = observation.raw.trim().split('\n').filter(Boolean); assert(rows.length <= 256);
        let tentative = 0;
        for (const row of rows) {
          const match = /^([a-f0-9]{32})\s+([a-f0-9]{1,8})\s+([a-f0-9]{1,2})\s+([a-f0-9]{1,2})\s+([a-f0-9]{1,8})\s+(\S{1,15})$/u.exec(row);
          assert(match, 'Malformed fixed kernel IPv6 address prerequisite.'); const flags = Number.parseInt(match[5], 16);
          assert.equal(flags & 0x08, 0, 'Fixture IPv6 address has DADFAILED.'); if (flags & 0x40) tentative++;
        }
        const path = `${config.output}/quiescence-${sequence}-${attempt}.txt`;
        await note('fixture-native-address-read', { path, observedAt: observation.observedAt, bytes: raw.length,
          sha256: sha(raw), records: rows.length, tentative });
        await writeFile(path, raw, { flag: 'wx', mode: 0o600 });
        return tentative === 0 ? { path, observedAt: observation.observedAt, bytes: raw.length, sha256: sha(raw), records: rows.length } : false;
      }, config.capabilities.limits.startupMs, 'External fixture address initialization did not become quiescent before the SDK baseline.');
    },
    close({ releaseNetworks = true } = {}) {
      if (closing) return closing;
      closing = (async () => {
        const errors = [];
        for (const item of record.resources.filter((entry) => entry.kind === 'container').reverse()) try { await remove(item); } catch (error) { errors.push(error); }
        if (!errors.length && releaseNetworks) for (const item of record.resources.filter((entry) => entry.kind === 'network').reverse()) try { await remove(item); } catch (error) { errors.push(error); }
        if (!releaseNetworks && record.resources.some((item) => item.kind === 'network' && item.state !== 'removed')) errors.push(new Error('Fixture bridge remains retained until original SDK ownership is closed.'));
        if (host) try { await host.close(); record.host.finalCounts = host.snapshot(); record.host.state = 'closed'; } catch (error) { errors.push(error); }
        record.closed = errors.length === 0; record.cleanupFailures = errors.map(failure); await persist();
        record.controlFailures = record.resources.flatMap((item) => (item.controlSettlement ?? []).filter((entry) => entry.status === 'rejected')
          .map((entry) => ({ id: item.id, role: item.role, ...entry })));
        await persist();
        if (errors.length) throw new AggregateError(errors, 'Original fixture ownership remains retained.');
      })().finally(() => { closing = null; }); return closing;
    },
  };
  await persist(); return owner;
}
