import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from './session.mjs';
import { failure, observe, sha } from './evidence.mjs';
import { resourcePath } from '../capabilities/network/resources.mjs';

export async function reserveMember(context, label, hostname) {
  const { input, sdk, docker, authority, routeAuthority, evidence } = context;
  const directory = join(input.output, label); await mkdir(directory, { mode: 0o700 });
  const spillDirectory = join(directory, 'spill'); await mkdir(spillDirectory, { mode: 0o700 });
  const namespace = `${context.namespace}-${label}`;
  const token = randomUUID();
  const report = { label, hostname, namespace, token, checkpoints: [], stages: [], originalRecord: null, finalRecord: null, cleanup: [] };
  const entry = { report, owner: null, sandbox: null, process: null, session: null, token, label, tasks: [],
    hostFile: JSON.stringify({ label, token, origin: 'original-controller-live-file' }) + '\n' };
  context.members.push(entry); context.report.members.push(report);
  const backend = docker.createCoordinatedDockerSandboxBackend({ endpoint: input.platform.engine, profile: input.platform.profile,
    namespace, spillDirectory, imageDigest: input.platform.sourceImage, user: input.capabilities.workload.user,
    filesystem: input.capabilities.filesystem.configuration,
    egress: { ...input.capabilities.network.egress.configuration, routeAuthority }, coordinator: authority });
  let checkpoint = 0;
  entry.owner = backend.reserve(sdk.parseSandboxRequest({ policy: {
    resources: input.capabilities.workload.resources,
    temporaryStorage: { homeBytes: input.capabilities.workload.temporaryBytes, tempBytes: input.capabilities.workload.temporaryBytes },
    network: { kind: 'restricted_https', destinations: [{ hostname, port: 443 }] }, files: { kind: 'read_write' },
    execution: { kind: 'until_stopped' },
    deadlines: { startupMs: input.capabilities.limits.startupMs, cleanupMs: input.capabilities.limits.cleanupMs },
    transfers: sdk.SANDBOX_DEFAULT_TRANSFER_BUFFERS,
    streams: { ...sdk.SANDBOX_DEFAULT_STREAM_LIMITS, maxStdinBytes: 1024 ** 2, maxOutputBytes: 1024 ** 2 },
  } }), { kind: 'persisted', async persist(record) {
    assert(++checkpoint <= 256);
    const stored = await evidence.file(`${label}/checkpoint-${String(checkpoint).padStart(4, '0')}.json`, record, 65_536);
    report.checkpoints.push({ ...stored, phase: record.phase });
    await evidence.event({ kind: 'original-checkpoint', label, checkpoint, phase: record.phase, file: stored });
  } });
  report.originalRecord = entry.owner.recoveryRecord;
  await evidence.file(`${label}/reservation.json`, report.originalRecord, 65_536);
  await evidence.event({ kind: 'original-member-reserved', label, namespace });
  return entry;
}

export async function startMember(context, entry) {
  const { evidence, sdk, input } = context;
  const start = entry.owner.start({ signal: context.signal }); entry.tasks.push(start);
  entry.sandbox = await observe(start, input.capabilities.limits.startupMs + 5000, `${entry.label} sandbox startup`);
  assert.equal(entry.sandbox.files.kind, 'read_write');
  const sources = ['guest.mjs', 'guest-network.mjs'].map((name) =>
    sdk.fileFromBytes(`qualification/${name}`, context.guestSources.get(name)));
  await entry.sandbox.importTree(sources, { signal: context.signal });
  const written = await entry.sandbox.files.writeFile('host-owned.json', [Buffer.from(entry.hostFile)], { mode: 'create', signal: context.signal });
  assert.equal(written.kind, 'completed'); assert.equal(written.effect, 'published');
  entry.process = entry.sandbox.reserveProcess({ executable: '/usr/local/bin/node',
    args: [`${entry.sandbox.workspace}/qualification/guest.mjs`, entry.label, entry.token, String(input.capabilities.limits.requestMs)],
    cwd: entry.sandbox.workspace, env: { LANG: 'C.UTF-8' } });
  const starting = entry.process.start({ signal: context.signal }); entry.tasks.push(starting);
  const streams = await observe(starting, input.capabilities.limits.requestMs + 5000, `${entry.label} original primary startup`);
  entry.session = new Session(streams, entry.label, entry.token, input.capabilities.limits.requestMs, evidence);
  await entry.session.ready; await entry.session.progress();
  const identity = entry.session.identity;
  assert.equal(identity.platform, 'linux'); assert.equal(identity.uid, input.capabilities.workload.user.uid);
  assert.equal(identity.gid, input.capabilities.workload.user.gid);
  assert.equal(identity.architecture, input.platform.profile.endsWith('rosetta-amd64') ? 'x64' : 'arm64');
  entry.report.process = { reservationId: entry.process.id, stopScope: entry.process.stopScope,
    readerId: entry.session.readerId, identity };
  await evidence.event({ kind: 'original-primary-ready', label: entry.label, process: entry.report.process });
}

