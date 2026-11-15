// Scripted external dependencies for the actual example runner; no native/Engine/account exists.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { mock } from 'node:test';
import { parseAgentApprovalRequest } from '@agen-ai/agent-protocol';
import * as runtime from '@agen-ai/agent-runtime';
import { SandboxDirectoryCleanupError } from '@agen-ai/sandbox/node';
import { parseNativeConfiguration } from '../config.js';

const prohibited = /The neutral installed sandbox proof must not enter a process or network operation\./u;
// Invalid arguments ensure even a missing guard cannot launch a real process or network request.
assert.throws(() => spawnSync(''), prohibited);
assert.throws(() => request('not a URL'), prohibited);
assert.throws(() => fetch('not a URL'), prohibited);
assert.deepEqual(Object.keys(process.env).filter((key) => !['HOME', 'TMPDIR', 'TMP', 'TEMP', 'TSX_TSCONFIG_PATH'].includes(key)), []);
const guard = { process: 'refused', network: 'refused', fetch: 'refused', ambientEnvironment: 'cleared' };

const inputRoot = process.argv[2]; const mode = process.argv[3];
if (!inputRoot || mode !== 'limited' && mode !== 'omitted' && mode !== 'unreached') throw new Error('Expected owned fixture directory and mode.');
const root = inputRoot;
await mkdir(join(root, 'ledger'), { mode: 0o700 });
const input: unknown = JSON.parse(await readFile(new URL('../run-config.example.json', import.meta.url), 'utf8'));
if (!input || typeof input !== 'object' || !('limits' in input) || !input.limits || typeof input.limits !== 'object') throw new Error('Run template required.');
const limits = Object.fromEntries(Object.entries(input.limits).filter(([key]) => key !== 'maxToolActions'));
const parsed = parseNativeConfiguration({ ...input, runId: 'tool-observations', artifactsDirectory: join(root, 'artifacts'),
  workspace: { importDirectory: join(root, 'input'), exportDirectory: join(root, 'export'), transferTimeoutMs: 1000,
    quotas: { maxFiles: 4, maxFileBytes: 4096, maxTotalBytes: 8192, maxArchiveBytes: 16384, maxPaths: 8 } },
  reservation: { ledgerDirectory: join(root, 'ledger'), campaignId: 'tool-observations', currency: 'USD', maximumCents: 10, amountCents: 1 },
  residual: { kind: 'approve_once' }, limits: { ...limits, runMs: 5000 } });
if (parsed.format !== 'agenai.approval-native-run.v1') throw new Error('Run configuration required.');
const config = { ...parsed, limits: { ...parsed.limits, ...(mode === 'omitted' ? {} : { maxToolActions: mode === 'limited' ? 2 : 4 }) } };
const drained = Promise.withResolvers<void>();
const offered = new Set<string>();
const trace = { readers: 0, readerDrained: false, stopRequestedBeforeLate: false, stopAfterProducerDistinct: 0,
  registryEntered: 0, resolutions: 0, sessionClosed: 0, providerDisposed: 0, exportedAfterDrain: false };
let disposal: Promise<void> | undefined;
const item = (type: 'item.started' | 'item.updated' | 'item.completed', id: string) => {
  offered.add(id);
  return { kind: 'event', event: { type, payload: { itemId: id, itemKind: 'command_execution', status: 'completed', title: 'synthetic-private-tool-text' } } };
};
async function* outputs() {
  try {
    yield { kind: 'event', event: { type: 'item.started', payload: { itemId: 'message', itemKind: 'assistant_message', status: 'in_progress' } } };
    yield item('item.updated', 'action-a');
    yield item('item.started', 'action-a');
    yield item('item.completed', 'action-a');
    yield item('item.completed', 'action-b');
    await setImmediate();
    trace.stopRequestedBeforeLate = disposal !== undefined;
    await writeFile(join(root, 'after-stop.txt'), 'owned late observation\n', { flag: 'wx' });
    yield item('item.started', 'action-c');
    yield item('item.updated', 'action-c');
    yield { kind: 'event', event: { type: 'request.opened', payload: { request: parseAgentApprovalRequest({
      requestKind: 'approval', requestId: 'late-request', prompt: 'Synthetic late request', subject: { kind: 'command', title: 'Late fixture action', itemId: 'late-action' },
      options: [{ optionId: 'once', label: 'Once', decision: 'approved', consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } }],
    }) } } };
    yield { kind: 'event', event: { type: 'turn.completed', payload: { outcome: 'completed' } } };
  } finally { trace.readerDrained = true; drained.resolve(); }
}
const session = {
  approvalPolicy: { policy: { kind: config.profile.policy }, verification: 'controlled_configuration' },
  binding: { conversationId: config.profile.nativeSessionId },
  startTurn() { return {
    outputs: { [Symbol.asyncIterator]() { trace.readers += 1; return outputs(); } },
    async resolveRequest() { trace.resolutions += 1; return { status: 'delivered' }; },
  }; },
  async close() { trace.sessionClosed += 1; },
};
mock.module('@agen-ai/agent-runtime', { namedExports: { ...runtime, async createAgentProviderRegistry() { return {
  getInstance() { return { adapter: { async createSession() { return session; } } }; },
  dispose() {
    disposal ??= (async () => { trace.registryEntered += 1; trace.stopAfterProducerDistinct = offered.size; await drained.promise; })();
    return disposal;
  },
}; } } });
mock.module('@agen-ai/sandbox/node', { namedExports: { SandboxDirectoryCleanupError, async readSandboxCredentialFile() { return new Uint8Array([1, 2, 3]); } } });
mock.module('@agen-ai/provider-grok/docker', { namedExports: { async prepareGrokDockerProvider() { return {
  driver: {}, workspace: {
    async importDirectory() {},
    async exportDirectory() {
      trace.exportedAfterDrain = trace.readerDrained;
      if (!trace.readerDrained || !disposal) throw new Error('Original reader and stop must settle before export.');
      await mkdir(join(root, 'export'));
      await writeFile(join(root, 'export/marker.txt'), await readFile(join(root, 'after-stop.txt')), { flag: 'wx' });
      return { summary: { files: 1n, directories: 0n, symlinks: 0n, payloadBytes: 23n, archiveBytes: 1024n } };
    },
  },
  async dispose() { trace.providerDisposed += 1; },
}; } } });
const { runNative } = await import('../run.js');
const report = await runNative(config);
process.stdout.write(`${JSON.stringify({ report, trace, guard })}\n`);
