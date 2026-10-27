import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileFromBytes, parseSandboxRequest, SANDBOX_DEFAULT_STREAM_LIMITS,
  SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { createDockerDesktopRouteAuthority, createDockerLinuxRouteAuthority } from '@agen-ai/sandbox-docker/node';
import { GuestSession } from '../../../capabilities/production/session.mjs';
import { jsonWriter } from '../live/evidence.mjs';
import { census } from './resources.mjs';

export const header = (authority) => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;

export function request(config, { kind = 'restricted_https', destinations, access = 'disabled' } = {}) {
  const manifest = config.capabilities;
  return parseSandboxRequest({ policy: {
    resources: manifest.workload.resources,
    temporaryStorage: { homeBytes: manifest.workload.temporaryBytes, tempBytes: manifest.workload.temporaryBytes },
    network: kind === 'restricted_https' ? { kind, destinations: destinations ?? [{
      hostname: manifest.network.positive.hostname, port: manifest.network.positive.port }] } : { kind },
    files: { kind: access }, execution: { kind: 'until_stopped' },
    deadlines: { startupMs: manifest.limits.startupMs, cleanupMs: manifest.limits.cleanupMs },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS,
    streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS, maxStdinBytes: 1024 ** 2, maxOutputBytes: manifest.limits.maxOutputBytes },
  } });
}

export async function backend(config, { namespace, directory, endpoint = config.endpoint, egress = true,
  filesystem = false, hostExecutable = config.capabilities.network.routeAuthority.hostObserver?.executable } = {}) {
  const spillDirectory = join(directory, 'spill'); await mkdir(spillDirectory, { recursive: true, mode: 0o700 });
  const captured = config.capabilities.network.routeAuthority;
  const effectiveAuthority = config.profile === 'linux-x64' ? captured : { ...captured, engine: { ...captured.engine, endpoint },
    hostObserver: { ...captured.hostObserver, executable: hostExecutable } };
  const socket = await lstat(endpoint.slice(7), { bigint: true }); assert(socket.isSocket() && !socket.isSymbolicLink());
  const proxyIdentity = { endpoint, device: String(socket.dev), inode: String(socket.ino), mode: String(socket.mode),
    uid: String(socket.uid), gid: String(socket.gid) };
  const descriptor = JSON.stringify(effectiveAuthority);
  const effectiveAuthorityInput = { utf8: descriptor, bytes: Buffer.byteLength(descriptor), sha256: createHash('sha256').update(descriptor).digest('hex') };
  return { backend: createDockerSandboxBackend({ endpoint, profile: config.profile, namespace, spillDirectory,
    imageDigest: config.imageDigest, user: config.capabilities.workload.user,
    ...(filesystem ? { filesystem: config.capabilities.filesystem.configuration } : {}),
    ...(egress ? { egress: { ...config.capabilities.network.egress.configuration,
      routeAuthority: config.profile === 'linux-x64' ? createDockerLinuxRouteAuthority(effectiveAuthority)
        : createDockerDesktopRouteAuthority(effectiveAuthority) } } : {}) }), effectiveAuthority, effectiveAuthorityInput, proxyIdentity };
}

export async function reserve(run, context, options = {}) {
  assert.equal(run.owners.length, 0, 'Each network case owns one original SDK reservation.');
  const directory = join(run.directory, 'owner'); await mkdir(directory, { mode: 0o700 });
  const namespace = options.namespace ?? `${context.config.namespacePrefix}${randomUUID()}`;
  const selected = await backend(context.config, { namespace, directory, ...options });
  const entry = { namespace, directory, record: null, checkpoints: [], proxyIdentity: selected.proxyIdentity };
  const writeRecord = jsonWriter(join(directory, 'recovery.json'));
  let sequence = 0;
  const owner = selected.backend.reserve(request(context.config, options), { kind: 'persisted', async persist(record) {
    const checkpoint = { sequence: ++sequence, phase: record.phase, record: structuredClone(record) };
    await jsonWriter(join(directory, `checkpoint-${String(sequence).padStart(4, '0')}.json`))(record);
    await writeRecord(record); entry.record = record; entry.checkpoints.push(checkpoint);
    assert(entry.checkpoints.length <= 256, 'Network checkpoint count exceeds its captured bound.');
    await run.save();
  } });
  entry.owner = owner; entry.record = owner.recoveryRecord; run.owners.push(entry);
  run.evidence.owners.push({ namespace, directory, recoveryPath: join(directory, 'recovery.json'),
    effectiveAuthority: selected.effectiveAuthority, effectiveAuthorityInput: selected.effectiveAuthorityInput,
    proxyIdentity: selected.proxyIdentity, endpointProjection: { capturedEndpoint: context.config.capabilities.network.routeAuthority.engine.endpoint,
      effectiveEndpoint: selected.proxyIdentity.endpoint, engineId: context.config.capabilities.network.routeAuthority.engine.id,
      upstream: context.config.endpointProjection } });
  await writeRecord(owner.recoveryRecord); await run.save();
  return { entry, owner, selected };
}

export async function ready(run, context, options = {}) {
  const reserved = await reserve(run, context, options);
  const sandbox = await reserved.owner.start({ signal: context.signal });
  run.evidence.effective = sandbox.effective;
  const source = await readFile(new URL('./guest.mjs', import.meta.url));
  await sandbox.importTree([fileFromBytes('qualification/network-guest.mjs', source)]);
  const processOwner = sandbox.reserveProcess({ executable: '/usr/local/bin/node',
    args: [`${sandbox.workspace}/qualification/network-guest.mjs`, String(context.config.capabilities.limits.requestMs)],
    cwd: sandbox.workspace, env: { LANG: 'C.UTF-8' } });
  const session = new GuestSession(await processOwner.start({ signal: context.signal }), context.config.capabilities.limits.requestMs);
  run.sessions.push(session); await session.ready;
  const facts = await session.request({ kind: 'facts' }); assert.equal(facts.ok, true, JSON.stringify(facts));
  assert.equal(facts.result.platform, 'linux');
  assert.equal(facts.result.architecture, context.config.profile.endsWith('rosetta-amd64') ? 'x64' : 'arm64');
  assert.equal(facts.result.node, `v${context.config.guestNodeVersion}`);
  assert.equal(facts.result.uid, context.config.capabilities.workload.user.uid);
  assert.equal(facts.result.gid, context.config.capabilities.workload.user.gid);
  await run.observe({ kind: 'installed-network-guest', facts: facts.result,
    census: await census(context.engine, reserved.owner.recoveryRecord, 'guest-ready') });
  return { ...reserved, sandbox, session, facts: facts.result };
}

export async function positive(opened, context) {
  const expected = context.config.capabilities.network.positive;
  const response = await opened.session.request({ kind: 'tls', ...expected });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.authorized, true); assert.equal(response.result.status, expected.status);
  assert.equal(response.result.bodyBytes, expected.bodyBytes); assert.equal(response.result.bodySha256, expected.bodySha256);
  return response.result;
}
