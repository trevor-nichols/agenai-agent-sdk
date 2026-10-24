// ------------------------------------------------------------------------------------------------
//                common.ts - Explicit real Engine fixture inputs and independent observations
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { parseSandboxRequest, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import type { SandboxBackend, SandboxRecoveryRecord, SandboxRecoveryResource, SandboxRequest,
  SandboxStreamLimits, SandboxTransferBuffers } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import type { DockerSandboxProfile } from '@agen-ai/sandbox-docker';

export type ResourceRole = SandboxRecoveryResource['role'];

export function fixtureProfile(manifest: unknown): DockerSandboxProfile {
  assert(manifest !== null && typeof manifest === 'object');
  const profile: unknown = Reflect.get(manifest, 'profile') ?? 'linux-x64';
  if (profile === 'linux-x64' || profile === 'desktop-apple-virtualization-native-arm64'
    || profile === 'desktop-apple-virtualization-rosetta-amd64') return profile;
  throw new Error('Unknown explicitly selected Docker fixture profile.');
}

export function fixturePlatform(profile: DockerSandboxProfile): 'linux/amd64' | 'linux/arm64' {
  return profile === 'desktop-apple-virtualization-native-arm64' ? 'linux/arm64' : 'linux/amd64';
}

export interface ResourceObservation {
  readonly role: ResourceRole;
  readonly id: string;
  readonly httpStatus: number;
  readonly checkpoint: string;
  readonly controllerPid: number;
  readonly observedAt: string;
}

export async function collectBytes(stream: Readable, maxBytes = 65_536): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    assert(chunk instanceof Uint8Array, 'Fixture stream must remain binary.');
    bytes += chunk.byteLength;
    assert(bytes <= maxBytes, 'Fixture collection exceeded its explicit byte bound.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function atomicJson(destination: string, value: unknown): Promise<void> {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  assert(Buffer.byteLength(encoded) <= 1024 * 1024, 'Fixture JSON evidence exceeded its byte bound.');
  await writeFile(`${destination}.next`, encoded, { mode: 0o600 });
  await rename(`${destination}.next`, destination);
}

export async function openSuite(name: string) {
  assert(/^[a-z][a-z0-9-]{0,15}$/u.test(name));
  const endpoint = process.env.AGENAI_SANDBOX_TEST_ENGINE;
  const manifestPath = process.env.AGENAI_SANDBOX_TEST_MANIFEST;
  const output = process.env.AGENAI_SANDBOX_TEST_OUTPUT;
  assert(typeof endpoint === 'string' && endpoint.startsWith('unix:///'), 'Explicit local AGENAI_SANDBOX_TEST_ENGINE required.');
  assert(manifestPath && path.isAbsolute(manifestPath), 'Absolute AGENAI_SANDBOX_TEST_MANIFEST required.');
  assert(output && path.isAbsolute(output), 'Absolute AGENAI_SANDBOX_TEST_OUTPUT required.');
  const manifest: unknown = JSON.parse((await collectBytes(createReadStream(manifestPath))).toString('utf8'));
  assert(manifest !== null && typeof manifest === 'object');
  assert('format' in manifest && manifest.format === 'agenai.sandbox-docker-fixture.v1');
  assert('imageDigest' in manifest && typeof manifest.imageDigest === 'string');
  assert('user' in manifest && manifest.user !== null && typeof manifest.user === 'object');
  const user = manifest.user;
  assert('uid' in user && typeof user.uid === 'number' && 'gid' in user && typeof user.gid === 'number');
  const namespace = `ms005-${name}-${randomUUID()}`;
  await mkdir(output, { recursive: true, mode: 0o700 });
  const directory = path.join(output, name);
  await mkdir(directory, { mode: 0o700 });
  const config = { endpoint, profile: fixtureProfile(manifest), namespace, imageDigest: manifest.imageDigest,
    spillDirectory: directory, user: { uid: user.uid, gid: user.gid } };
  const backend = createDockerSandboxBackend(config);
  return Object.freeze({ ...config, directory, backend, fixture: manifest });
}

export function sandboxRequest(overrides: {
  readonly memoryBytes?: number;
  readonly pids?: number;
  readonly startupMs?: number;
  readonly executionTimeoutMs?: number;
  readonly cleanupMs?: number;
  readonly network?: 'isolated' | 'outbound';
  readonly streams?: Partial<SandboxStreamLimits>;
  readonly transfers?: Partial<SandboxTransferBuffers>;
} = {}): SandboxRequest {
  return parseSandboxRequest({ policy: {
    resources: { cpus: 2, memoryBytes: overrides.memoryBytes ?? 4 * 1024 ** 3, pids: overrides.pids ?? 256 },
    temporaryStorage: { homeBytes: 16 * 1024 ** 2, tempBytes: 16 * 1024 ** 2 },
    network: { kind: overrides.network ?? 'isolated' },
    execution: { kind: 'deadline', timeoutMs: overrides.executionTimeoutMs ?? 60_000 },
    deadlines: { startupMs: overrides.startupMs ?? 60_000, cleanupMs: overrides.cleanupMs ?? 30_000 },
    streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS, ...overrides.streams },
    transfers: { ...SANDBOX_DEFAULT_TRANSFER_BUFFERS, ...overrides.transfers },
  } });
}

