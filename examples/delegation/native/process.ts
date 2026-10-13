import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { NativeCandidate, NativeSelection } from './contracts.js';
import { parseNativeDiscoveryReport, parseNativeModeReport } from './evidence.js';
import type { NativeDiscoveryReport, NativeModeReport } from './host-contracts.js';
import type { NativeExecutableEvidence, NativeRole, RegistryInstallationDescriptor } from './launch-contracts.js';
import { digest, exact, integer, NativeInputError, parseNativeJson, record, textValue } from './json.js';
import { nativeRelease } from './launch.js';

export interface NativeAllocationEvidence {
  readonly allocationId: string;
  readonly role: NativeRole;
  readonly environmentKeys: readonly string[];
}

export interface NativeProcessObservation {
  readonly processId: number;
  readonly spawnedAt: number;
  readonly readyAt?: number;
  readonly settledAt?: number;
  readonly exitedAt?: number;
  readonly exitCode?: number | null;
}

export interface NativeProcessProof {
  readonly format: 'native-process-ownership-v1';
  readonly composition: 'direct-local' | 'registry-fresh-process';
  readonly launcherProcessId: number;
  readonly installer?: NativeProcessObservation;
  readonly run?: NativeProcessObservation;
  readonly freshProcessReopened: boolean;
}

export interface SerializableNativeOperation {
  readonly report: NativeDiscoveryReport | NativeModeReport;
  readonly executable?: NativeExecutableEvidence;
  readonly allocations: readonly NativeAllocationEvidence[];
  readonly cleanup: 'closed' | 'pending';
}

export type NativeWorkerJob = Readonly<{
  kind: 'install'; candidate: NativeCandidate; root: string;
}> | Readonly<{
  kind: 'operate'; candidate: NativeCandidate; root: string; command: 'discover' | 'execute';
  selection?: NativeSelection; installation: RegistryInstallationDescriptor;
}>;

export type NativeWorkerPayload = Readonly<{
  kind: 'installed'; installation: RegistryInstallationDescriptor; cleanup: 'closed';
}> | Readonly<{
  kind: 'operation'; result: SerializableNativeOperation; cleanup: 'closed' | 'pending';
}> | Readonly<{
  kind: 'failure'; code: string; cleanup: 'closed' | 'pending';
}>;

export interface NativeWorkerLease {
  readonly payload: NativeWorkerPayload | undefined;
  readonly observation: NativeProcessObservation;
  readonly cleanup: 'closed' | 'pending';
  readonly retryCleanup: () => Promise<void>;
}

const maximumMessageBytes = 1_048_576;
const cleanupMs = 30_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function boundedWorkerMessage(value: unknown): unknown {
  const bytes = JSON.stringify(value);
  if (bytes === undefined || Buffer.byteLength(bytes) > maximumMessageBytes) throw new NativeInputError('worker_message_limit');
  return parseNativeJson(bytes);
}

function payload(value: unknown, job: NativeWorkerJob): NativeWorkerPayload {
  const outer = record(value, ['kind', 'cleanup'], ['installation', 'result', 'code']);
  if (outer.cleanup !== 'closed' && outer.cleanup !== 'pending') throw new NativeInputError('worker_message_invalid');
  if (outer.kind === 'installed') {
    record(value, ['kind', 'cleanup', 'installation']);
    if (job.kind !== 'install' || outer.cleanup !== 'closed') throw new NativeInputError('worker_message_invalid');
    const installed = record(outer.installation, ['format', 'storeRoot', 'installerProcessId', 'allocationId',
      'snapshotDigest', 'planDigest', 'installationId', 'receiptDigest', 'native', 'transformation']);
    exact(installed.format, 'native-local-raw-installation-v1');
    integer(installed.installerProcessId, 1, Number.MAX_SAFE_INTEGER);
    for (const key of ['storeRoot', 'allocationId', 'installationId']) textValue(installed[key]);
    for (const key of ['snapshotDigest', 'planDigest', 'receiptDigest']) digest(installed[key]);
    const transformation = record(installed.transformation, ['bytes', 'sha256', 'decoded', 'decoderExecutableSha256',
      'pythonVersion', 'zlibCompileVersion', 'zlibRuntimeVersion']);
    for (const identity of [record(installed.native, ['bytes', 'sha256']), record(transformation.decoded, ['bytes', 'sha256']), transformation]) {
      integer(identity.bytes, 1, 268_435_456);
      if (!/^[a-f0-9]{64}$/u.test(textValue(identity.sha256, 64))) throw new NativeInputError('worker_message_invalid');
    }
    if (!/^[a-f0-9]{64}$/u.test(textValue(transformation.decoderExecutableSha256, 64))) throw new NativeInputError('worker_message_invalid');
    for (const key of ['pythonVersion', 'zlibCompileVersion', 'zlibRuntimeVersion']) textValue(transformation[key], 100);
  } else if (outer.kind === 'operation') {
    record(value, ['kind', 'cleanup', 'result']);
    const result = record(outer.result, ['report', 'allocations', 'cleanup'], ['executable']);
    if (job.kind !== 'operate' || result.cleanup !== outer.cleanup) throw new NativeInputError('worker_message_invalid');
    if (job.command === 'discover') parseNativeDiscoveryReport(result.report);
    else parseNativeModeReport(result.report);
  } else if (outer.kind === 'failure') {
    record(value, ['kind', 'cleanup', 'code']);
    if (typeof outer.code !== 'string' || !/^[a-z_]{1,100}$/u.test(outer.code)) throw new NativeInputError('worker_message_invalid');
  } else throw new NativeInputError('worker_message_invalid');
  return value as NativeWorkerPayload;
}