export async function readLive(entry, path) {
  let bytes = Buffer.alloc(0);
  const result = await entry.sandbox.files.readFile(path, async ({ entry: file, chunks }) => {
    assert.equal(file.kind, 'file'); assert.equal(file.path, path);
    for await (const chunk of chunks) { bytes = Buffer.concat([bytes, chunk]); assert(bytes.length <= 16 * 1024); }
  }, { quotas: { maxBytes: 16 * 1024 } });
  assert(result.kind === 'completed' || result.kind === 'changed');
  assert.equal(BigInt(bytes.length), result.bytes);
  return { result, text: bytes.toString('utf8') };
}

export async function continuity(context, entry, phase, previous = entry.session.lastTick.counter) {
  context.signal.throwIfAborted();
  const output = await entry.session.progress(previous);
  assert.equal(output.readerId, entry.report.process.readerId);
  assert.deepEqual(output.identity, entry.report.process.identity);
  assert.equal(output.closed, false); assert.equal(output.failure, null); assert.equal(output.exit, null);
  assert.equal(output.stderrBytes, 0, 'Controlled guest emitted unexpected diagnostics.');
  const counter = JSON.parse((await readLive(entry, 'counter.json')).text);
  assert.equal(counter.pid, output.identity.pid); assert.equal(counter.session, entry.token); assert.equal(counter.label, entry.label);
  assert(counter.counter >= previous + 3);
  const host = await readLive(entry, 'host-owned.json'); assert.equal(host.result.kind, 'completed'); assert.equal(host.text, entry.hostFile);
  const guest = await entry.session.request({ kind: 'identity' });
  assert.equal(guest.pid, output.identity.pid); assert.equal(guest.session, entry.token); assert.equal(guest.hostFile, entry.hostFile);
  const proof = { phase, output, counter, host, guest, state: entry.owner.state, record: entry.owner.recoveryRecord };
  entry.report.stages.push(await context.evidence.file(`${entry.label}/continuity-${String(entry.report.stages.length + 1).padStart(3, '0')}.json`, proof));
  await context.evidence.event({ kind: 'continuity', label: entry.label, phase, counter: counter.counter, readerId: output.readerId, pid: counter.pid });
  return counter.counter;
}

export async function networkProof(context, entry, allowed, denied, phase) {
  context.signal.throwIfAborted();
  const positive = await entry.session.request({ kind: 'tls', hostname: allowed });
  assert.equal(positive.proxyStatus, 200); assert.equal(positive.authorized, true);
  assert(positive.status >= 200 && positive.status < 400);
  context.signal.throwIfAborted();
  const negative = await entry.session.request({ kind: 'connect', hostname: denied });
  assert.equal(negative.proxyStatus, 403);
  await context.evidence.event({ kind: 'member-destination-separation', phase, label: entry.label, positive, negative });
}

