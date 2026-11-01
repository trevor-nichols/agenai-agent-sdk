// Native source-composed broker mechanism probe; no SDK coordinator or route-lease admission claim.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine, until } from '../../../../engine.mjs';
import { selectAllocation } from '../transitions/allocation.ts';
import { LIMITS, TransitionModel } from '../transitions/model.ts';
import { deniedCoverage } from '../../../../../../../packages/ai/sandbox-docker/src/network/policy.ts';
import { helperCommand, HELPER_ENVIRONMENT, EGRESS_CONFIG_ENV, EGRESS_PROTOCOL, parseHelperFrame,
  parseEgressHelperConfiguration } from '../../../../../../../packages/ai/sandbox-docker/src/helpers/protocol.ts';
import { isolatedHostPolicy, matchesHostIsolation } from '../../../../../../../packages/ai/sandbox-docker/src/policy/hostIsolation.ts';
import { containerFingerprint } from '../../../../../../../packages/ai/sandbox-docker/src/resources/fingerprint.ts';
import { readDesktopEngineNetworks, observationFingerprint } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.ts';
import { readDesktopHostObservation } from '../../../../../../../packages/ai/sandbox-docker/src/node/desktopHostObservation.ts';
import { parseDesktopVmObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.ts';
import { nativeAddressNumber, prefixMask, formatNumericAddress } from '../../../../../../../packages/ai/sandbox-docker/src/network/address.ts';

async function listenerMain() {
  const { createServer } = await import('node:net'); const { createInterface } = await import('node:readline');
  const token = process.argv[1], sockets = new Set(), counts = { connections: 0, requests: 0 };
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const server = createServer((socket) => {
    counts.connections++; sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(3000, () => socket.destroy()); let text = '';
    socket.on('data', (bytes) => {
      text += bytes.toString(); if (text.length > 128) socket.destroy();
      else if (text.endsWith('\n')) { if (text === `${token}\n`) { counts.requests++; socket.end(`${token}\n`); } else socket.destroy(); }
    });
  });
  server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  emit({ ready: true, port: server.address().port, uid: process.getuid(), node: process.version });
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.length > 128) throw new Error('Listener command bound.');
    const command = JSON.parse(line); if (command.kind !== 'census') throw new Error('Unknown listener operation.');
    emit({ id: command.id, counts: { ...counts, active: sockets.size } });
  }
  for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve));
}
async function probeMain() {
  const { createConnection } = await import('node:net'), { Resolver } = await import('node:dns/promises');
  const command = JSON.parse(process.argv[1]); let result;
  if (command.kind === 'dns') {
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    const read = async (family) => { try { return await (family === 4 ? resolver.resolve4(command.hostname) : resolver.resolve6(command.hostname)); }
      catch (error) { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error; } };
    try { result = { ipv4: (await read(4)).sort(), ipv6: (await read(6)).sort() }; } finally { resolver.cancel(); }
  } else if (command.kind === 'direct') {
    const socket = createConnection({ host: command.address, port: command.port }); let bytes = '';
    result = await new Promise((resolve, reject) => {
      socket.setTimeout(5000, () => socket.destroy(new Error('Direct listener deadline.'))); socket.once('error', reject);
      socket.once('connect', () => socket.write(`${command.token}\n`));
      socket.on('data', (chunk) => { bytes += chunk.toString(); if (bytes.length > 4096) socket.destroy(new Error('Direct output bound.')); });
      socket.once('end', () => resolve({ response: bytes }));
    }); socket.destroy();
  } else {
    if (!['denied', 'tls'].includes(command.kind)) throw new Error('Unknown fixed probe operation.');
    const socket = createConnection('/run/agenai-egress/connect.sock'); let header = Buffer.alloc(0);
    const status = await new Promise((resolve, reject) => {
      socket.setTimeout(10000, () => socket.destroy(new Error('Broker observation deadline.'))); socket.once('error', reject);
      socket.once('connect', () => socket.write(`CONNECT ${command.hostname}:${command.port} HTTP/1.1\r\nHost: ${command.hostname}:${command.port}\r\n\r\n`));
      const receive = (chunk) => {
        header = Buffer.concat([header, chunk]); if (header.length > 8192) return socket.destroy(new Error('Header bound.'));
        const end = header.indexOf('\r\n\r\n'); if (end < 0) return;
        socket.removeListener('data', receive); if (end + 4 !== header.length) return socket.destroy(new Error('Unexpected proxy remainder.'));
        resolve(Number(/^HTTP\/1\.1 ([0-9]{3}) /u.exec(header.toString())?.[1]));
      }; socket.on('data', receive);
    });
    if (command.kind === 'denied' || status !== 200) { socket.destroy(); result = { connectStatus: status }; }
    else {
      const { connect } = await import('node:tls'); const tls = connect({ socket, servername: command.hostname, rejectUnauthorized: true }); let response = '';
      result = await new Promise((resolve, reject) => {
        tls.setTimeout(10000, () => tls.destroy(new Error('TLS observation deadline.'))); tls.once('error', reject);
        tls.once('secureConnect', () => tls.write(`GET /robots.txt HTTP/1.1\r\nHost: ${command.hostname}\r\nConnection: close\r\n\r\n`));
        tls.on('data', (bytes) => { response += bytes.toString('latin1'); if (response.length > 65536) tls.destroy(new Error('TLS response bound.')); });
        tls.once('end', () => resolve({ connectStatus: status, authorized: tls.authorized,
          status: Number(/^HTTP\/1\.[01] ([0-9]{3}) /u.exec(response)?.[1]), bytes: response.length }));
      }); tls.destroy();
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const [inputPath, output] = process.argv.slice(2); assert.equal(process.argv.length, 4, 'Usage: node --import tsx broker-coverage.mjs input.json fresh-output');
assert(isAbsolute(output)); assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const inputBytes = await readFile(inputPath), input = JSON.parse(inputBytes.toString()), { platform, capabilities } = input;
const authority = capabilities.network.routeAuthority, helper = capabilities.network.egress.configuration;
assert.equal(platform.engine, authority.engine.endpoint); assert.equal(capabilities.network.positive.hostname, 'github.com');
assert.equal(platform.profile, 'desktop-apple-virtualization-native-arm64');
assert.equal(authority.vmObserver.executable, '/usr/local/bin/agenai-sandbox-desktop-route'); assert.deepEqual(helper.user, { uid: 1000, gid: 1000 });
assert.equal(process.version, `v${platform.expected.controller.nodeVersion}`);
await mkdir(output, { mode: 0o700 }); assert.equal(await realpath(output), output);
const engine = new Engine(platform.engine.slice(7), '1.52', { requestMs: 15000, outputBytes: 4 * 1024 ** 2, frameBytes: 4 * 1024 ** 2 });
const token = randomUUID(), resources = [], labels = new Map(), streams = [], frames = [];
const report = { format: 'agenai.desktop-immutable-broker-research.v1', status: 'running', token, resources, effects: [], stages: [], frames,
  inputSha256: createHash('sha256').update(inputBytes).digest('hex'), cleanup: [],
  scope: 'Prepared broker helper with research tmpfs socket root; no public coordinator, route admission, relay/primary, held TLS tunnel, mixed-profile or exact absent-address reachability proof.' };
let ordinal = 0, totalBytes = 0, cleaning = false, writeTail = Promise.resolve(), initialEngine, listener, broker, configuration;
let timer, sequence = 0, expectedReply = 0, ready = false, closing = false, pump, controlFailure;
const signal = AbortSignal.timeout(180000), failed = (error) => ({ name: error.name, message: String(error.message).slice(0, 2048) });
const persist = () => { const bytes = `${JSON.stringify(report, null, 2)}\n`; writeTail = writeTail.then(() => writeFile(join(output, 'report.json'), bytes, { mode: 0o600 })); return writeTail; };
async function retain(kind, value, raw = false) {
  const bytes = raw ? Buffer.from(value) : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  assert(++ordinal <= (cleaning ? 2048 : 1920) && bytes.length <= 4 * 1024 ** 2 && (totalBytes += bytes.length) <= (cleaning ? 64 : 56) * 1024 ** 2);
  const path = join(output, `${String(ordinal).padStart(4, '0')}-${kind}`); await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); return path;
}
async function verifyEngine() { assert.equal((await engine.request('GET', '/info')).data.ID, authority.engine.id); }
async function effect(method, path, body, dispatch = () => engine.request(method, path, body)) {
  if (!cleaning) signal.throwIfAborted(); await verifyEngine(); assert(report.effects.length < 256);
  const entry = { sequence: report.effects.length + 1, method, path, body, state: 'intent' }; report.effects.push(entry);
  await retain('intent.json', entry); await persist(); entry.state = 'entered';
  try { const result = await dispatch(); entry.state = 'acknowledged'; await persist(); return result; }
  catch (error) { entry.state = 'unknown'; entry.failure = failed(error); await persist(); throw error; }
}
const api = { async json(method, path, schema) { const result = await engine.request(method, path.replace(/^\/v1\.52/u, ''));
  await retain('engine.json', { method, path, ...result }); return schema.parse(result.data); } };
class Channel {
  constructor(stream) { this.stream = stream; this.offset = 0; this.writeTail = Promise.resolve(); }
  send(frame) { const writing = this.writeTail.then(async () => { await retain('control-intent.json', frame); return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { this.stream.socket.destroy(); reject(new Error('Control write deadline.')); }, 10000);
    this.stream.socket.write(`${JSON.stringify(frame)}\n`, (error) => { clearTimeout(timeout); if (error) reject(error); else resolve(); });
  }); }); this.writeTail = writing; void writing.catch(() => {}); return writing; }
  line(timeout = 15000) { return until(() => {
    if (this.stream.failure) throw this.stream.failure; assert.equal(this.stream.stderr.length, 0);
    const bytes = this.stream.stdout.subarray(this.offset); assert(bytes.length <= 4096);
    const end = bytes.indexOf(10); if (end >= 0) { this.offset += end + 1; return JSON.parse(bytes.subarray(0, end).toString()); }
    assert(!this.stream.closed, 'Original control reader closed.'); return false;
  }, timeout, 'Control response deadline.'); }
}
async function exec(item, command, native = false) {
  const Cmd = native ? [authority.vmObserver.executable] : ['/usr/local/bin/node', '--input-type=module', '--eval', `(${probeMain.toString()})();`, JSON.stringify(command)];
  const created = await effect('POST', `/containers/${item.id}/exec`, { AttachStdout: true, AttachStderr: true, Tty: false, User: '1000:1000', Cmd });
  const target = `/exec/${created.data.Id}/start`, body = { Detach: false, Tty: false };
  const stream = await effect('POST', target, body, () => engine.hijack(target, body));
  try { await until(() => stream.closed, 15000, 'Fixed probe execution deadline.'); if (stream.failure) throw stream.failure;
    await retain(native ? 'vm-raw.json' : 'probe-stdout.json', stream.stdout, true); await retain('probe-stderr.txt', stream.stderr, true);
    const actual = (await engine.request('GET', `/exec/${created.data.Id}/json`)).data; await retain('exec.json', actual);
    assert.equal(actual.Running, false); assert.equal(actual.ExitCode, 0); assert.equal(stream.stderr.length, 0); assert.equal(stream.pending.length, 0);
    return JSON.parse(stream.stdout.toString());
  } finally { await stream.close(); }
}
async function network(role, allocation, receive = async (created) => created) {
  const item = { kind: 'network', role, name: `sdkc-broker-${token}-${role}`, id: null, acknowledged: false,
    labels: { 'ai.agen.research.broker': token, role } }; resources.push(item); await persist();
  const body = { Name: item.name, Driver: 'bridge', Internal: false, EnableIPv6: false, Attachable: false, Ingress: false,
    Labels: item.labels, IPAM: { Driver: 'default', Config: [{ Subnet: allocation.subnet, Gateway: allocation.gateway }] } };
  const created = await effect('POST', '/networks/create', body, async () => {
    const response = await engine.request('POST', '/networks/create', body);
    item.id = response.data.Id; item.acknowledged = true; await retain('network-create-response.json', response); await persist();
    return receive(response);
  }); assert(!created.data.Warning);
  const actual = (await engine.request('GET', `/networks/${item.id}`)).data; await retain('network.json', actual);
  assert.deepEqual(actual.IPAM.Config, [{ Subnet: allocation.subnet, Gateway: allocation.gateway, IPRange: '' }]);
  assert.equal(actual.Status.IPAM.Subnets[allocation.subnet].IPsInUse, 3); item.fingerprint = observationFingerprint({ ...actual, Containers: undefined, Status: undefined }); await persist(); return item;
}
async function container(role, image, networkMode, command, env, tmpfs, budget) {
  const item = { kind: 'container', role, name: `sdkc-broker-${token}-${role}`, id: null, acknowledged: false,
    labels: { ...labels.get(image), 'ai.agen.research.broker': token, role } }; resources.push(item); await persist();
  const body = { Image: image, User: '1000:1000', WorkingDir: role === 'broker' ? '/opt/agenai/egress' : '/',
    Entrypoint: ['/usr/local/bin/node'], Cmd: command, Env: env, Labels: item.labels, Tty: false,
    OpenStdin: true, StdinOnce: true, AttachStdin: true, AttachStdout: true, AttachStderr: true, Healthcheck: { Test: ['NONE'] },
    HostConfig: { ...isolatedHostPolicy(budget), NetworkMode: networkMode, Mounts: [], Tmpfs: tmpfs } };
  item.body = body; const created = await effect('POST', `/containers/create?name=${item.name}&platform=linux%2Farm64`, body);
  item.id = created.data.Id; item.acknowledged = true; assert(!created.data.Warnings?.length);
  const target = `/containers/${item.id}/attach?stream=1&stdin=1&stdout=1&stderr=1`;
  const stream = await effect('POST', target, undefined, () => engine.hijack(target)); streams.push(stream);
  Object.defineProperty(item, 'channel', { value: new Channel(stream), enumerable: false });
  await effect('POST', `/containers/${item.id}/start`);
  const actual = (await engine.request('GET', `/containers/${item.id}/json`)).data; await retain('container.json', actual);
  assert.equal(actual.Image, image); assert.equal(actual.Config.User, '1000:1000'); assert.deepEqual(actual.Config.Labels, item.labels);
  assert(matchesHostIsolation(actual.HostConfig, budget)); assert.equal(actual.HostConfig.NetworkMode, networkMode);
  assert.equal(actual.Mounts.length, 0); assert.equal(Object.keys(actual.NetworkSettings.Ports ?? {}).length, 0);
  item.fingerprint = containerFingerprint(actual); item.startedAt = actual.State.StartedAt;
  await persist(); return item;
}
async function remove(item) {
  await verifyEngine(); const path = item.kind === 'network' ? `/networks/${item.id ?? item.name}` : `/containers/${item.id ?? item.name}/json`;
  const inspected = await engine.request('GET', path, undefined, { allowed: [200, 404] });
  if (inspected.status === 200) {
    const actual = inspected.data; assert.equal(actual.Name, item.kind === 'network' ? item.name : `/${item.name}`);
    assert.deepEqual(actual.Config?.Labels ?? actual.Labels, item.labels); if (item.id) assert.equal(actual.Id, item.id);
    if (item.fingerprint) assert.equal(item.kind === 'container' ? containerFingerprint(actual)
      : observationFingerprint({ ...actual, Containers: undefined, Status: undefined }), item.fingerprint);
    const target = item.kind === 'network' ? `/networks/${actual.Id}` : `/containers/${actual.Id}?force=true&v=false`;
    await effect('DELETE', target, undefined, () => engine.request('DELETE', target, undefined, { allowed: [204, 404] }));
  }
  assert.equal((await engine.request('GET', path, undefined, { allowed: [404] })).status, 404);
  item.removed = item.acknowledged; report.cleanup.push({ role: item.role, name: item.name, id: item.id, status: 404, acknowledged: item.acknowledged }); await persist();
}
async function stage(phase, directAddress, privateHostname, port) {
  if (controlFailure) throw controlFailure; const before = frames.filter(({ kind }) => kind === 'heartbeat').at(-1)?.sequence ?? 0;
  await listener.channel.send({ kind: 'census', id: report.stages.length * 2 + 1 }); const first = await listener.channel.line();
  const direct = await exec(broker, { kind: 'direct', address: directAddress, port, token }); assert.equal(direct.response, `${token}\n`);
  await listener.channel.send({ kind: 'census', id: report.stages.length * 2 + 2 }); const reachable = await listener.channel.line();
  assert.equal(reachable.counts.connections, first.counts.connections + 1); assert.equal(reachable.counts.requests, first.counts.requests + 1);
  const dns = await exec(broker, { kind: 'dns', hostname: privateHostname }); assert.deepEqual(dns, { ipv4: [report.future.gateway], ipv6: [] }, 'Private DNS prerequisite did not resolve the selected future address.');
  const denied = await exec(broker, { kind: 'denied', hostname: privateHostname, port }); assert.equal(denied.connectStatus, 403);
  assert(!configuration.destinations.some(({ hostname }) => hostname === 'example.com'));
  const unlisted = await exec(broker, { kind: 'denied', hostname: 'example.com', port: 443 }); assert.equal(unlisted.connectStatus, 403);
  await listener.channel.send({ kind: 'census', id: report.stages.length * 2 + 3 }); const unchanged = await listener.channel.line();
  assert.equal(unchanged.counts.connections, reachable.counts.connections, 'Broker denial connected to the forbidden listener.');
  assert.equal(unchanged.counts.requests, reachable.counts.requests, 'Broker denial sent bytes to the forbidden listener.');
  const positive = await exec(broker, { kind: 'tls', hostname: 'github.com', port: 443 });
  assert.equal(positive.connectStatus, 200); assert.equal(positive.authorized, true); assert.equal(positive.status, 200);
  await delay(helper.control.heartbeatMs * 2, undefined, { signal }); if (controlFailure) throw controlFailure;
  const after = frames.filter(({ kind }) => kind === 'heartbeat').at(-1)?.sequence ?? 0; assert(after > before, 'Original heartbeat did not progress.');
  const actual = (await engine.request('GET', `/containers/${broker.id}/json`)).data;
  assert.equal(actual.State.StartedAt, broker.startedAt); assert.equal(containerFingerprint(actual), broker.fingerprint);
  assert.equal(actual.Config.Env.find((value) => value.startsWith(`${EGRESS_CONFIG_ENV}=`)), `${EGRESS_CONFIG_ENV}=${JSON.stringify(configuration)}`);
  report.stages.push({ phase, directAddress, targetAddressExists: directAddress === report.future.gateway,
    dns, first: first.counts, reachable: reachable.counts, unchanged: unchanged.counts, denied, unlisted, positive, heartbeatBefore: before, heartbeatAfter: after }); await persist();
}
async function delayedObservation(occupied, current, future) {
  assert.equal(LIMITS.effectMs, 30000); assert.equal(helper.control.heartbeatMs, LIMITS.heartbeatMs); assert.equal(helper.control.leaseTimeoutMs, LIMITS.leaseMs);
  const model = new TransitionModel(), started = performance.now(), entered = Promise.withResolvers();
  model.persistMember('observation-port', occupied); model.activate('observation-port'); model.observe(started, started, true);
  model.persistMember('delayed-member', occupied); assert.equal(model.members.get('observation-port').subnet, current.subnet);
  assert.equal(model.members.get('delayed-member').subnet, future.subnet);
  const id = model.enqueue('delayed-member', 'network-create'); assert.equal(model.next(started), id);
  model.persistResourceIntent(id); model.persistTransitionIntent(id); model.dispatch(id);
  const proof = { kind: 'native-effect-with-delayed-client-delivery-and-logical-fence', effectMs: LIMITS.effectMs, deliveryHoldMs: 31000,
    modeledObservationPort: 'Explicit positive logical precondition; not native VM freshness or broker observation capability.',
    modelPersistence: 'In-memory model methods only; no coordinator durability claim.', heartbeatBefore: sequence, transitions: [] };
  report.delay = proof; const effectOffset = report.effects.length; let deliverySettled = false;
  const creating = network('delay', future, async (response) => {
    proof.nativeId = response.data.Id; proof.nativeAcknowledgedMs = performance.now() - started;
    entered.resolve(); await delay(proof.deliveryHoldMs); deliverySettled = true; return response;
  }); void creating.catch(entered.reject);
  try {
    await entered.promise; await delay(Math.max(0, started + LIMITS.effectMs + 50 - performance.now()));
    model.deadline(performance.now()); assert.equal(model.mode, 'fenced'); assert.equal(model.dirty, true);
    assert.equal(model.transitions.get(id).phase, 'uncertain'); assert.equal(model.next(performance.now()), null);
    assert.throws(() => model.enqueue('delayed-member', 'new-topology'), /fenced/u); assert.equal(deliverySettled, false);
    assert.equal(report.effects.slice(effectOffset).filter(({ method, path }) => method === 'POST' && path === '/networks/create').length, 1);
    if (controlFailure) throw controlFailure; assert(sequence >= proof.heartbeatBefore + 2);
    proof.fencedAtMs = performance.now() - started; proof.heartbeatAtFence = sequence;
    proof.transitions.push({ mode: model.mode, pending: structuredClone([...model.transitions.values()]), trace: [...model.trace],
      executionAdmission: 'closed in research model', physicalHelper: 'original reader/heartbeat still active for observation and cleanup' }); await persist();
    const item = await creating; model.returned(id, item.id); model.persistMemberResult(id); model.persistSettlement(id);
    assert.equal(model.mode, 'fenced'); proof.joinedAtMs = performance.now() - started;
  } finally {
    await creating.catch(() => {}); const item = resources.find(({ role }) => role === 'delay');
    if (item && !item.removed) await remove(item);
    if (item?.removed && model.members.get('delayed-member').resources.has(item.id)) model.confirmRemoved('delayed-member', item.id, true, true);
    proof.finalModelMode = model.mode; proof.finalTrace = [...model.trace]; proof.exactResourceRemoved = item?.removed ?? false;
    proof.deliverySettled = deliverySettled; await persist();
  }
}
try {
  report.source = { probe: await retain('source.mjs', await readFile(new URL(import.meta.url)), true),
    model: await retain('transition-model.ts', await readFile(new URL('../transitions/model.ts', import.meta.url)), true) };
  await verifyEngine(); initialEngine = await readDesktopEngineNetworks(api);
  assert(!initialEngine.networks.some(({ Labels }) => Object.keys(Labels).some((key) => key.startsWith('ai.agen.sandbox.'))));
  for (const image of [authority.vmObserver.imageDigest, helper.imageDigest]) {
    const actual = (await engine.request('GET', `/images/${image}/json`)).data; await retain('image.json', actual);
    assert.equal(actual.Id, image); assert.equal(actual.Architecture, 'arm64'); assert.equal(actual.Os, 'linux'); labels.set(image, Object.freeze({ ...actual.Config.Labels }));
  }
  const tmp = { '/tmp': 'rw,nosuid,nodev,noexec,size=4194304,uid=1000,gid=1000,mode=0700' };
  listener = await container('listener', authority.vmObserver.imageDigest, 'host', ['--input-type=module', '--eval', `(${listenerMain.toString()})();`, token], HELPER_ENVIRONMENT, tmp, capabilities.workload.resources);
  const listening = await listener.channel.line(); assert.equal(listening.ready, true); assert.equal(listening.uid, 1000);
  const host = await readDesktopHostObservation(authority, signal), vm = parseDesktopVmObservation(await exec(listener, null, true)); await retain('parsed-observations.json', { host, vm });
  const cidrs = [...host.excludedCidrs, ...vm.excludedCidrs, ...initialEngine.networks.flatMap(({ IPAM }) => (IPAM.Config ?? []).flatMap(({ Subnet }) => Subnet ? [Subnet] : []))];
  const occupied = cidrs.filter((cidr) => !cidr.includes(':')).map((cidr) => { const [address, prefix] = cidr.split('/'); return `${formatNumericAddress(nativeAddressNumber(address, 4) & prefixMask(4, Number(prefix)), 4)}/${prefix}`; });
  const current = selectAllocation(occupied, [], [cidrs]), future = selectAllocation(occupied, [current.subnet], [cidrs]); report.future = future;
  const privateHostname = `${future.gateway.replaceAll('.', '-')}.nip.io`, base = await network('a', current);
  configuration = parseEgressHelperConfiguration({ protocol: EGRESS_PROTOCOL, role: 'broker', leaseTimeoutMs: helper.control.leaseTimeoutMs,
    excludedCidrs: cidrs, destinations: [{ hostname: privateHostname, port: listening.port }, { hostname: 'github.com', port: 443 }] });
  assert.deepEqual(deniedCoverage([...configuration.excludedCidrs, future.subnet]), configuration.excludedCidrs);
  report.configuration = configuration; report.control = helper.control;
  broker = await container('broker', helper.imageDigest, base.id, helperCommand('broker'), [...HELPER_ENVIRONMENT, `${EGRESS_CONFIG_ENV}=${JSON.stringify(configuration)}`],
    { ...tmp, '/run/agenai-egress': 'rw,nosuid,nodev,noexec,size=1048576,uid=1000,gid=1000,mode=0700' }, helper.broker.resources);
  const beat = async () => { if (closing) return; expectedReply = ++sequence; await broker.channel.send({ protocol: EGRESS_PROTOCOL, kind: 'heartbeat', sequence }); };
  pump = (async () => { for (;;) {
    const frame = parseHelperFrame(await broker.channel.line(helper.control.leaseTimeoutMs)); frames.push({ ...frame, observedAt: new Date().toISOString() }); assert(frames.length <= 256);
    await retain('helper-frame.json', frame);
    if (frame.kind === 'ready') { assert.equal(frame.role, 'broker'); assert(!ready); ready = true; }
    else if (frame.kind === 'heartbeat') { assert.equal(frame.sequence, expectedReply); expectedReply = 0; if (!closing) timer = setTimeout(() => { void beat().catch((error) => { controlFailure = error; }); }, helper.control.heartbeatMs); }
    else { assert(closing && frame.reason === 'stop'); break; }
  } })().catch((error) => { controlFailure = error; });
  await beat(); await until(() => { if (controlFailure) throw controlFailure; return ready; }, 15000, 'Prepared broker readiness deadline.');
  await stage('before-addition', current.gateway, privateHostname, listening.port);
  const added = await network('b', future); await stage('future-address-reachable', future.gateway, privateHostname, listening.port);
  await remove(added); await stage('after-removal', current.gateway, privateHostname, listening.port);
  await delayedObservation(occupied, current, future);
  report.mechanism = 'passed';
} catch (error) { report.failure = failed(error); }
finally {
  cleaning = true; closing = true; clearTimeout(timer);
  if (broker?.channel) { try { await broker.channel.send({ protocol: EGRESS_PROTOCOL, kind: 'stop' }); await until(() => broker.channel.stream.closed, 15000, 'Broker stop deadline.'); await pump; } catch (error) { report.controlCleanupFailure = failed(error); } }
  for (const item of [...resources].reverse()) if (!item.removed) { try { await remove(item); } catch (error) { report.cleanup.push({ name: item.name, failure: failed(error) }); } }
  for (const stream of streams) { try { await retain('original-reader-stdout.jsonl', stream.stdout, true); await stream.close(); } catch (error) { report.cleanup.push({ failure: failed(error) }); } }
  try {
    await verifyEngine(); const final = await readDesktopEngineNetworks(api); await retain('final-engine.json', final);
    if (initialEngine) assert.equal(observationFingerprint(final), observationFingerprint(initialEngine));
    const absence = []; for (const item of resources) for (const reference of [...new Set([item.name, item.id].filter(Boolean))]) {
      const path = item.kind === 'network' ? `/networks/${reference}` : `/containers/${reference}/json`;
      absence.push({ name: item.name, reference, status: (await engine.request('GET', path, undefined, { allowed: [404] })).status });
    } report.finalExactAbsence = await retain('final-absence.json', absence);
  } catch (error) { report.finalObservationFailure = failed(error); }
  report.status = report.mechanism === 'passed' && resources.every(({ removed }) => removed) && !controlFailure
    && !report.cleanup.some(({ failure }) => failure) && !report.controlCleanupFailure && !report.finalObservationFailure ? 'passed' : 'failed';
  if (controlFailure) report.controlFailure = failed(controlFailure); report.finishedAt = new Date().toISOString(); await persist();
}
process.stdout.write(`${JSON.stringify({ status: report.status, output, stages: report.stages.length, heartbeats: sequence })}\n`);
if (report.status !== 'passed') process.exitCode = 1;
