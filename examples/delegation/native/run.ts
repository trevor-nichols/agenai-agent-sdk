import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { NativeCandidate, NativeSelection } from './contracts.js';
import { discoverNativeConfiguration, runNativeQualificationMode } from './host.js';
import {
  NATIVE_QUALIFICATION_BUDGETS as B, NativeQualificationError,
  type NativeCleanupReceipt, type NativeDiscoveryReport, type NativeDiscoveryResult, type NativeFailureReason,
  type NativeModeReport, type NativeModeResult,
} from './host-contracts.js';
import { assertRunnerIdentity, assertSdkIdentity } from './identity.js';
import { NativeInputError, semanticDigest } from './json.js';
import { allocateNativeProcess, inspectNativeRoot, NativeCleanupError, nativeRelease, prepareDirectExecutable } from './launch.js';
import type { NativeExecutableLease, NativeProcessAllocation, RegistryInstallationDescriptor } from './launch-contracts.js';
import { openRegistryExecutable } from './registry.js';
import { executeNativeWorker, type NativeProcessProof, type NativeWorkerLease, type SerializableNativeOperation } from './process.js';

export type { NativeAllocationEvidence, NativeProcessObservation, NativeProcessProof } from './process.js';

export interface RunNativeOperationInput {
  readonly command: 'discover' | 'execute';
  readonly candidate: NativeCandidate;
  readonly launch: 'direct' | 'registry';
  readonly selection?: NativeSelection;
  readonly root: string;
  readonly signal?: AbortSignal;
}

export interface NativeOperationResult extends SerializableNativeOperation {
  readonly processProof: NativeProcessProof;
  readonly retryCleanup?: () => Promise<void>;
}

export function nativeOperationErrorCode(error: unknown): string {
  if (error instanceof NativeInputError && /^[a-z_]{1,100}$/u.test(error.code)) return error.code;
  if (error instanceof NativeQualificationError) return error.reason;
  return 'native_preparation_failed';
}

function failureReason(code: string, launch: RunNativeOperationInput['launch']): NativeFailureReason {
  const known: readonly NativeFailureReason[] = ['artifact_unapproved', 'artifact_identity_drift', 'credential_unavailable',
    'credential_isolation_unavailable', 'authentication_failed', 'authentication_expired', 'configuration_unknown',
    'configuration_scope_unverified', 'standard_mapping_unverified', 'source_identity_drift', 'registry_distribution_unavailable',
    'mcp_tools_unexposed', 'native_extension_required', 'native_protocol_incompatible', 'approval_not_authorized', 'parent_did_not_delegate',
    'child_result_unavailable', 'parent_completion_mismatch', 'completed_before_cancellation', 'cancellation_unsupported',
    'budget_exhausted', 'dispatch_uncertain', 'cleanup_pending'];
  if (known.includes(code as NativeFailureReason)) return code as NativeFailureReason;
  if (code.startsWith('worker_') || code.startsWith('input_')) return 'native_protocol_incompatible';
  return launch === 'registry' ? 'registry_distribution_unavailable' : 'artifact_unapproved';
}

async function awaitCleanup(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new NativeInputError('cleanup_pending')), B.cleanupMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function readNativeCredential(candidate: NativeCandidate, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  const path = candidate.credential.path;
  if (candidate.credential.kind !== 'dotenv' || candidate.credential.key !== 'XAI_API_KEY'
    || !isAbsolute(path) || resolve(path) !== path) throw new NativeQualificationError('credential_unavailable');
  try {
    if (await realpath(path) !== path) throw new NativeQualificationError('credential_unavailable');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 262_144) throw new NativeQualificationError('credential_unavailable');
      const bytes = Buffer.alloc(before.size + 1);
      try {
        let used = 0;
        while (used < bytes.length) {
          signal?.throwIfAborted();
          const read = await file.read(bytes, used, bytes.length - used, used);
          if (!read.bytesRead) break;
          used += read.bytesRead;
        }
        const after = await file.stat();
        if (used !== before.size || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) {
          throw new NativeQualificationError('credential_unavailable');
        }
        const value = parseEnv(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))).XAI_API_KEY;
        signal?.throwIfAborted();
        return value?.trim() ? value : undefined;
      } finally { bytes.fill(0); }
    } finally { await file.close(); }
  } catch { throw new NativeQualificationError(signal?.aborted ? 'budget_exhausted' : 'credential_unavailable'); }
}

