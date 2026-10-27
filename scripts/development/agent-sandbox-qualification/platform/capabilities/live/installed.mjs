import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileFromBytes, parseSandboxRequest, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { GuestSession } from '../../../capabilities/production/session.mjs';
import { census, jsonWriter } from './evidence.mjs';

export function assertGuestFacts(config, facts) {
  assert.equal(facts.platform, 'linux');
  assert.equal(facts.architecture, config.profile === 'desktop-apple-virtualization-native-arm64' ? 'arm64' : 'x64');
  assert.equal(facts.nodeVersion, config.guestNodeVersion);
  assert.equal(facts.uid, config.capabilities.workload.user.uid);
  assert.equal(facts.gid, config.capabilities.workload.user.gid);
}

export function request(config, { access = 'read_write', cleanupMs } = {}) {
  const manifest = config.capabilities;
  return parseSandboxRequest({ policy: {
    resources: manifest.workload.resources,
    temporaryStorage: { homeBytes: manifest.workload.temporaryBytes, tempBytes: manifest.workload.temporaryBytes },
    network: { kind: 'isolated' }, files: { kind: access }, execution: { kind: 'until_stopped' },
    deadlines: { startupMs: manifest.limits.startupMs, cleanupMs: cleanupMs ?? manifest.limits.cleanupMs },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS,
    streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS, maxStdinBytes: 1024 ** 2, maxOutputBytes: manifest.limits.maxOutputBytes },
  } });
}

export async function backend(config, { namespace, directory, endpoint = config.endpoint, filesystem = true }) {
  const spillDirectory = join(directory, 'spill');
  await mkdir(spillDirectory, { recursive: true, mode: 0o700 });
  return createDockerSandboxBackend({ endpoint, profile: config.profile, namespace, spillDirectory,
    imageDigest: config.imageDigest, user: config.capabilities.workload.user,
    ...(filesystem ? { filesystem: config.capabilities.filesystem.configuration } : {}) });
}

export async function reserve(run, context, options = {}) {
  const namespace = `${context.config.namespacePrefix}${randomUUID()}`;
  const directory = join(run.directory, `owner-${run.owners.length}`);
  await mkdir(directory, { mode: 0o700 });
  const selected = await backend(context.config, { namespace, directory, ...options });
  const entry = { namespace, directory, record: null, checkpoints: [] };
  const writeRecord = jsonWriter(join(directory, 'recovery.json'));
  let sequence = 0;
  const owner = selected.reserve(request(context.config, options), { kind: 'persisted', async persist(record) {
    await jsonWriter(join(directory, `checkpoint-${String(++sequence).padStart(4, '0')}.json`))(record);
    await writeRecord(record);
    entry.record = record; entry.checkpoints.push({ sequence, phase: record.phase, resources: record.resources });
    await run.save();
  } });
  entry.owner = owner; entry.record = owner.recoveryRecord;
  run.owners.push(entry); run.evidence.owners.push({ namespace, directory, recoveryPath: join(directory, 'recovery.json') });
  await writeRecord(owner.recoveryRecord);
  await run.save();
  return { owner, selected, entry };
}

export async function guest(run, context, options = {}) {
  const reserved = await reserve(run, context, options);
  const sandbox = await reserved.owner.start({ signal: context.signal });
  const source = await readFile(new URL('../../../capabilities/live/guest.mjs', import.meta.url));
  await sandbox.importTree([fileFromBytes('qualification/live-guest.mjs', source), ...(options.imports ?? [])]);
  const processOwner = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: [`${sandbox.workspace}/qualification/live-guest.mjs`],
    cwd: sandbox.workspace, env: { LANG: 'C.UTF-8' } });
  const streams = await processOwner.start({ signal: context.signal });
  const session = new GuestSession(streams, context.config.capabilities.limits.requestMs);
  run.sessions.push(session);
  await session.ready;
  const facts = await send(session, { kind: 'facts' });
  assertGuestFacts(context.config, facts);
  run.evidence.observations.push({ kind: 'installed-running-guest', namespace: reserved.entry.namespace,
    facts, files: sandbox.files.kind,
    census: await census(context.engine, reserved.owner.recoveryRecord, 'guest-ready') });
  await run.save();
  return { ...reserved, sandbox, files: sandbox.files, session };
}

export async function send(session, command) {
  const response = await session.request(command);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response;
}
