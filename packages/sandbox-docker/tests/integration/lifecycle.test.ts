// ------------------------------------------------------------------------------------------------
//                lifecycle.test.ts - Explicit real Docker lifecycle qualification - Independent CLI observer
// ------------------------------------------------------------------------------------------------

import { importFixtures, exportFixtures } from '../fixtures/trees.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { parseSandboxRequest, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord, SandboxReservation } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { fixtureProfile } from './support/common.js';

const endpoint = process.env.AGENAI_SANDBOX_TEST_ENGINE;
const manifestPath = process.env.AGENAI_SANDBOX_TEST_MANIFEST;
const outputRoot = process.env.AGENAI_SANDBOX_TEST_OUTPUT;

function failureSummary(error: unknown, depth = 0): unknown {
  if (error === undefined) return null;
  if (!(error instanceof Error)) return String(error);
  return { name: error.name, message: error.message,
    ...(depth < 3 && error.cause !== undefined ? { cause: failureSummary(error.cause, depth + 1) } : {}) };
}

test('real Docker sandboxes retain isolated files after terminal compute removal and destroy exact resources', { timeout: 300_000 }, async () => {
  assert(typeof endpoint === 'string' && endpoint.startsWith('unix:///'), 'AGENAI_SANDBOX_TEST_ENGINE must explicitly select a local Unix socket');
  assert(manifestPath && path.isAbsolute(manifestPath), 'AGENAI_SANDBOX_TEST_MANIFEST must be absolute');
  assert(outputRoot && path.isAbsolute(outputRoot), 'AGENAI_SANDBOX_TEST_OUTPUT must be a new absolute directory');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const output = path.join(outputRoot, 'lifecycle');
  const manifest: { format: string; imageDigest: string; user: { uid: number; gid: number } } = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.format, 'agenai.sandbox-docker-fixture.v1');
  await mkdir(output, { mode: 0o700 });
  const engineEndpoint = endpoint;
  const namespace = `ms005-lifecycle-${randomUUID()}`;
  const backend = createDockerSandboxBackend({ endpoint: engineEndpoint, profile: fixtureProfile(manifest), namespace,
    imageDigest: manifest.imageDigest, spillDirectory: output, user: manifest.user });
  const owners: SandboxReservation[] = [];
  const observations: unknown[] = [];
  const failures: unknown[] = [];
  let primaryError: unknown;
  let stalePlannedRecordRejected = false;
  const docker = (args: readonly string[]) => execFileSync('docker', ['--host', engineEndpoint, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const request = (network: 'isolated' | 'outbound') => parseSandboxRequest({ policy: {
    resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 256 },
    temporaryStorage: { homeBytes: 16 * 1024 ** 2, tempBytes: 16 * 1024 ** 2 },
    network: { kind: network }, execution: { kind: 'deadline', timeoutMs: 300_000 },
    deadlines: { startupMs: 60_000, cleanupMs: 30_000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS,
  } });
  const resourceId = (record: SandboxRecoveryRecord, role: 'compute' | 'storage' | 'export' | 'network') => {
    const resource = record.resources.find((item) => item.role === role);
    assert(resource?.identity.kind === 'identified', `expected observed ${role} identity`);
    return resource.identity.id;
  };
  const inspect = (role: string, id: string) => JSON.parse(docker([role === 'storage' ? 'volume' : role === 'network' ? 'network' : 'container', 'inspect', id]))[0];
  const assertAbsent = async (role: string, id: string) => {
    const route = role === 'storage' ? `/volumes/${encodeURIComponent(id)}` : role === 'network'
      ? `/networks/${encodeURIComponent(id)}` : `/containers/${encodeURIComponent(id)}/json`;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = get({ socketPath: engineEndpoint.slice(7), path: `/v1.52${route}`, agent: false }, (response) => {
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 64 * 1024) request.destroy(new Error('Independent absence inspection exceeded its response bound.'));
        });
        response.on('error', reject);
        response.on('end', () => resolve(response.statusCode));
      });
      const deadline = setTimeout(() => request.destroy(new Error('Independent absence inspection timed out.')), 10_000);
      request.on('error', reject);
      request.on('close', () => clearTimeout(deadline));
    });
    assert.equal(status, 404, `${role} ${id} must independently be absent`);
  };
  const reserve = (label: string, network: 'isolated' | 'outbound') => {
    const destination = path.join(output, `${label}-recovery.json`);
    const owner = backend.reserve(request(network), { kind: 'persisted', persist: async (record) => {
      await writeFile(`${destination}.next`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(`${destination}.next`, destination);
    } });
    owners.push(owner);
    return owner;
  };
  try {
    const alphaOwner = reserve('alpha', 'isolated');
    const betaOwner = reserve('beta', 'isolated');
    const stalePlannedRecord = alphaOwner.recoveryRecord;
    const alpha = await alphaOwner.start();
    const beta = await betaOwner.start();
    assert.equal((await backend.reconcile(stalePlannedRecord)).kind, 'conflict');
    stalePlannedRecordRejected = true;
    assert.equal(alpha.workspace, '/workspace/work');
    assert.equal(beta.workspace, '/workspace/work');
    assert.notEqual(resourceId(alpha.recoveryRecord, 'storage'), resourceId(beta.recoveryRecord, 'storage'));
    for (const [label, sandbox] of [['alpha', alpha], ['beta', beta]] as const) {
      await importFixtures(sandbox, [{ path: 'input.txt', bytes: Buffer.from(`${label}\n`), executable: false }]);
      const id = resourceId(sandbox.recoveryRecord, 'compute');
      const before = inspect('compute', id);
      assert.equal(before.State.Running, true);
      assert.equal(before.HostConfig.NetworkMode, 'none');
      assert.equal(before.HostConfig.NanoCpus, 2_000_000_000);
      assert.equal(before.HostConfig.Memory, 4 * 1024 ** 3);
      assert.equal(before.HostConfig.PidsLimit, 256);
      assert.equal(before.HostConfig.ReadonlyRootfs, true);
      assert.equal(before.Config.User, `${manifest.user.uid}:${manifest.user.gid}`);
      assert.deepEqual(before.HostConfig.CapDrop, ['ALL']);
      assert.equal(before.Mounts.length, 1);
      assert.equal(before.AppArmorProfile, fixtureProfile(manifest) === 'linux-x64' ? 'docker-default' : '');
      // This fixture-only command isolates file lifecycle; the process suite exercises public streams.
      const result = docker(['container', 'exec', '--user', `${manifest.user.uid}:${manifest.user.gid}`, '--workdir', sandbox.workspace,
        id, '/bin/sh', '-c', 'test "$(id -u)" != 0; cat input.txt > artifact.txt; printf "isolated\\n" >> artifact.txt; cat artifact.txt']);
      assert.equal(result, `${label}\nisolated`);
      await sandbox.stop();
      await assertAbsent('compute', id);
      assert.equal(inspect('export', resourceId(sandbox.recoveryRecord, 'export')).State.Status, 'created');
      const files = await exportFixtures(sandbox, ['artifact.txt']);
      assert.equal(files.length, 1);
      assert.equal(Buffer.from(files[0].bytes).toString(), `${label}\nisolated\n`);
      observations.push({ label, compute: id, storage: resourceId(sandbox.recoveryRecord, 'storage'),
        computeAbsentBeforeExport: true, accessorNeverStarted: true,
        artifactSha256: createHash('sha256').update(files[0].bytes).digest('hex') });
    }
    const outboundOwner = reserve('outbound', 'outbound');
    const outbound = await outboundOwner.start();
    const networkId = resourceId(outbound.recoveryRecord, 'network');
    assert.equal(inspect('network', networkId).Driver, 'bridge');
    assert.equal(inspect('compute', resourceId(outbound.recoveryRecord, 'compute')).HostConfig.NetworkMode, networkId);
    await importFixtures(outbound, [{ path: 'safe.txt', bytes: Buffer.from('safe\n'), executable: false }]);
    docker(['container', 'exec', resourceId(outbound.recoveryRecord, 'compute'), '/bin/sh', '-c', 'ln -s /etc/passwd /workspace/work/unsafe']);
    await outbound.stop();
    assert.deepEqual(await exportFixtures(outbound, ['safe.txt']), [{ path: 'safe.txt', executable: false, bytes: Buffer.from('safe\n') }]);
    await assert.rejects(outbound.exportTree({ kind: 'workspace' }, async (entry) => { if (entry.kind === 'file') for await (const _chunk of entry.bytes) { /* Validate the complete workspace. */ } }), /archive|link|regular/iu);
    observations.push({ label: 'outbound', network: networkId, exactSafeExportAccepted: true, unsafeWholeWorkspaceEntryRejected: true, externalNetworkRequests: 0 });
    const wrongNamespace = createDockerSandboxBackend({ endpoint: engineEndpoint, profile: fixtureProfile(manifest), namespace: `${namespace}-other`,
      imageDigest: manifest.imageDigest, spillDirectory: output, user: manifest.user });
    assert.equal((await wrongNamespace.reconcile(alpha.recoveryRecord)).kind, 'conflict');
  } catch (error) {
    primaryError = error;
  } finally {
    for (const owner of owners) {
      try { await owner.destroy(); await owner.destroy(); }
      catch (error) { failures.push(error); }
    }
    for (const owner of owners) {
      for (const resource of owner.recoveryRecord.resources) {
        if (resource.identity.kind !== 'identified') continue;
        try { await assertAbsent(resource.role, resource.identity.id); }
        catch (error) { failures.push(error); }
      }
    }
    try { await writeFile(path.join(output, 'report.json'), `${JSON.stringify({ format: 'agenai.sandbox-docker-lifecycle-evidence.v1',
      namespace, imageDigest: manifest.imageDigest, node: process.version, endpoint, observations,
      stalePlannedRecordRejected,
      primaryFailure: failureSummary(primaryError),
      cleanupFailures: failures.map((error) => failureSummary(error)),
      records: owners.map((owner) => owner.recoveryRecord), modelCalls: 0, processExecution: 'fixture-only-docker-cli',
    }, null, 2)}\n`, { mode: 0o600 }); }
    catch (error) { failures.push(error); }
  }
  if (primaryError || failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], 'Real Docker lifecycle qualification failed; original evidence retained.');
});