export function reservePersisted(backend: SandboxBackend, request: SandboxRequest, directory: string, label: string) {
  assert(/^[a-z][a-z0-9-]{0,63}$/u.test(label));
  return backend.reserve(request, { kind: 'persisted', persist: (record) => atomicJson(path.join(directory, `${label}-recovery.json`), record) });
}

export function engineGet(endpoint: string, route: string): Promise<{ status: number; body: unknown }> {
  assert(endpoint.startsWith('unix:///') && route.startsWith('/') && !route.startsWith('//'));
  return new Promise((resolve, reject) => {
    const request = get({ socketPath: endpoint.slice(7), path: `/v1.52${route}`, agent: false, maxHeaderSize: 16_384 }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) request.destroy(new Error('Independent Engine response exceeded its fixture bound.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.once('end', () => {
        try {
          assert(response.statusCode !== undefined, 'Independent Engine response omitted status.');
          const encoded = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, body: encoded.length ? JSON.parse(encoded) : null });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Independent Engine observation exceeded its deadline.')), 10_000);
    request.on('error', reject);
    request.once('close', () => clearTimeout(timer));
  });
}

export function resourceId(record: SandboxRecoveryRecord, role: ResourceRole): string {
  const resource = record.resources.find((entry) => entry.role === role);
  assert(resource?.identity.kind === 'identified', `Expected exact observed ${role} identity.`);
  return resource.identity.id;
}

export async function observeResource(endpoint: string, resource: SandboxRecoveryResource, checkpoint: string): Promise<ResourceObservation> {
  const id = resource.identity.kind === 'identified' ? resource.identity.id : resource.name;
  const encoded = encodeURIComponent(id);
  const route = resource.role === 'storage' ? `/volumes/${encoded}` : resource.role === 'network'
    ? `/networks/${encoded}` : `/containers/${encoded}/json`;
  const { status } = await engineGet(endpoint, route);
  return { role: resource.role, id, httpStatus: status, checkpoint, controllerPid: process.pid, observedAt: new Date().toISOString() };
}

export async function inspectAbsent(endpoint: string, record: SandboxRecoveryRecord, checkpoint: string,
  observations: ResourceObservation[], roles?: readonly ResourceRole[]): Promise<void> {
  for (const resource of record.resources) {
    if (roles && !roles.includes(resource.role)) continue;
    const observation = await observeResource(endpoint, resource, checkpoint);
    observations.push(observation);
    assert.equal(observation.httpStatus, 404, `${resource.role} ${observation.id} must be absent at ${checkpoint}.`);
  }
}

export function failureSummary(error: unknown, depth = 0): unknown {
  if (error === undefined || error === null) return null;
  if (!(error instanceof Error)) return String(error).slice(0, 1024);
  return { name: error.name, message: error.message.slice(0, 1024),
    ...('code' in error ? { code: error.code } : {}),
    ...(depth < 4 && error.cause !== undefined ? { cause: failureSummary(error.cause, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.slice(0, 16).map((entry) => failureSummary(entry, depth + 1)) } : {}),
  };
}