function pendingReport(command: RunNativeOperationInput['command']): NativeDiscoveryReport | NativeModeReport {
  const cleanup: NativeCleanupReceipt = { status: 'pending', coordinatorClosed: false, sessionsClosed: false,
    registriesClosed: false, bridgesAcquired: 0, bridgesReleased: 0, elapsedMs: 0 };
  const common = { version: 1 as const, outcome: 'cleanup_pending' as const, reason: 'cleanup_pending' as const,
    failedGates: [{ gate: 'cleanup' as const, reason: 'cleanup_pending' as const }], configurationStarts: 0, cleanup };
  return command === 'discover'
    ? { ...common, noPrompt: true, elapsedMs: 0, modelAcknowledged: false, reasoningAcknowledged: false }
    : { ...common, version: 2, budgets: B, usage: { turns: 0, elapsedMs: 0 }, sessions: [], turns: [], tools: [], admissions: [],
      childConfigurations: [], cancellation: { status: 'not_started' } };
}

function pendingCleanupReport(report: NativeDiscoveryReport | NativeModeReport): NativeDiscoveryReport | NativeModeReport {
  const failedGates = report.failedGates.some(({ gate, reason }) => gate === 'cleanup' && reason === 'cleanup_pending')
    ? report.failedGates : [...report.failedGates, { gate: 'cleanup' as const, reason: 'cleanup_pending' as const }];
  return { ...report, outcome: 'cleanup_pending', reason: 'cleanup_pending', failedGates };
}

export function failedNativeReport(command: RunNativeOperationInput['command'], reason: NativeFailureReason): NativeDiscoveryReport | NativeModeReport {
  const baseline = pendingReport(command);
  return { ...baseline, outcome: 'blocked', reason, failedGates: [{ gate: 'opening', reason }],
    cleanup: { status: 'closed', coordinatorClosed: true, sessionsClosed: true, registriesClosed: true,
      bridgesAcquired: 0, bridgesReleased: 0, elapsedMs: 0 } };
}

