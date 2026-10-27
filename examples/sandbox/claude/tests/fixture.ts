// ------------------------------------------------------------------------------------------------
//                fixture.ts - Memory-only public backend and consumer-supplied query fixtures
// ------------------------------------------------------------------------------------------------

import { Readable, Writable } from 'node:stream';
import {
  parseSandboxGuestPath, parseSandboxId, parseSandboxProcessId, parseSandboxRecoveryRecord,
  SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS,
  type SandboxProcessExit, type SandboxProcessSpec,
} from '@agen-ai/sandbox';
import { createSandboxBackend, type SandboxBackendDriver } from '@agen-ai/sandbox/backend';
import type { Options, SDKMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSdk } from '../index.js';

export function fixture({ firstStopFails = false, startGate, echo = false, finishOnEof = true }:
  { firstStopFails?: boolean; startGate?: Promise<void>; echo?: boolean; finishOnEof?: boolean } = {}) {
  const stdout = new Readable({ read() {} }); const stderr = new Readable({ read() {} });
  const started = Promise.withResolvers<void>(); const exit = Promise.withResolvers<SandboxProcessExit>();
  const received: Buffer[] = []; let stopAttempts = 0; let processCalls = 0; let specification: SandboxProcessSpec | undefined;
  const resources = new Set<string>();
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    received.push(Buffer.from(chunk)); if (echo) stdout.push(Buffer.from(chunk)); callback();
  }, final(callback) { if (finishOnEof) { stdout.push(null); stderr.push(null); exit.resolve({ kind: 'exited', code: 7 }); } callback(); } });
  const digest = `sha256:${'1'.repeat(64)}`;
  let record = parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'claude-fixture', backendRevision: '1',
    namespace: 'claude-fixture', operationId: 'operation', sandboxId: 'sandbox', imageDigest: digest,
    policyDigest: digest, configurationDigest: digest, phase: 'reserved', authority: { kind: 'unverified' },
    resources: [{ role: 'compute', name: 'compute', identity: { kind: 'planned' } }, { role: 'storage', name: 'storage', identity: { kind: 'planned' } }],
  });
  const driver: SandboxBackendDriver = {
    support: { backendId: 'claude-fixture', backendRevision: '1', networkModes: ['isolated'], workspaceDiskQuota: false,
      networkAllowlist: false, independentProcessTermination: false },
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
          effective: { backendIdentity: 'memory', isolation: 'container', resources: request.policy.resources, temporaryStorage: request.policy.temporaryStorage,
            network: request.policy.network, nonRoot: true, readOnlyRoot: true, workspaceDiskQuota: { kind: 'not_requested' } },
          workspace: parseSandboxGuestPath('/workspace/work'),
          async openSpill() { throw new Error('The process fixture does not enter transfers.'); },
          async importTree() { throw new Error('The process fixture does not enter transfers.'); },
          async exportTree() { throw new Error('The process fixture does not enter transfers.'); },
          reserveProcess(spec) {
            processCalls++; specification = spec;
            return { id: parseSandboxProcessId('primary'), async start() {
              started.resolve(); await startGate;
              return { stdin, stdout, stderr, exit: exit.promise };
            } };
          },
        };
      }, async stop() {
        stopAttempts++;
        if (firstStopFails && stopAttempts === 1) throw new Error('Controlled physical stop failure.');
        resources.delete('compute'); stdin.destroy(); stdout.destroy(); stderr.destroy();
        exit.resolve({ kind: 'unavailable', reason: 'sandbox_stopped' });
      }, async destroy() { resources.delete('storage'); } };
    },
    async reconcile(retained) { return { kind: 'absent', record: retained }; },
  };
  const owner = createSandboxBackend(driver).reserve({ policy: {
    resources: { cpus: 1, memoryBytes: 128 * 1024 * 1024, pids: 32 }, temporaryStorage: { homeBytes: 1024 * 1024, tempBytes: 1024 * 1024 },
    network: { kind: 'isolated' }, execution: { kind: 'until_stopped' }, deadlines: { startupMs: 1000, cleanupMs: 1000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS, maxStdinBytes: 1024 * 1024 },
  } }, { kind: 'in_process' });
  return { owner, resources, stdout, stderr, stdin, started: started.promise, exit, received,
    get stopAttempts() { return stopAttempts; }, get processCalls() { return processCalls; }, get specification() { return specification; } };
}

export const request = Object.freeze({ guestExecutable: '/opt/agenai/native-harness/claude-tools', model: 'claude-sonnet-4-6',
  tools: ['Read', 'Write', 'Bash'] as const, maxTurns: 8, prompt: 'Run the local controlled fixture.' });

export function sdkFixture(enter?: (child: SpawnedProcess, options: Options) => void, transform: (input: SpawnOptions) => SpawnOptions = (input) => input) {
  const bytes: Buffer[] = []; const events: Array<{ kind: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'error'; error: Error }> = [];
  let process: SpawnedProcess | undefined; let calls = 0; let closed = false;
  const sdk: ClaudeSdk = { query({ options }) {
    calls++;
    if (!options.spawnClaudeCodeProcess || !options.pathToClaudeCodeExecutable) throw new Error('Expected a configured custom spawn.');
    const child = options.spawnClaudeCodeProcess(transform({ command: options.pathToClaudeCodeExecutable, ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...options.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.273' },
      args: ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--thinking', 'disabled',
        '--max-turns', '8', '--model', 'claude-sonnet-4-6', '--permission-prompts', 'none', '--allowedTools', 'Read,Write,Bash',
        '--tools', 'Read,Write,Bash', '--setting-sources=', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence'],
      signal: new AbortController().signal }));
    process = child;
    child.on('error', (error) => { events.push({ kind: 'error', error }); });
    child.on('exit', (code, signal) => { events.push({ kind: 'exit', code, signal }); });
    enter?.(child, options);
    return { close() { closed = true; child.stdin.end(); }, async *[Symbol.asyncIterator]() {
      for await (const chunk of child.stdout) {
        bytes.push(Buffer.from(chunk));
        const status: SDKMessage = { type: 'system', subtype: 'status', status: null, uuid: '11111111-1111-4111-8111-111111111111', session_id: 'fixture' };
        yield status;
      }
      const failed = events.find((event) => event.kind === 'error'); if (failed?.kind === 'error') throw failed.error;
    } };
  } };
  return { sdk, bytes, events, get child() { return process; }, get calls() { return calls; }, get closed() { return closed; } };
}
