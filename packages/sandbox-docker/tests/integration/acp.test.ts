// ------------------------------------------------------------------------------------------------
//                acp.test.ts - Real public ACP composition - Independent Engine cleanup observations
// ------------------------------------------------------------------------------------------------

import { importFixtures, exportFixtures } from '../fixtures/trees.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId,
  parseAgentTurnId, type AgentEvent } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderOutput } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { parseSandboxRequest, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS, SandboxStateError,
  type Sandbox, type SandboxRecoveryRecord, type SandboxReservation } from '@agen-ai/sandbox';
import { createSandboxAcpIntegration } from '@agen-ai/sandbox/acp';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { fixtureProfile } from './support/common.js';

const endpoint = process.env.AGENAI_SANDBOX_TEST_ENGINE;
const manifestPath = process.env.AGENAI_SANDBOX_TEST_MANIFEST;
const output = process.env.AGENAI_SANDBOX_TEST_OUTPUT;
type Registry = Awaited<ReturnType<typeof createAgentProviderRegistry>>;
type Role = SandboxRecoveryRecord['resources'][number]['role'];

function failureSummary(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error);
  return { name: error.name, message: error.message,
    ...('code' in error ? { code: error.code } : {}),
    ...('reasonCode' in error ? { reasonCode: error.reasonCode } : {}),
    ...(depth < 4 && error.cause !== undefined ? { cause: failureSummary(error.cause, depth + 1) } : {}),
    ...(depth < 4 && 'cleanupError' in error ? { cleanupError: failureSummary(error.cleanupError, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.map((item) => failureSummary(item, depth + 1)) } : {}),
  };
}

const events = (outputs: readonly AgentProviderOutput[]): AgentEvent[] => outputs.flatMap((output) => output.kind === 'event' ? [output.event] : []);
const turn = (label: string) => ({ deadlineAt: new Date(Date.now() + 20_000).toISOString(), turnId: parseAgentTurnId(`docker-acp:${label}`), interactionMode: 'default' as const,
  parts: [{ type: 'text' as const, text: 'Run the controlled guest task.' }] });

async function untilApproval(reader: AsyncIterator<AgentProviderOutput>) {
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await reader.next();
    if (next.done) throw new Error('The controlled guest ended without its permission request.');
    outputs.push(next.value);
    if (next.value.kind === 'event' && next.value.event.type === 'request.opened') {
      const request = next.value.event.payload.request;
      assert.equal(request.requestKind, 'approval');
      if (request.requestKind !== 'approval') throw new Error('Expected the controlled approval.');
      return { outputs, request };
    }
  }
}

async function remaining(reader: AsyncIterator<AgentProviderOutput>): Promise<AgentProviderOutput[]> {
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await reader.next();
    if (next.done) return outputs;
    outputs.push(next.value);
  }
}