/** Inert composition shared by the direct host and the fresh retained-installation worker. */
export async function runNativeLocalOperation(input: RunNativeOperationInput & {
  readonly installation?: RegistryInstallationDescriptor;
}): Promise<Omit<NativeOperationResult, 'processProof'>> {
  input.signal?.throwIfAborted();
  await assertSdkIdentity(input.candidate.sdk);
  await assertRunnerIdentity(input.candidate);
  await inspectNativeRoot(input.root);
  input.signal?.throwIfAborted();
  if (input.command === 'execute' && !input.selection || input.command === 'discover' && input.selection) {
    throw new NativeInputError('selection_required_for_execution');
  }
  const allocations: NativeProcessAllocation[] = [];
  let executable: NativeExecutableLease | undefined;
  let host: NativeDiscoveryResult | NativeModeResult | undefined;
  let preparationCleanup: (() => Promise<void>) | undefined;
  let failureCode: string | undefined;
  const release = nativeRelease(async () => {
    if (preparationCleanup) await preparationCleanup();
    if (host?.retryCleanup) await host.retryCleanup();
    const released = await Promise.allSettled(allocations.map((allocation) => allocation.release()));
    if (released.some((result) => result.status === 'rejected')) throw new NativeInputError('cleanup_pending');
    await executable?.release();
  });
  const retryCleanup = () => awaitCleanup(release());
  try {
    executable = input.launch === 'direct'
      ? await prepareDirectExecutable({ candidate: input.candidate, root: input.root, ...(input.signal ? { signal: input.signal } : {}) })
      : input.installation ? await openRegistryExecutable({ candidate: input.candidate, root: input.root,
        installation: input.installation, ownerId: `native-qualification:${randomUUID()}`, ...(input.signal ? { signal: input.signal } : {}) })
        : (() => { throw new NativeInputError('registry_descriptor_required'); })();
    const allocate = async (role: NativeProcessAllocation['role']) => {
      const allocation = await allocateNativeProcess({ root: input.root, role, executable: executable!,
        credential: (signal) => readNativeCredential(input.candidate, signal), ...(input.signal ? { signal: input.signal } : {}) });
      allocations.push(allocation);
      return allocation;
    };
    if (input.command === 'discover') {
      const allocation = await allocate('discovery');
      host = await discoverNativeConfiguration({ executable, allocation, choice: input.candidate.choice,
        ...(input.signal ? { signal: input.signal } : {}) });
    } else {
      const parent = await allocate('parent');
      const child = await allocate('child');
      const comparison = await allocate('comparison');
      host = await runNativeQualificationMode({ executable, allocations: { parent, child, comparison },
        selection: input.selection!.configuration, mapping: input.selection!.mapping,
        ...(input.selection!.parentPermissionProof ? { parentPermissionPolicy: {
          profile: input.selection!.parentPermissionProof.profile,
          proofDigest: semanticDigest(input.selection!.parentPermissionProof),
          executableSha256: input.selection!.parentPermissionProof.executableSha256,
        } } : {}),
        ...(input.signal ? { signal: input.signal } : {}) });
    }
    if (host.report.cleanup.status === 'closed') await executable.assertUnchanged();
  } catch (error) {
    failureCode = input.signal?.aborted ? 'budget_exhausted' : nativeOperationErrorCode(error);
    if (error instanceof NativeCleanupError) preparationCleanup = error.retryCleanup;
  }
  let cleanup: 'closed' | 'pending' = 'pending';
  if (host?.report.cleanup.status !== 'pending') {
    try { await retryCleanup(); cleanup = 'closed'; } catch { /* The actual retry capability stays owned below. */ }
  }
  const reason = failureCode ? failureReason(failureCode, input.launch) : undefined;
  const report = reason && cleanup === 'closed'
    ? host ? { ...host.report, outcome: 'blocked' as const, reason, failedGates: [...host.report.failedGates, { gate: 'opening' as const, reason }] }
      : failedNativeReport(input.command, reason)
    : host?.report ?? pendingReport(input.command);
  return { report: cleanup === 'pending' ? pendingCleanupReport(report) : report,
    ...(executable ? { executable: executable.evidence } : {}),
    allocations: allocations.map(({ allocationId, role, environmentKeys }) => ({ allocationId, role, environmentKeys })),
    cleanup, ...(cleanup === 'pending' ? { retryCleanup } : {}) };
}

