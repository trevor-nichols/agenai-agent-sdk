import { Readable, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import {
  parseSandboxGuestPath, parseSandboxId, parseSandboxProcessId, parseSandboxRecoveryRecord,
  SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS,
  type SandboxNetworkPolicy, type SandboxProcessExit, type SandboxProcessSpec,
} from '@agen-ai/sandbox';
import { createSandboxBackend, type SandboxBackendDriver } from '@agen-ai/sandbox/backend';

/** A memory-only driver at the public backend boundary; it never reads host credentials. */
export function createCredentialFixture({ bootstrap = false, firstStopFails = false, finishOnEof = true, startGate, network = { kind: 'isolated' } }:
  { bootstrap?: boolean; firstStopFails?: boolean; finishOnEof?: boolean; startGate?: Promise<void>; network?: SandboxNetworkPolicy } = {}) {
  const stdout = new Readable({ read() {} }); const stderr = new Readable({ read() {} });
  const started = Promise.withResolvers<void>(); const eof = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<SandboxProcessExit>();
  const received: Buffer[] = []; const nativeInput: Buffer[] = [];
  let prefix = Buffer.alloc(0); let prepared = !bootstrap;
  let credentialFile: Readonly<{ name: string; bytes: Buffer }> | undefined;
  let specification: SandboxProcessSpec | undefined;
  let processCalls = 0; let stopAttempts = 0;
  const resources = new Set<string>();
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received.push(Buffer.from(chunk));
      if (prepared) nativeInput.push(Buffer.from(chunk));
      else {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length >= 12) {
          const nameLength = prefix.readUInt16BE(4); const byteLength = prefix.readUInt32BE(8);
          const length = 12 + nameLength + byteLength;
          if (prefix.length >= length) {
            credentialFile = { name: prefix.subarray(12, 12 + nameLength).toString('ascii'), bytes: Buffer.from(prefix.subarray(12 + nameLength, length)) };
            if (prefix.length > length) nativeInput.push(Buffer.from(prefix.subarray(length)));
            prepared = true; prefix.fill(0); stdout.push(Buffer.from('AGC1 PREPARED\n'));
          }
        }
      }
      callback();
    },
    final(callback) {
      eof.resolve(); callback();
      if (finishOnEof) {
        stdout.push(Buffer.from('native fixture output\n')); stderr.push(Buffer.from('synthetic-sensitive-diagnostic'));
        stdout.push(null); stderr.push(null);
        // The native leader receipt is independent from the raw pipe EOF observations.
        void setImmediate().then(() => exit.resolve({ kind: 'exited', code: 7 }));
      }
    },
  });
  const digest = `sha256:${'1'.repeat(64)}`;
  let record = parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'credential-fixture', backendRevision: '1',
    namespace: 'credential-fixture', operationId: 'operation', sandboxId: 'sandbox', imageDigest: digest,
    policyDigest: digest, configurationDigest: digest, phase: 'reserved', authority: { kind: 'unverified' },
    resources: [{ role: 'compute', name: 'compute', identity: { kind: 'planned' } }, { role: 'storage', name: 'storage', identity: { kind: 'planned' } }],
  });
  const driver: SandboxBackendDriver = {
    support: { backendId: 'credential-fixture', backendRevision: '1', networkModes: ['isolated', 'restricted_https'], workspaceDiskQuota: false,
      networkAllowlist: { kind: 'https_connect', maxDestinations: 128 }, independentProcessTermination: false },
    reserve(request) {
      return { id: parseSandboxId('sandbox'), get recoveryRecord() { return record; }, async start({ checkpoint }) {
        record = parseSandboxRecoveryRecord({ ...record, phase: 'starting', authority: { kind: 'verified', backendIdentity: 'memory' } });
        await checkpoint(record);
        record = parseSandboxRecoveryRecord({ ...record, resources: record.resources.map((resource) => ({ ...resource, identity: { kind: 'creating' } })) });
        await checkpoint(record); resources.add('compute'); resources.add('storage');
        record = parseSandboxRecoveryRecord({ ...record, phase: 'running', resources: record.resources.map((resource) => ({ ...resource,
          identity: { kind: 'identified', id: resource.role, fingerprint: digest } })) });
        await checkpoint(record);
        return {
          effective: { backendIdentity: 'memory', isolation: 'container', resources: request.policy.resources,
            temporaryStorage: request.policy.temporaryStorage, network: request.policy.network, nonRoot: true,
            readOnlyRoot: true, workspaceDiskQuota: { kind: 'not_requested' } },
          workspace: parseSandboxGuestPath('/workspace/work'),
          async openSpill() { throw new Error('This fixture does not enter transfers.'); },
          async importTree() { throw new Error('This fixture does not enter transfers.'); },
          async exportTree() { throw new Error('This fixture does not enter transfers.'); },
          reserveProcess(spec) {
            processCalls++; specification = spec;
            return { id: parseSandboxProcessId('primary'), async start() {
              started.resolve(); await startGate;
              if (bootstrap) stdout.push(Buffer.from('AGC1 HELLO\n'));
              return { stdin, stdout, stderr, exit: exit.promise };
            } };
          },
        };
      }, async stop() {
        stopAttempts++;
        if (firstStopFails && stopAttempts === 1) throw new Error('Controlled original cleanup failure.');
        resources.delete('compute'); stdin.destroy(); stdout.destroy(); stderr.destroy();
        exit.resolve({ kind: 'unavailable', reason: 'sandbox_stopped' });
      }, async destroy() { resources.delete('storage'); } };
    },
    async reconcile(retained) { return { kind: 'absent', record: retained }; },
  };
  const owner = createSandboxBackend(driver).reserve({ policy: {
    resources: { cpus: 1, memoryBytes: 128 * 1024 * 1024, pids: 32 },
    temporaryStorage: { homeBytes: 1024 * 1024, tempBytes: 1024 * 1024 },
    network, execution: { kind: 'until_stopped' }, deadlines: { startupMs: 1000, cleanupMs: 1000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS, maxStdinBytes: 1024 * 1024 },
  } }, { kind: 'in_process' });
  return { owner, resources, stdout, stderr, stdin, started: started.promise, eof: eof.promise, exit, received, nativeInput,
    get credentialFile() { return credentialFile; }, get specification() { return specification; },
    get processCalls() { return processCalls; }, get stopAttempts() { return stopAttempts; } };
}
