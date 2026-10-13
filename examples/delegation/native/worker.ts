import type { NativeSelection } from './contracts.js';
import { parseNativeCandidate, parseNativeSelection } from './contracts.js';
import { assertRunnerIdentity, assertSdkIdentity } from './identity.js';
import { NativeInputError, record, textValue } from './json.js';
import { inspectNativeRoot, NativeCleanupError } from './launch.js';
import type { RegistryInstallationDescriptor } from './launch-contracts.js';
import { boundedWorkerMessage, type NativeWorkerJob, type NativeWorkerPayload } from './process.js';
import { installRegistryExecutable } from './registry.js';
import { nativeOperationErrorCode, runNativeLocalOperation } from './run.js';

// This file is the explicit subprocess entrypoint. Other modules must not import it for composition.
if (!process.send || !process.connected) throw new NativeInputError('worker_ipc_required');

const stop = new AbortController();
let entered = false;
let operation: Promise<void> | undefined;
let retry: (() => Promise<void>) | undefined;
let cleanupWork: Promise<void> | undefined;
let cleanupClosed = false;
let disconnectedMaintenance: ReturnType<typeof setInterval> | undefined;
let maintenanceWork: Promise<void> | undefined;

function send(value: unknown): Promise<void> {
  if (!process.connected || !process.send) return Promise.resolve();
  return new Promise<void>((resolve) => {
    try {
      const message = record(boundedWorkerMessage(value), ['type'], ['processId', 'payload', 'status', 'requestId']);
      process.send!(message, undefined, undefined, () => resolve());
    }
    catch { stop.abort(new NativeInputError('worker_ipc_unavailable')); resolve(); }
  });
}

function disconnect(): void {
  clearInterval(disconnectedMaintenance);
  if (process.connected) process.disconnect();
}

function job(value: unknown): NativeWorkerJob {
  const fields = record(value, ['kind', 'candidate', 'root'], ['command', 'selection', 'installation']);
  const candidate = parseNativeCandidate(fields.candidate);
  const root = textValue(fields.root);
  if (fields.kind === 'install') {
    record(value, ['kind', 'candidate', 'root']);
    return { kind: 'install', candidate, root };
  }
  if (fields.kind !== 'operate') throw new NativeInputError('worker_job_invalid');
  record(value, ['kind', 'candidate', 'root', 'command', 'installation'], ['selection']);
  if (fields.command !== 'discover' && fields.command !== 'execute') throw new NativeInputError('worker_job_invalid');
  const descriptor = record(fields.installation, ['format', 'storeRoot', 'installerProcessId', 'allocationId',
    'snapshotDigest', 'planDigest', 'installationId', 'receiptDigest', 'native', 'transformation']);
  if (descriptor.format !== 'native-local-raw-installation-v1' || typeof descriptor.storeRoot !== 'string'
    || !Number.isSafeInteger(descriptor.installerProcessId) || descriptor.installerProcessId === process.pid) {
    throw new NativeInputError('worker_job_invalid');
  }
  let selection: NativeSelection | undefined;
  if (Object.hasOwn(fields, 'selection')) selection = parseNativeSelection(fields.selection);
  if (fields.command === 'execute' && !selection || fields.command === 'discover' && selection) throw new NativeInputError('worker_job_invalid');
  return { kind: 'operate', command: fields.command, candidate, root,
    installation: fields.installation as RegistryInstallationDescriptor, ...(selection ? { selection } : {}) };
}

async function cleanup(): Promise<void> {
  if (cleanupClosed) return;
  if (!retry) throw new NativeInputError('cleanup_pending');
  cleanupWork ??= retry().then(() => { cleanupClosed = true; }).finally(() => { cleanupWork = undefined; });
  return cleanupWork;
}

async function execute(value: unknown): Promise<void> {
  let result: NativeWorkerPayload;
  try {
    const input = job(value);
    await assertSdkIdentity(input.candidate.sdk);
    await assertRunnerIdentity(input.candidate);
    await inspectNativeRoot(input.root);
    stop.signal.throwIfAborted();
    if (input.kind === 'install') {
      const installation = await installRegistryExecutable({ candidate: input.candidate, root: input.root, signal: stop.signal });
      result = { kind: 'installed', installation, cleanup: 'closed' };
    } else {
      const execution = await runNativeLocalOperation({ command: input.command, candidate: input.candidate, launch: 'registry',
        root: input.root, installation: input.installation, ...(input.selection ? { selection: input.selection } : {}), signal: stop.signal });
      retry = execution.retryCleanup;
      const { report, executable, allocations, cleanup: status } = execution;
      result = { kind: 'operation', result: { report, ...(executable ? { executable } : {}), allocations, cleanup: status }, cleanup: status };
    }
  } catch (error) {
    if (error instanceof NativeCleanupError) retry = error.retryCleanup;
    result = { kind: 'failure', code: nativeOperationErrorCode(error), cleanup: retry ? 'pending' : 'closed' };
  }
  cleanupClosed = result.cleanup === 'closed';
  await send({ type: 'result', payload: result });
  if (cleanupClosed) disconnect();
}

process.on('message', (message: unknown) => {
  void (async () => {
    const value = boundedWorkerMessage(message);
    const input = record(value, ['type'], ['job', 'requestId']);
    if (input.type === 'cancel') {
      record(value, ['type']);
      stop.abort(new NativeInputError('budget_exhausted'));
    } else if (input.type === 'cleanup') {
      record(value, ['type', 'requestId']);
      if (typeof input.requestId !== 'number' || !Number.isSafeInteger(input.requestId) || input.requestId < 1 || input.requestId > 64) {
        throw new NativeInputError('worker_message_invalid');
      }
      stop.abort(new NativeInputError('budget_exhausted'));
      try {
        await operation;
        await cleanup();
        await send({ type: 'cleanup', status: 'closed', requestId: input.requestId });
        disconnect();
      } catch { await send({ type: 'cleanup', status: 'pending', requestId: input.requestId }); }
    } else if (input.type === 'job') {
      record(value, ['type', 'job']);
      if (entered) throw new NativeInputError('worker_job_already_entered');
      entered = true;
      operation = execute(input.job);
      await operation;
    } else throw new NativeInputError('worker_message_invalid');
  })().catch(async () => {
    stop.abort(new NativeInputError('worker_message_invalid'));
    if (!entered) {
      await send({ type: 'result', payload: { kind: 'failure', code: 'worker_message_invalid', cleanup: 'closed' } });
      disconnect();
    }
  });
});

process.once('disconnect', () => {
  stop.abort(new NativeInputError('worker_ipc_unavailable'));
  if (cleanupClosed || !entered) return;
  // Lost parent IPC removes no ownership: this process keeps retrying its actual cleanup capability.
  disconnectedMaintenance = setInterval(() => {
    maintenanceWork ??= (async () => { await operation; await cleanup(); disconnect(); })()
      .catch(() => {}).finally(() => { maintenanceWork = undefined; });
  }, 1_000);
});

await send({ type: 'ready', processId: process.pid });