export async function stopAndExport(context, entry) {
  entry.session.expectStop();
  const original = entry.owner.recoveryRecord;
  const stopping = entry.owner.stop(); entry.tasks.push(stopping);
  await observe(stopping, 60_000, `${entry.label} original explicit stop`);
  assert.equal(entry.owner.state.kind, 'stopped');
  entry.report.outputSettlement = await observe(entry.session.join(), 20_000, `${entry.label} stopped original output join`);
  const record = entry.owner.recoveryRecord;
  const producers = [];
  for (const resource of original.resources.filter(({ role }) => ['compute', 'route_observer', 'filesystem', 'egress_broker', 'egress_relay'].includes(role))) {
    assert.equal(resource.identity.kind, 'identified');
    const inspected = await context.engine.request('GET', resourcePath(resource), undefined, { allowed: [200, 404] });
    if (inspected.status === 200) { assert.equal(inspected.data.Id, resource.identity.id); assert.equal(inspected.data.State.Running, false); }
    producers.push({ resource, inspection: inspected });
  }
  const retained = [];
  for (const role of ['network', 'storage', 'egress_socket']) {
    const resource = original.resources.find((item) => item.role === role); assert(resource);
    assert.equal(resource.identity.kind, 'identified');
    assert.deepEqual(record.resources.find((item) => item.role === role), resource, 'Stop changed a retained original resource identity.');
    const inspected = await context.engine.request('GET', resourcePath(resource));
    assert.equal(role === 'network' ? inspected.data.Id : inspected.data.Name, resource.identity.id);
    retained.push({ role, resource, inspection: inspected });
  }
  const paths = ['host-owned.json', 'identity.json', 'counter.json']; const exported = [];
  const summary = await entry.sandbox.exportTree({ kind: 'files', paths }, async (file) => {
    assert.equal(file.kind, 'file'); assert(paths.includes(file.path)); assert(!exported.some((item) => item.path === file.path));
    let bytes = Buffer.alloc(0);
    for await (const chunk of file.bytes) { bytes = Buffer.concat([bytes, chunk]); assert(bytes.length <= 16 * 1024); }
    if (file.path === 'host-owned.json') assert.equal(bytes.toString('utf8'), entry.hostFile);
    else {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (file.path === 'identity.json') assert.deepEqual(value, entry.report.process.identity);
      else {
        assert.equal(value.pid, entry.report.process.identity.pid); assert.equal(value.session, entry.token); assert.equal(value.label, entry.label);
        assert(value.counter >= entry.session.lastTick.counter);
      }
    }
    exported.push({ path: file.path, bytes: bytes.length, sha256: sha(bytes),
      original: await context.evidence.file(`${entry.label}/stopped-${file.path}`, bytes, 16 * 1024) });
  }, { signal: context.signal });
  assert.deepEqual(exported.map(({ path }) => path).sort(), paths.sort());
  entry.report.stopped = { state: entry.owner.state, record, retained, producers, summary, exported };
  await context.evidence.file(`${entry.label}/stopped-export.json`, entry.report.stopped);
  await context.evidence.event({ kind: 'stopped-original-export-and-retained-topology', label: entry.label, record, retained, exported, summary });
}

export async function exactAbsence(context, entry) {
  const result = [];
  for (const resource of entry.owner.recoveryRecord.resources) {
    const references = resource.identity.kind === 'identified' ? [...new Set([resource.name, resource.identity.id])] : [resource.name];
    for (const reference of references) {
      const selected = { ...resource, identity: { kind: 'identified', id: reference } };
      const observed = await context.engine.request('GET', resourcePath(selected), undefined, { allowed: [404] });
      result.push({ role: resource.role, name: resource.name, reference, status: observed.status });
    }
  }
  await context.evidence.event({ kind: 'independent-exact-name-and-id-absence', label: entry.label, result });
  return result;
}

export async function cleanupMember(context, entry) {
  if (!entry.owner) return;
  entry.session?.expectStop();
  try {
    const destroy = entry.owner.destroy(); entry.tasks.push(destroy);
    await observe(destroy, 60_000, `${entry.label} original-owner destruction`);
    if (entry.session) entry.report.outputSettlement = await observe(entry.session.join(), 20_000, `${entry.label} original output join`);
    await observe(Promise.allSettled(entry.tasks), 20_000, `${entry.label} entered-operation join`);
    entry.report.finalRecord = entry.owner.recoveryRecord;
    entry.report.finalState = entry.owner.state;
    entry.report.absence = await exactAbsence(context, entry);
    entry.report.cleanup.push({ kind: 'settled', at: new Date().toISOString() });
    await context.evidence.event({ kind: 'original-member-cleanup-settled', label: entry.label, state: entry.owner.state });
  } catch (error) {
    const observed = { kind: 'retained', at: new Date().toISOString(), failure: failure(error), record: entry.owner.recoveryRecord, state: entry.owner.state };
    entry.report.cleanup.push(observed);
    await context.evidence.event({ kind: 'original-member-cleanup-retained', label: entry.label, ...observed });
    throw error;
  }
}