async function runNativeInvocation(input: RunNativeOperationInput, clock: () => number): Promise<NativeOperationResult> {
  input.signal?.throwIfAborted();
  await assertSdkIdentity(input.candidate.sdk);
  await assertRunnerIdentity(input.candidate);
  await inspectNativeRoot(input.root);
  input.signal?.throwIfAborted();
  if (input.launch === 'direct') {
    const result = await runNativeLocalOperation(input);
    return { ...result, processProof: { format: 'native-process-ownership-v1', composition: 'direct-local',
      launcherProcessId: process.pid, run: { processId: process.pid, spawnedAt: 0, readyAt: 0, settledAt: clock() },
      freshProcessReopened: false } };
  }
  const worker = new URL('./worker.ts', import.meta.url);
  const installer = await executeNativeWorker({ worker, job: { kind: 'install', candidate: input.candidate, root: input.root },
    root: input.root, clock, ...(input.signal ? { signal: input.signal } : {}) });
  const installerProof = (): NativeProcessProof => ({ format: 'native-process-ownership-v1', composition: 'registry-fresh-process',
    launcherProcessId: process.pid, installer: installer.observation, freshProcessReopened: false });
  if (installer.cleanup !== 'closed') {
    return { report: pendingReport(input.command), allocations: [], processProof: installerProof(), cleanup: 'pending',
      retryCleanup: installer.retryCleanup };
  }
  const installed = installer.payload;
  if (installed?.kind !== 'installed') {
    return { report: failedNativeReport(input.command, failureReason(installed?.kind === 'failure' ? installed.code : 'registry_distribution_unavailable', 'registry')),
      allocations: [], processProof: installerProof(), cleanup: 'closed' };
  }
  let run: NativeWorkerLease;
  try {
    run = await executeNativeWorker({ worker, job: { kind: 'operate', candidate: input.candidate, command: input.command,
      root: input.root, installation: installed.installation, ...(input.selection ? { selection: input.selection } : {}) },
      root: input.root, clock, ...(input.signal ? { signal: input.signal } : {}) });
  } catch (error) {
    const reason = input.signal?.aborted ? 'budget_exhausted' : failureReason(nativeOperationErrorCode(error), 'registry');
    return { report: failedNativeReport(input.command, reason), allocations: [], processProof: installerProof(), cleanup: 'closed' };
  }
  const processProof = (freshProcessReopened: boolean): NativeProcessProof => ({ format: 'native-process-ownership-v1', composition: 'registry-fresh-process',
    launcherProcessId: process.pid, installer: installer.observation, run: run.observation, freshProcessReopened });
  try {
    const result = run.payload;
    const operation = result?.kind === 'operation' ? result.result : run.cleanup === 'closed'
      ? { report: failedNativeReport(input.command, failureReason(result?.kind === 'failure' ? result.code : 'native_protocol_incompatible', 'registry')),
        allocations: [], cleanup: 'closed' as const }
      : { report: pendingReport(input.command), allocations: [], cleanup: 'pending' as const };
    const freshProcessReopened = installer.observation.exitCode === 0 && installer.observation.exitedAt !== undefined
      && run.observation.spawnedAt >= installer.observation.exitedAt && run.observation.readyAt !== undefined
      && installed.installation.installerProcessId === installer.observation.processId
      && run.observation.processId !== installer.observation.processId
      && operation.executable?.registry?.reopenedFromFreshProcess === true;
    const cleanup = operation.cleanup === 'closed' && run.cleanup === 'closed' ? 'closed' : 'pending';
    return { ...operation, report: cleanup === 'pending' ? pendingCleanupReport(operation.report) : operation.report,
      processProof: processProof(freshProcessReopened), cleanup,
      ...(cleanup === 'pending' ? { retryCleanup: run.retryCleanup } : {}) };
  } catch {
    const cleanup = run.cleanup;
    return { report: cleanup === 'closed' ? failedNativeReport(input.command, 'native_protocol_incompatible') : pendingReport(input.command),
      allocations: [], processProof: processProof(false), cleanup,
      ...(cleanup === 'pending' ? { retryCleanup: run.retryCleanup } : {}) };
  }
}

export async function runNativeOperation(input: RunNativeOperationInput): Promise<NativeOperationResult> {
  const started = performance.now();
  const clock = () => performance.now() - started;
  const lifetime = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal;
  // This referenced timer belongs to the invocation, including preflight and both registry workers.
  const timer = setTimeout(() => lifetime.abort(new NativeInputError('budget_exhausted')), B.modeMs);
  try {
    const result = await runNativeInvocation({ ...input, signal }, clock);
    const elapsed = result.processProof.run?.settledAt ?? clock();
    if (result.report.outcome === 'qualified' && (elapsed - result.report.cleanup.elapsedMs > B.modeMs
      || elapsed > B.modeMs + B.cleanupMs)) {
      return { ...result, report: { ...result.report, outcome: 'blocked', reason: 'budget_exhausted',
        failedGates: [...result.report.failedGates, { gate: 'opening', reason: 'budget_exhausted' }] } };
    }
    return result;
  } finally { clearTimeout(timer); }
}