/** The caller supplies the source-pinned worker URL. Once a job is sent, timeouts only request cleanup. */
export async function executeNativeWorker(input: {
  readonly worker: URL;
  readonly job: NativeWorkerJob;
  readonly root: string;
  readonly clock: () => number;
  readonly signal?: AbortSignal;
}): Promise<NativeWorkerLease> {
  input.signal?.throwIfAborted();
  boundedWorkerMessage({ type: 'job', job: input.job });
  const spawnedAt = input.clock();
  const child = fork(fileURLToPath(input.worker), [], {
    cwd: input.root, execArgv: ['--import', import.meta.resolve('tsx')],
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json',
  });
  const ready = deferred<boolean>();
  const received = deferred<NativeWorkerPayload | undefined>();
  const exited = deferred<void>();
  const canceled = deferred<void>();
  let observation: NativeProcessObservation = { processId: child.pid ?? 0, spawnedAt };
  let current: NativeWorkerPayload | undefined;
  let activeCleanup: ReturnType<typeof deferred<'closed' | 'pending'>> | undefined;
  let activeCleanupId: number | undefined;
  let cleanupRequests = 0;
  let closed = false;
  let jobSent = false;
  let cleanupAcknowledged = false;
  let outputBytes = 0;
  let protocolFailed = false;
  let canceledOnce = false;
  const send = (message: unknown) => {
    if (!child.connected) return;
    try { child.send(boundedWorkerMessage(message) as object, (error) => { if (error) onCancel(); }); }
    catch { onCancel(); }
  };
  const onCancel = () => {
    if (canceledOnce) return;
    canceledOnce = true;
    canceled.resolve();
    if (jobSent) send({ type: 'cancel' });
    else if (!closed) child.kill('SIGTERM'); // No native authority was sent to this process.
  };
  const onOutput = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 65_536) { protocolFailed = true; onCancel(); }
  };
  child.stdout?.on('data', onOutput);
  child.stderr?.on('data', onOutput);
  child.on('error', () => { protocolFailed = true; onCancel(); });
  child.on('message', (message: unknown) => {
    try {
      const value = boundedWorkerMessage(message);
      const inputMessage = record(value, ['type'], ['processId', 'payload', 'status', 'requestId']);
      if (inputMessage.type === 'ready') {
        record(value, ['type', 'processId']);
        if (observation.readyAt !== undefined || inputMessage.processId !== child.pid) throw new NativeInputError('worker_message_invalid');
        observation = { ...observation, readyAt: input.clock() };
        ready.resolve(true);
      } else if (inputMessage.type === 'result') {
        record(value, ['type', 'payload']);
        if (!jobSent || current) throw new NativeInputError('worker_message_invalid');
        current = payload(inputMessage.payload, input.job);
        observation = { ...observation, settledAt: input.clock() };
        received.resolve(current);
      } else if (inputMessage.type === 'cleanup') {
        record(value, ['type', 'status', 'requestId']);
        if (typeof inputMessage.requestId !== 'number' || !Number.isSafeInteger(inputMessage.requestId)
          || inputMessage.requestId < 1 || inputMessage.requestId > cleanupRequests
          || !['closed', 'pending'].includes(String(inputMessage.status))) throw new NativeInputError('worker_message_invalid');
        if (inputMessage.status === 'closed') cleanupAcknowledged = true;
        if (inputMessage.requestId === activeCleanupId) activeCleanup?.resolve(inputMessage.status as 'closed' | 'pending');
      } else throw new NativeInputError('worker_message_invalid');
    } catch {
      protocolFailed = true;
      onCancel();
      received.resolve(undefined);
    }
  });
  child.once('close', (code) => {
    closed = true;
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onCancel);
    observation = { ...observation, exitedAt: input.clock(), exitCode: code };
    ready.resolve(false);
    received.resolve(undefined);
    exited.resolve();
    activeCleanup?.resolve('pending');
  });
  input.signal?.addEventListener('abort', onCancel, { once: true });
  if (input.signal?.aborted) onCancel();
  const maximumMs = input.job.kind === 'install' ? 180_000 : input.job.command === 'discover' ? 30_000 : 300_000;
  const timer = setTimeout(onCancel, maximumMs);
  const canStart = await bounded(Promise.race([ready.promise, canceled.promise.then(() => false)]), 10_000);
  if (canStart && !closed && !canceledOnce) {
    jobSent = true;
    send({ type: 'job', job: input.job });
    await Promise.race([received.promise, canceled.promise]);
    if (!current && !closed && !protocolFailed) await bounded(received.promise, cleanupMs);
  } else onCancel();
  if (!closed && (current?.cleanup === 'closed' || !jobSent)) await bounded(exited.promise, 5_000);
  const isClosed = () => closed && (!jobSent || observation.exitCode === 0
    && (cleanupAcknowledged || !protocolFailed && current?.cleanup === 'closed'));
  const retryCleanup = nativeRelease(async () => {
    if (isClosed()) return;
    if (closed) throw new NativeInputError('worker_cleanup_unproven');
    if (protocolFailed || current?.cleanup !== 'closed') {
      if (cleanupRequests >= 64) throw new NativeInputError('worker_cleanup_attempt_limit');
      activeCleanup = deferred();
      activeCleanupId = ++cleanupRequests;
      send({ type: 'cancel' });
      send({ type: 'cleanup', requestId: activeCleanupId });
      const status = await bounded(activeCleanup.promise, cleanupMs);
      activeCleanup = undefined;
      activeCleanupId = undefined;
      if (status !== 'closed') throw new NativeInputError('cleanup_pending');
    }
    await bounded(exited.promise, 5_000);
    if (!isClosed()) throw new NativeInputError('cleanup_pending');
  });
  return {
    get payload() { return current; },
    get observation() { return observation; },
    get cleanup() { return isClosed() ? 'closed' : 'pending'; },
    retryCleanup,
  };
}
