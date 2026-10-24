// ------------------------------------------------------------------------------------------------
//                process.test.ts - Real Docker process and descendant ownership - Public entrypoints
// ------------------------------------------------------------------------------------------------

import { importFixtures, exportFixtures } from '../fixtures/trees.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { parseSandboxRequest, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { fixtureProfile } from './support/common.js';
import { kernelObservationMode, readKernelText } from './support/kernel.js';

const endpoint = process.env.AGENAI_SANDBOX_TEST_ENGINE;
const manifestPath = process.env.AGENAI_SANDBOX_TEST_MANIFEST;
const output = process.env.AGENAI_SANDBOX_TEST_OUTPUT;
type Role = SandboxRecoveryRecord['resources'][number]['role'];

function failureSummary(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error);
  return { name: error.name, message: error.message,
    ...('code' in error ? { code: error.code } : {}),
    ...(depth < 4 && error.cause !== undefined ? { cause: failureSummary(error.cause, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.map((item) => failureSummary(item, depth + 1)) } : {}),
  };
}

async function atomicJson(destination: string, value: unknown): Promise<void> {
  await writeFile(`${destination}.next`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${destination}.next`, destination);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    assert(chunk instanceof Uint8Array);
    size += chunk.byteLength;
    assert(size <= 64 * 1024, 'Controlled process output must remain within its fixture collection bound.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function halfClose(stream: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(bytes, () => { stream.removeListener('error', reject); resolve(); });
  });
}

test('real Docker process preserves binary stdio and retains a detached descendant until whole-sandbox stop', { timeout: 300_000 }, async () => {
  assert(typeof endpoint === 'string' && endpoint.startsWith('unix:///'), 'AGENAI_SANDBOX_TEST_ENGINE must explicitly select a local Unix socket');
  assert(manifestPath && path.isAbsolute(manifestPath), 'AGENAI_SANDBOX_TEST_MANIFEST must be absolute');
  assert(output && path.isAbsolute(output), 'AGENAI_SANDBOX_TEST_OUTPUT must be an absolute directory');
  const manifest: { format: string; imageDigest: string; user: { uid: number; gid: number } } = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.format, 'agenai.sandbox-docker-fixture.v1');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const destination = path.join(output, 'process');
  await mkdir(destination, { mode: 0o700 });
  const engineEndpoint = endpoint;
  const namespace = `ms005-process-${randomUUID()}`;
  const marker = `agenai-ms004-descendant-${randomUUID()}`;
  const backend = createDockerSandboxBackend({ endpoint: engineEndpoint, profile: fixtureProfile(manifest), namespace,
    imageDigest: manifest.imageDigest, spillDirectory: destination, user: manifest.user });
  const peer = await readFile(new URL('./fixtures/process-peer.mjs', import.meta.url));
  const checkpoints: unknown[] = [];
  const observations: unknown[] = [];
  const cleanupFailures: Array<{ operation: string; error: unknown }> = [];
  let primaryFailure: Readonly<{ error: unknown }> | undefined;
  const owner = backend.reserve(parseSandboxRequest({ policy: {
    resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 256 },
    temporaryStorage: { homeBytes: 16 * 1024 ** 2, tempBytes: 16 * 1024 ** 2 }, network: { kind: 'isolated' },
    execution: { kind: 'deadline', timeoutMs: 60_000 },
    deadlines: { startupMs: 60_000, cleanupMs: 30_000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS,
  } }), { kind: 'persisted', persist: (record) => atomicJson(path.join(destination, 'recovery.json'), record) });

  const independentGet = (route: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const request = get({ socketPath: engineEndpoint.slice(7), path: `/v1.52${route}`, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) request.destroy(new Error('Independent Engine response exceeded its fixture bound.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode === undefined) { reject(new Error('Independent Engine response had no HTTP status.')); return; }
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Independent Engine observation timed out.')), 10_000);
    request.on('error', reject);
    request.once('close', () => clearTimeout(deadline));
  });
  const resourceId = (record: SandboxRecoveryRecord, role: Role): string => {
    const resource = record.resources.find((item) => item.role === role);
    assert(resource?.identity.kind === 'identified', `Expected exact observed ${role} identity.`);
    return resource.identity.id;
  };
  const absent = async (role: Role, id: string, checkpoint: string) => {
    const route = role === 'storage' ? `/volumes/${encodeURIComponent(id)}` : role === 'network'
      ? `/networks/${encodeURIComponent(id)}` : `/containers/${encodeURIComponent(id)}/json`;
    const result = await independentGet(route);
    checkpoints.push({ checkpoint, role, id, httpStatus: result.status, controllerPid: process.pid, observedAt: new Date().toISOString() });
    assert.equal(result.status, 404, `${role} ${id} must independently be absent at ${checkpoint}.`);
  };

  try {
    const sandbox = await owner.start();
    await importFixtures(sandbox, [{ path: 'process-peer.mjs', bytes: peer, executable: false }]);
    const processReservation = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: [`${sandbox.workspace}/process-peer.mjs`, 'leader', marker],
      cwd: sandbox.workspace, env: {} });
    assert.equal(processReservation.stopScope, 'sandbox');
    const streams = await processReservation.start();
    const input = Buffer.alloc(32 * 1024);
    for (let index = 0; index < input.byteLength; index += 1) input[index] = (index * 73) & 255;
    const observedStreams = Promise.all([collect(streams.stdout), collect(streams.stderr), streams.exit]);
    const [observed] = await Promise.all([observedStreams, halfClose(streams.stdin, input)]);
    const [stdout, stderr, exit] = observed;
    assert.deepEqual(stdout, input);
    assert.deepEqual(stderr, Buffer.from([254, 0, 69, 82, 82, 13, 10, 255]));
    assert.deepEqual(exit, { kind: 'exited', code: 23 });
    const compute = resourceId(sandbox.recoveryRecord, 'compute');
    const running = await independentGet(`/containers/${compute}/json`);
    assert.equal(running.status, 200);
    const inspection: { State: { Running: boolean } } = JSON.parse(running.body);
    assert.equal(inspection.State.Running, true);
    checkpoints.push({ checkpoint: 'leader-exited-compute-still-owned', role: 'compute', id: compute,
      httpStatus: running.status, running: inspection.State.Running, controllerPid: process.pid, observedAt: new Date().toISOString() });
    const top = await independentGet(`/containers/${compute}/top`);
    assert.equal(top.status, 200);
    const processTable: { Titles: string[]; Processes: string[][] } = JSON.parse(top.body);
    const descendants = processTable.Processes.filter((row) => row.some((field) => field.includes(marker)));
    assert.equal(descendants.length, 1, 'The detached marked descendant must remain alive after the leader exit.');
    const pidColumn = processTable.Titles.indexOf('PID'); assert(pidColumn >= 0);
    const hostPid = Number(descendants[0]?.[pidColumn]); assert(Number.isSafeInteger(hostPid) && hostPid > 0);
    const descendantStatus = await readKernelText(`/proc/${hostPid}/status`);
    assert(/^NSpid:\s+.+$/mu.test(descendantStatus), 'Independent kernel view must identify the actual detached descendant.');
    observations.push({ leaderExit: exit, binaryInputBytes: input.byteLength, stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
      stderrBytes: [...stderr], descendant: { marker, detached: true, hostPid, kernelSource: kernelObservationMode(),
        status: descendantStatus, titles: processTable.Titles, row: descendants[0] } });
    await sandbox.stop();
    await absent('compute', compute, 'sdk-stop-before-export');
    assert.deepEqual(await streams.exit, { kind: 'exited', code: 23 }, 'Stopping the sandbox must preserve the entered leader-exit observation.');
    const files = await exportFixtures(sandbox, ['artifact.bin', 'descendant.json']);
    assert.equal(files.length, 2);
    const expected = Buffer.concat([Buffer.from([65, 82, 84, 0, 255]), input, Buffer.from([128, 10])]);
    assert.deepEqual(Buffer.from(files[0].bytes), expected);
    const descendant: { marker: string; pid: number; node: string; sequence: number } = JSON.parse(Buffer.from(files[1].bytes).toString('utf8'));
    assert.equal(descendant.marker, marker);
    assert.equal(descendant.node, 'v24.18.0');
    assert(Number.isInteger(descendant.pid) && descendant.pid > 0);
    assert(Number.isInteger(descendant.sequence) && descendant.sequence >= 0);
    observations.push({ computeAbsentBeforeExport: true, artifactBytes: expected.byteLength,
      artifactSha256: createHash('sha256').update(files[0].bytes).digest('hex'), descendant });
  } catch (error) {
    primaryFailure = { error };
  } finally {
    try { await owner.destroy(); }
    catch (error) { cleanupFailures.push({ operation: 'sandbox-destroy', error }); }
    for (const resource of owner.recoveryRecord.resources) {
      const id = resource.identity.kind === 'identified' ? resource.identity.id : resource.name;
      try { await absent(resource.role, id, 'finally-destroy'); }
      catch (error) { cleanupFailures.push({ operation: 'independent-final-inspection', error }); }
    }
    try {
      await atomicJson(path.join(destination, 'report.json'), { format: 'agenai.sandbox-docker-process-evidence.v1',
        namespace, imageDigest: manifest.imageDigest, endpoint: engineEndpoint, node: process.version, controllerPid: process.pid,
        observations, checkpoints, record: owner.recoveryRecord, sandboxCount: 1, resourceCount: owner.recoveryRecord.resources.length,
        modelCalls: 0, credentialReads: 0, primaryFailure: primaryFailure ? failureSummary(primaryFailure.error) : null,
        cleanupFailures: cleanupFailures.map((failure) => ({ ...failure, error: failureSummary(failure.error) })),
      });
    } catch (error) { cleanupFailures.push({ operation: 'report-write', error }); }
  }
  if (primaryFailure || cleanupFailures.length) throw new AggregateError([
    ...(primaryFailure ? [primaryFailure.error] : []), ...cleanupFailures.map((failure) => failure.error),
  ], 'Real Docker process qualification failed; original and independent cleanup evidence retained.');
});