test('real Docker ACP streams preserve portable requests and remove compute at SDK disposal before retained export', { timeout: 300_000 }, async () => {
  assert(typeof endpoint === 'string' && endpoint.startsWith('unix:///'), 'AGENAI_SANDBOX_TEST_ENGINE must explicitly select a local Unix socket');
  assert(manifestPath && path.isAbsolute(manifestPath), 'AGENAI_SANDBOX_TEST_MANIFEST must be absolute');
  assert(output && path.isAbsolute(output), 'AGENAI_SANDBOX_TEST_OUTPUT must be an absolute directory');
  const manifest: { format: string; imageDigest: string; user: { uid: number; gid: number } } = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.format, 'agenai.sandbox-docker-fixture.v1');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const destination = path.join(output, 'acp');
  await mkdir(destination, { mode: 0o700 });
  const engineEndpoint = endpoint;
  const namespace = `ms005-acp-${randomUUID()}`;
  const backend = createDockerSandboxBackend({ endpoint: engineEndpoint, profile: fixtureProfile(manifest), namespace,
    imageDigest: manifest.imageDigest, spillDirectory: destination, user: manifest.user });
  const peer = await readFile(new URL('./fixtures/acp-peer.mjs', import.meta.url));
  const sentinel = path.join(destination, 'host-sentinel.txt');
  const marker = path.join(destination, 'host-terminal-marker.txt');
  await writeFile(sentinel, 'host sentinel remains unchanged\n', { mode: 0o600 });
  const owners: Array<{ label: string; owner: SandboxReservation; registry?: Registry }> = [];
  const observations: unknown[] = [];
  const checkpoints: unknown[] = [];
  const cleanupFailures: Array<{ label?: string; operation: string; error: unknown }> = [];
  let primaryFailure: Readonly<{ error: unknown }> | undefined;

  const independentInspect = (role: Role, id: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const route = role === 'storage' ? `/volumes/${encodeURIComponent(id)}` : role === 'network'
      ? `/networks/${encodeURIComponent(id)}` : `/containers/${encodeURIComponent(id)}/json`;
    const request = get({ socketPath: engineEndpoint.slice(7), path: `/v1.52${route}`, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) request.destroy(new Error('Independent Engine inspection exceeded its response bound.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode === undefined) { reject(new Error('Independent Engine inspection had no HTTP status.')); return; }
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Independent Engine inspection timed out.')), 10_000);
    request.on('error', reject);
    request.on('close', () => clearTimeout(deadline));
  });
  const resourceId = (record: SandboxRecoveryRecord, role: Role): string => {
    const resource = record.resources.find((item) => item.role === role);
    assert(resource?.identity.kind === 'identified', `expected exact observed ${role} identity`);
    return resource.identity.id;
  };
  const running = async (sandbox: Sandbox) => {
    const observed = await independentInspect('compute', resourceId(sandbox.recoveryRecord, 'compute'));
    assert.equal(observed.status, 200);
    const inspection: { State: { Running: boolean }; ExecIDs: string[] } = JSON.parse(observed.body);
    assert.equal(inspection.State.Running, true);
    return inspection;
  };
  const absent = async (label: string, role: Role, id: string, checkpoint: string) => {
    const observed = await independentInspect(role, id);
    checkpoints.push({ label, checkpoint, role, id, httpStatus: observed.status, controllerPid: process.pid, observedAt: new Date().toISOString() });
    assert.equal(observed.status, 404, `${role} ${id} must independently be absent at ${checkpoint}`);
  };
  const open = async (label: 'normal' | 'eager' | 'control') => {
    const recoveryPath = path.join(destination, `${label}-recovery.json`);
    const owner = backend.reserve(parseSandboxRequest({ policy: {
      resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 256 },
      temporaryStorage: { homeBytes: 16 * 1024 ** 2, tempBytes: 16 * 1024 ** 2 }, network: { kind: 'isolated' },
      execution: { kind: 'deadline', timeoutMs: 300_000 },
      deadlines: { startupMs: 60_000, cleanupMs: 30_000 },
      transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS,
    } }), { kind: 'persisted', persist: async (record) => {
      await writeFile(`${recoveryPath}.next`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(`${recoveryPath}.next`, recoveryPath);
    } });
    const retained: { label: string; owner: SandboxReservation; registry?: Registry } = { label, owner };
    owners.push(retained);
    const sandbox = await owner.start();
    await importFixtures(sandbox, [{ path: 'acp-peer.mjs', bytes: peer, executable: false },
      { path: 'input.txt', bytes: Buffer.from(`${label} input\n`), executable: false }]);
    const providerKey = parseAgentProviderKey(`docker-acp-${label}`);
    const definition = { providerKey, instanceId: parseAgentInstanceId(`docker-acp:${label}`), driverConfiguration: {} };
    const driver = createNodeAcpProviderDriver({ providerKey, ...createSandboxAcpIntegration(sandbox),
      launch: { executable: '/usr/local/bin/node', args: [path.posix.join(sandbox.workspace, 'acp-peer.mjs'), label],
        cwd: sandbox.workspace, env: { HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          CONTROLLED_HOST_SENTINEL: sentinel, CONTROLLED_HOST_MARKER: marker }, shutdownTimeoutMs: 15_000 },
      limits: { initializationTimeoutMs: 20_000, cancellationTimeoutMs: 10_000, hostOperationTimeoutMs: 30_000 },
    });
    const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [definition] });
    retained.registry = registry;
    const instance = registry.requireInstance(definition.instanceId);
    const context = { sessionId: parseAgentSessionId(`docker-acp:${label}:session`), workingDirectory: sandbox.workspace,
      configuration: { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('docker-acp:configuration') }, onBindingCreated() {} };
    const compute = resourceId(sandbox.recoveryRecord, 'compute');
    const inspection = await running(sandbox);
    assert.equal(inspection.ExecIDs.length, 1, 'Eager initialization must own exactly one native exec.');
    return { sandbox, registry, instance, context, compute, execIds: inspection.ExecIDs };
  };

  try {
    const normal = await open('normal');
    const session = await normal.instance.adapter.createSession(normal.context);
    await assert.rejects(async () => normal.instance.adapter.createSession({ ...normal.context,
      sessionId: parseAgentSessionId('docker-acp:rejected-second-session') }), SandboxStateError);
    assert.deepEqual((await running(normal.sandbox)).ExecIDs, normal.execIds, 'A rejected second connection must not enter another native exec.');
    for (const index of [1, 2]) {
      const execution = session.startTurn(turn(`normal:${index}`));
      const reader = execution.outputs[Symbol.asyncIterator]();
      const { outputs, request } = await untilApproval(reader);
      const approved = request.options.find((option) => option.decision === 'approved');
      assert(approved);
      const resolution = { requestKind: 'approval' as const, requestId: request.requestId, disposition: 'selected' as const, optionId: approved.optionId };
      assert.deepEqual(await execution.resolveRequest({ resolution }), { status: 'delivered' });
      const delivered = events([...outputs, ...await remaining(reader)]);
      assert.equal(delivered.filter((event) => event.type === 'content.delta').map((event) => event.payload.delta).join(''), `guest turn ${index}: α\n`);
      assert.deepEqual(delivered.filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['completed']);
      await assert.rejects(() => execution.resolveRequest({ resolution }), { code: 'request_resolution_mismatch' });
    }
    await session.close({});
    await absent('normal', 'compute', normal.compute, 'session-close-before-export');
    const artifact = await exportFixtures(normal.sandbox, ['artifact.json']);
    const expected = { scenario: 'normal', node: 'v24.18.0', input: 'normal input\n', initializeCount: 1, sessionCreates: 1, prompts: 2,
      permissionResponses: [{ outcome: { outcome: 'selected', optionId: 'guest:allow' } }, { outcome: { outcome: 'selected', optionId: 'guest:allow' } }],
      hostReplies: ['fs/read_text_file', 'fs/write_text_file', 'terminal/create'].map((method) => ({ method,
        error: { code: -32602, message: 'This host facility is not available.' } })), stderrBytes: 9 };
    assert.equal(artifact.length, 1);
    assert.equal(Buffer.from(artifact[0].bytes).toString('utf8'), `${JSON.stringify(expected)}\n`);
    assert.equal(await readFile(sentinel, 'utf8'), 'host sentinel remains unchanged\n');
    await assert.rejects(() => stat(marker), { code: 'ENOENT' });
    await normal.registry.dispose();
    observations.push({ label: 'normal', compute: normal.compute, execIds: normal.execIds, guest: expected,
      artifactSha256: createHash('sha256').update(artifact[0].bytes).digest('hex'), secondConnectionRejectedBeforeExec: true,
      hostSentinelPreserved: true, hostTerminalMarkerAbsent: true });

    const eager = await open('eager');
    await eager.registry.dispose();
    await absent('eager', 'compute', eager.compute, 'zero-session-dispose-before-export');
    const eagerFiles = await exportFixtures(eager.sandbox, ['artifact.json']);
    const eagerArtifact = { scenario: 'eager', node: 'v24.18.0', input: 'eager input\n', initializeCount: 1, sessionCreates: 0, prompts: 0,
      permissionResponses: [], hostReplies: [], stderrBytes: 9 };
    assert.equal(Buffer.from(eagerFiles[0].bytes).toString('utf8'), `${JSON.stringify(eagerArtifact)}\n`);
    observations.push({ label: 'eager', compute: eager.compute, execIds: eager.execIds, guest: eagerArtifact });

    const controlled = await open('control');
    const controlledSession = await controlled.instance.adapter.createSession(controlled.context);
    const first = controlledSession.startTurn(turn('control:interrupt'));
    const firstReader = first.outputs[Symbol.asyncIterator]();
    await untilApproval(firstReader);
    assert.equal(controlledSession.interruption.kind, 'supported');
    if (controlledSession.interruption.kind !== 'supported') throw new Error('The controlled ACP mapping must support interruption.');
    assert.deepEqual(await controlledSession.interruption.interruptTurn({ turnId: turn('control:interrupt').turnId, reason: 'user_requested' }), { status: 'canceled' });
    assert.deepEqual(events(await remaining(firstReader)).filter((event) => event.type === 'turn.completed').map((event) => event.payload.outcome), ['canceled']);
    assert.deepEqual((await running(controlled.sandbox)).ExecIDs, controlled.execIds, 'Confirmed turn interruption retains the same live connection.');
    const second = controlledSession.startTurn(turn('control:abandon'));
    const secondReader = second.outputs[Symbol.asyncIterator]();
    await untilApproval(secondReader);
    assert(secondReader.return);
    await secondReader.return();
    await controlledSession.close({});
    await controlled.registry.dispose();
    await absent('control', 'compute', controlled.compute, 'abandoned-reader-sdk-close-before-export');
    const controlledFiles = await exportFixtures(controlled.sandbox, ['artifact.json']);
    const controlledArtifact: { initializeCount: number; sessionCreates: number; prompts: number } = JSON.parse(Buffer.from(controlledFiles[0].bytes).toString('utf8'));
    assert.deepEqual([controlledArtifact.initializeCount, controlledArtifact.sessionCreates, controlledArtifact.prompts], [1, 1, 2]);
    observations.push({ label: 'control', compute: controlled.compute, execIds: controlled.execIds,
      interruption: 'confirmed-canceled-on-original-reader', abandonment: 'same-sandbox-stopped', guest: controlledArtifact });
  } catch (error) {
    primaryFailure = { error };
  } finally {
    for (const retained of owners) {
      if (retained.registry) {
        try { await retained.registry.dispose(); }
        catch (error) { cleanupFailures.push({ label: retained.label, operation: 'registry-dispose', error }); }
      }
      try { await retained.owner.destroy(); }
      catch (error) { cleanupFailures.push({ label: retained.label, operation: 'sandbox-destroy', error }); }
      for (const resource of retained.owner.recoveryRecord.resources) {
        const id = resource.identity.kind === 'identified' ? resource.identity.id : resource.name;
        try { await absent(retained.label, resource.role, id, 'finally-destroy'); }
        catch (error) { cleanupFailures.push({ label: retained.label, operation: 'independent-final-inspection', error }); }
      }
    }
    try {
      await writeFile(path.join(destination, 'report.json'), `${JSON.stringify({ format: 'agenai.sandbox-docker-acp-evidence.v1',
        namespace, imageDigest: manifest.imageDigest, node: process.version, endpoint: engineEndpoint, controllerPid: process.pid,
        observations, checkpoints, records: owners.map(({ label, owner }) => ({ label, record: owner.recoveryRecord })),
        sandboxCount: owners.length, resourceCount: owners.reduce((count, { owner }) => count + owner.recoveryRecord.resources.length, 0),
        modelCalls: 0, credentialReads: 0,
        primaryFailure: primaryFailure ? failureSummary(primaryFailure.error) : null,
        cleanupFailures: cleanupFailures.map((failure) => ({ ...failure, error: failureSummary(failure.error) })),
      }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) { cleanupFailures.push({ operation: 'report-write', error }); }
  }
  if (primaryFailure || cleanupFailures.length) throw new AggregateError([
    ...(primaryFailure ? [primaryFailure.error] : []), ...cleanupFailures.map((failure) => failure.error),
  ], 'Real Docker ACP qualification failed; original and independent cleanup evidence retained.');
});
