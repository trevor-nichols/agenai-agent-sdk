import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId,
  parseAgentTurnId } from '@agen-ai/agent-protocol';
import { parseSandboxGuestPath, parseSandboxId, parseSandboxProcessId, parseSandboxRecoveryRecord,
  SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS, type SandboxProcessExit, type SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createSandboxBackend, type SandboxBackendDriver, type SandboxDriverReady } from '@agen-ai/sandbox/backend';
import { createSandboxSpillStore } from '@agen-ai/sandbox/node';
import { ownProvider } from '../../src/docker/owner.js';
import { captureCredential } from '../../src/docker/credentials.js';
import type { GrokDockerApprovalProfile, GrokDockerProvider, GrokDockerTransferOptions } from '../../src/docker/contracts.js';

export const gate = <T = void>() => Promise.withResolvers<T>();
export const turn = { turnId: parseAgentTurnId('fixture-turn'), interactionMode: 'default' as const,
  parts: [{ type: 'text' as const, text: 'Write the bounded fixture result.' }] };
export function bounds(): GrokDockerTransferOptions {
  return { deadlineAt: new Date(Date.now() + 30000).toISOString(), quotas: {
    maxFiles: 32, maxFileBytes: 65536, maxTotalBytes: 65536, maxArchiveBytes: 131072, maxPaths: 64 } };
}
export async function lifecycleFixture(t: TestContext, name: string, policy: GrokDockerApprovalProfile['policy'] = 'host',
  scenario: { holdInitialize?: boolean; holdOpening?: boolean; permission?: boolean; credential?: Uint8Array } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `agenai-grok-${name}-`)));
  const storage = join(root, 'storage'); const workspace = join(storage, 'work');
  const source = join(root, 'input'); await mkdir(source); await writeFile(join(source, 'input.txt'), `input:${name}\n`);
  const credentialReceipt = join(root, 'credential-prefix.json');
  const profile = { instanceId: parseAgentInstanceId(`fixture:${name}`), nativeSessionId: randomUUID(), policy,
    credentialBootstrap: { sha256: 'a'.repeat(64) } };
  const events: { type: string; frame?: Record<string, unknown> }[] = [];
  const notices = new Map<string, ReturnType<typeof gate<void>>>();
  const observed = (type: string) => { let notice = notices.get(type); if (!notice) { notice = gate(); notices.set(type, notice); } return notice; };
  const controls = { importHold: undefined as ReturnType<typeof gate<void>> | undefined, stopHold: undefined as ReturnType<typeof gate<void>> | undefined,
    failStop: false, processCount: 0, stopCount: 0, destroyCount: 0, importCount: 0, exportCount: 0,
    importEntered: gate(), stopEntered: gate(), exportCompleted: gate() };
  let child: ChildProcess | undefined;
  let exited: Promise<SandboxProcessExit> = Promise.resolve({ kind: 'unavailable', reason: 'sandbox_stopped' });
  const id = parseSandboxId(`sandbox-${randomUUID()}`);
  const digest = `sha256:${'1'.repeat(64)}`;
  let record: SandboxRecoveryRecord = parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'grok-fixture', backendRevision: '1',
    namespace: 'grok-fixture', operationId: randomUUID(), sandboxId: id, imageDigest: digest, policyDigest: digest, configurationDigest: digest,
    phase: 'reserved', authority: { kind: 'unverified' }, resources: [
      { role: 'compute', name: `${name}-compute`, identity: { kind: 'planned' } },
      { role: 'storage', name: `${name}-storage`, identity: { kind: 'planned' } }] });
  const physicalStop = async () => {
    controls.stopCount += 1; controls.stopEntered.resolve();
    if (controls.failStop) throw new Error(`original ${name} compute stop failed`);
    await controls.stopHold?.promise;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await rm(join(root, 'compute'), { force: true });
  };
  const cleanup: { provider?: GrokDockerProvider } = {};
  t.after(async () => {
    controls.importHold?.resolve(); controls.stopHold?.resolve(); controls.failStop = false;
    try { await cleanup.provider?.dispose(); } finally { await physicalStop(); await rm(root, { recursive: true, force: true }); }
  });
  const driver: SandboxBackendDriver = { support: { backendId: 'grok-fixture', backendRevision: '1', networkModes: ['isolated'],
    workspaceDiskQuota: false, networkAllowlist: false, independentProcessTermination: false },
  reserve(request) {
    return { id, get recoveryRecord() { return record; },
      async start(context) {
        record = { ...record, phase: 'starting', authority: { kind: 'verified', backendIdentity: name } }; await context.checkpoint(record);
        record = { ...record, resources: record.resources.map((resource) => ({ ...resource, identity: { kind: 'creating' } })) }; await context.checkpoint(record);
        await mkdir(workspace, { recursive: true }); await writeFile(join(root, 'compute'), name);
        record = { ...record, phase: 'running', resources: record.resources.map((resource) => ({ ...resource,
          identity: { kind: 'identified', id: `${name}-${resource.role}`, fingerprint: digest } })) }; await context.checkpoint(record);
        const ready: SandboxDriverReady = { effective: { backendIdentity: name, isolation: 'container', resources: request.policy.resources,
          temporaryStorage: request.policy.temporaryStorage, network: request.policy.network, nonRoot: true, readOnlyRoot: true,
          workspaceDiskQuota: { kind: 'not_requested' } }, workspace: parseSandboxGuestPath('/workspace/work'),
        async openSpill() {
          const directory = join(root, `spill-${randomUUID()}`); await mkdir(directory, { mode: 0o700 });
          const store = await createSandboxSpillStore({ directory });
          return { createFile: () => store.createFile(), async close() { await store.close(); await rm(directory, { recursive: true, force: true }); } };
        },
        async importTree(entries, operation) {
          controls.importCount += 1; controls.importEntered.resolve(); await controls.importHold?.promise;
          let files = 0n; let directories = 0n; let payloadBytes = 0n;
          for await (const entry of entries) {
            operation.signal.throwIfAborted();
            if (entry.kind === 'directory') { await mkdir(join(workspace, entry.path), { recursive: true }); directories += 1n; }
            else if (entry.kind === 'file') {
              const chunks: Uint8Array[] = []; for await (const chunk of entry.open({ signal: operation.signal })) chunks.push(chunk);
              const bytes = Buffer.concat(chunks); await writeFile(join(workspace, entry.path), bytes); files += 1n; payloadBytes += BigInt(bytes.length);
            } else throw new Error('Fixture does not admit symbolic links.');
          }
          return { files, directories, symlinks: 0n, payloadBytes, archiveBytes: payloadBytes };
        },
        reserveProcess(spec) {
          assert.equal(spec.executable, '/opt/agenai/bin/agenai-credential-bootstrap');
          assert.deepEqual(spec.args, ['/opt/agenai/bin/launch-grok']);
          return { id: parseSandboxProcessId(`process-${name}`), async start() {
            controls.processCount += 1;
            const processOwner = spawn(process.execPath, [fileURLToPath(new URL('./grok-lifecycle-child.mjs', import.meta.url)), profile.nativeSessionId,
              policy, name, String(scenario.holdInitialize ?? false), String(scenario.holdOpening ?? false), String(scenario.permission ?? false),
              scenario.credential ? credentialReceipt : ''],
            { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
            child = processOwner;
            const { stdin, stdout, stderr } = processOwner;
            assert(stdin && stdout && stderr);
            exited = new Promise<SandboxProcessExit>((resolve, reject) => {
              processOwner.once('error', reject); processOwner.once('exit', (code, signal) => resolve(signal
                ? { kind: 'signaled', signal } : { kind: 'exited', code: code ?? 1 }));
            });
            processOwner.on('message', (message: unknown) => {
              if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') return;
              const frame = 'frame' in message && message.frame && typeof message.frame === 'object' ? Object.fromEntries(Object.entries(message.frame)) : undefined;
              events.push({ type: message.type, ...(frame ? { frame } : {}) }); observed(message.type).resolve();
            });
            return { stdin, stdout, stderr, exit: exited };
          } };
        },
        async exportTree(_selection, consume, operation) {
          controls.exportCount += 1; let files = 0n; let payloadBytes = 0n;
          for (const path of await readdir(workspace)) {
            const bytes = await readFile(join(workspace, path));
            await consume({ kind: 'file', path, byteLength: bytes.length, executable: false, bytes: { async *[Symbol.asyncIterator]() { yield bytes; } } }, { signal: operation.signal });
            files += 1n; payloadBytes += BigInt(bytes.length);
          }
          controls.exportCompleted.resolve();
          return { files, directories: 0n, symlinks: 0n, payloadBytes, archiveBytes: payloadBytes };
        } };
        return ready;
      }, stop: physicalStop,
      async destroy() { controls.destroyCount += 1; await rm(storage, { recursive: true, force: true }); },
    };
  }, async reconcile() { throw new Error('No restart reconciliation in the fixture.'); } };
  const sandbox = await createSandboxBackend(driver).reserve({ policy: { resources: { cpus: 1, memoryBytes: 64 * 1024 ** 2, pids: 32 },
    temporaryStorage: { homeBytes: 1024 ** 2, tempBytes: 1024 ** 2 }, network: { kind: 'isolated' },
    deadlines: { startupMs: 10000, cleanupMs: 1000 }, transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS } }, { kind: 'in_process' }).start();
  const credential = scenario.credential ? captureCredential({ kind: 'auth_json', bytes: scenario.credential })
    : Buffer.from('{"synthetic":"credential-prefix-only"}');
  const provider = ownProvider(profile, sandbox, credential);
  cleanup.provider = provider;
  const materialize = async () => Promise.resolve(provider.driver.materialize({ providerKey: parseAgentProviderKey('grok'), instanceId: profile.instanceId, driverConfiguration: {} }));
  const create = async (instance: Awaited<ReturnType<typeof materialize>>) => instance.adapter.createSession({ sessionId: parseAgentSessionId(`session:${name}`),
    workingDirectory: '/workspace/work', configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId(`revision:${name}`) },
    approvalPolicy: { kind: policy }, onBindingCreated() {} });
  return { provider, profile, root, storage, workspace, source, credentialReceipt, events, controls, materialize, create,
    waitFor: (type: string) => observed(type).promise,
    release: (type: string) => { assert(child?.connected); child.send({ release: type }); },
    pid: () => child?.pid, exited: () => exited,
  };
}
