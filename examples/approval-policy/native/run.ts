import { parseAgentConfigurationRevisionId, parseAgentProviderKey, parseAgentSessionId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import type { AgentItemSnapshot } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderRegistry, type AgentProviderSession, type ValidatedMaterializedAgentProviderInstance } from '@agen-ai/agent-runtime';
import { prepareGrokDockerProvider } from '@agen-ai/provider-grok/docker';
import type { GrokDockerProvider } from '@agen-ai/provider-grok/docker';
import { SandboxRunError, SandboxStartError } from '@agen-ai/sandbox';
import { readSandboxCredentialFile, SandboxDirectoryCleanupError } from '@agen-ai/sandbox/node';
import { DockerImageInspectionError } from '@agen-ai/sandbox-docker/node';
import type { NativeRunConfiguration } from './config.js';
import { NativeExampleError } from './data.js';
import { createArtifacts } from './files.js';
import { consumeReservation } from './reservation.js';
import { safeFailureCode } from './diagnostics.js';
import { residualResolution } from './residual.js';

export type NativeRunStage = 'credential' | 'provider_preparation' | 'workspace_import' | 'registry_materialization' | 'session_open' | 'turn' | 'stop' | 'export' | 'destroy' | 'complete';
const toolItemKinds = new Set<AgentItemSnapshot['itemKind']>(['command_execution', 'file_change', 'mcp_tool_call', 'dynamic_tool_call',
  'collaboration_tool_call', 'web_search', 'browser_action', 'computer_action', 'image_view']);

export interface NativeRunReport {
    stage: NativeRunStage; failureStage?: NativeRunStage; nativeSessionId?: string;
    format: string; runId: string; requestedPolicy: string; reservation: Awaited<ReturnType<typeof consumeReservation>>;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'cleanup_pending';
    effectivePolicy?: AgentProviderSession['approvalPolicy']; turnOutcome?: string;
    output: { events: number; bytes: number; observedToolItems: number; requests: { decision: string; receipt: string; optionId?: string }[] };
    toolActionLimit?: { maximum: number; outcome: 'not_reached' } | { maximum: number; outcome: 'stop_requested'; observedAtStop: number };
    exported?: { files: string; directories: string; symlinks: string; payloadBytes: string; archiveBytes: string };
    inspectionCleanup?: { record: 'inspection-cleanup.json'; identityOnly: true; originalOwnerRequired: true };
    cleanup: { attempts: number; settled: boolean; observedFailures: number; failureCode?: string }; failureCode?: string; artifactFailure?: 'report_persistence_failed';
  }

export class NativeCleanupPendingError extends NativeExampleError {
  constructor(readonly report: NativeRunReport, private readonly cleanup: () => Promise<NativeRunReport>) {
    super('cleanup_pending'); this.name = 'NativeCleanupPendingError';
    Object.defineProperty(this, 'cleanup', { enumerable: false });
  }
  retryCleanup(): Promise<NativeRunReport> { return this.cleanup(); }
}

/** Explicit native execution only. Its safe report never contains prompt, native text or credentials. */
export async function runNative(config: NativeRunConfiguration, externalSignal?: AbortSignal) {
  const reservation = await consumeReservation(config);
  const artifacts = await createArtifacts(config.artifactsDirectory);
  const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(config.limits.runMs)]) : AbortSignal.timeout(config.limits.runMs);
  const report: NativeRunReport = { format: 'agenai.approval-native-result.v1', stage: 'credential', runId: config.runId, requestedPolicy: config.profile.policy,
    reservation, status: 'running', output: { events: 0, bytes: 0, observedToolItems: 0, requests: [] },
    ...(config.limits.maxToolActions === undefined ? {} : { toolActionLimit: { maximum: config.limits.maxToolActions, outcome: 'not_reached' } as const }),
    cleanup: { attempts: 0, settled: false, observedFailures: 0 } };
  let provider: GrokDockerProvider | undefined;
  let registry: AgentProviderRegistry | undefined;
  let instance: ValidatedMaterializedAgentProviderInstance | undefined;
  let session: AgentProviderSession | undefined;
  let reader: Promise<void> | undefined;
  let cancelWork: Promise<void> | undefined;
  let constructorCleanup: (() => Promise<void>) | undefined;
  let transferCleanup: SandboxDirectoryCleanupError | undefined;
  let failed = false; let stopped = false; let exportEntered = false; let cleanupSettled = false;
  const abort = () => {
    if (!cancelWork) cancelWork = Promise.resolve().then(async () => {
      if (registry) await registry.dispose(); else await provider?.dispose();
    });
    void cancelWork.catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const transferBounds = () => ({ deadlineAt: new Date(Date.now() + config.workspace.transferTimeoutMs).toISOString(), quotas: config.workspace.quotas });
  const failure = (error: unknown): void => {
    failed = true;
    const code = safeFailureCode(error);
    report.failureCode ??= code === 'run_failed' && signal.aborted ? 'cancelled' : code; report.failureStage ??= report.stage;
    if (error instanceof SandboxDirectoryCleanupError) transferCleanup = error;
  };
  try {
    await artifacts.write('report.json', report);
    signal.throwIfAborted();
    const bytes = await readSandboxCredentialFile({ path: config.credential.path, signal });
    try {
      signal.throwIfAborted();
      report.stage = 'provider_preparation';
      provider = await prepareGrokDockerProvider({ profile: config.profile, backend: config.backend, workload: config.workload,
        credential: { kind: 'auth_json', bytes }, recovery: { kind: 'persisted', persist: artifacts.persist } });
    } finally { bytes.fill(0); }
    signal.throwIfAborted();
    report.stage = 'workspace_import';
    await provider.workspace.importDirectory(config.workspace.importDirectory, { ...transferBounds(), signal });
    signal.throwIfAborted();
    report.stage = 'registry_materialization';
    registry = await createAgentProviderRegistry({ drivers: [provider.driver], definitions: [{ providerKey: parseAgentProviderKey('grok'),
      instanceId: config.profile.instanceId, driverConfiguration: {} }] });
    const materialized = registry.getInstance(config.profile.instanceId);
    if (!materialized) throw new NativeExampleError('run_failed');
    instance = materialized;
    signal.throwIfAborted();
    report.stage = 'session_open';
    session = await materialized.adapter.createSession({ sessionId: parseAgentSessionId(`approval-native:${config.runId}`), workingDirectory: '/workspace/work',
      configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId(`approval-native:${config.runId}`) },
      approvalPolicy: { kind: config.profile.policy }, signal, onBindingCreated() {} });
    const effectivePolicy = session.approvalPolicy;
    if (effectivePolicy?.verification !== 'controlled_configuration' || effectivePolicy.policy.kind !== config.profile.policy) throw new NativeExampleError('run_failed');
    report.effectivePolicy = effectivePolicy; report.nativeSessionId = session.binding.conversationId;
    await artifacts.write('report.json', report);
    report.stage = 'turn';
    const execution = session.startTurn({ turnId: parseAgentTurnId(`approval-native:${config.runId}`), interactionMode: 'default',
      parts: [{ type: 'text', text: config.prompt }], deadlineAt: new Date(Date.now() + config.limits.runMs).toISOString(), signal });
    reader = (async () => {
      const requests = new Set<string>();
      const toolItems = new Set<string>();
      for await (const output of execution.outputs) {
        report.output.events += 1; report.output.bytes += Buffer.byteLength(JSON.stringify(output));
        if (report.output.events > config.limits.maxOutputEvents || report.output.bytes > config.limits.maxOutputBytes) throw new NativeExampleError('output_limit');
        if (output.kind !== 'event') throw new NativeExampleError('run_failed');
        const event = output.event;
        if (event.type === 'turn.completed') report.turnOutcome = event.payload.outcome;
        if ((event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
          && toolItemKinds.has(event.payload.itemKind) && !toolItems.has(event.payload.itemId)) {
          toolItems.add(event.payload.itemId); report.output.observedToolItems += 1;
          if (report.toolActionLimit?.outcome === 'not_reached' && report.output.observedToolItems >= report.toolActionLimit.maximum) {
            report.toolActionLimit = { maximum: report.toolActionLimit.maximum, outcome: 'stop_requested', observedAtStop: report.output.observedToolItems };
            failure(new NativeExampleError('tool_action_limit'));
            abort(); // Do not await cleanup from inside its original output reader.
          }
        }
        if (event.type !== 'request.opened') continue;
        if (report.toolActionLimit?.outcome === 'stop_requested') continue; // Original stop withdraws later requests; never approve while draining.
        const request = event.payload.request;
        if (request.requestKind !== 'approval' || requests.has(request.requestId) || requests.size >= 16) throw new NativeExampleError('residual_refused');
        requests.add(request.requestId);
        const selected = residualResolution(request, config.residual);
        const receipt = await execution.resolveRequest({ resolution: selected.resolution, signal });
        report.output.requests.push({ decision: config.residual.kind, receipt: receipt.status,
          ...(selected.resolution.requestKind === 'approval' && selected.resolution.disposition === 'selected' ? { optionId: selected.resolution.optionId } : {}) });
        await artifacts.write('report.json', report);
        if (selected.refused || config.residual.kind === 'cancel' || receipt.status !== 'delivered') throw new NativeExampleError('residual_refused');
      }
    })();
    await reader;
    if (report.turnOutcome !== 'completed' || signal.aborted) throw new NativeExampleError('run_failed');
  } catch (error) {
    failure(error);
    if (error instanceof SandboxRunError) constructorCleanup = () => error.retryCleanup();
    else if (error instanceof SandboxStartError) constructorCleanup = () => error.owner.destroy();
    else if (error instanceof DockerImageInspectionError && error.cleanup) {
      const owner = error.cleanup; constructorCleanup = () => owner.retryCleanup();
      report.inspectionCleanup = { record: 'inspection-cleanup.json', identityOnly: true, originalOwnerRequired: true };
      try { await artifacts.write('inspection-cleanup.json', { format: 'agenai.approval-inspection-cleanup.v1', identity: owner.identity }); }
      catch (artifactError) { failure(artifactError); }
    }
  } finally { signal.removeEventListener('abort', abort); }

  // Repeated attempts call only the original cleanup owners. Generation/import/export never replay.
  const completeStatus = () => {
    report.status = !cleanupSettled ? 'cleanup_pending' : signal.aborted || report.toolActionLimit?.outcome === 'stop_requested' ? 'cancelled' : failed ? 'failed' : 'completed';
    if (!cleanupSettled) report.failureCode ??= 'cleanup_pending';
    else if (report.failureCode === 'cleanup_pending') delete report.failureCode;
  };
  const settleAttempt = async (): Promise<boolean> => {
    report.cleanup.attempts += 1;
    try {
      const cancelled = cancelWork; cancelWork = undefined;
      report.stage = 'stop';
      const owners = await Promise.allSettled([
        cancelled, constructorCleanup?.(), transferCleanup?.retryCleanup(),
        provider && !stopped ? session?.close({ reason: failed ? 'error' : 'shutdown' }) : undefined,
        provider && !stopped ? registry?.dispose() : undefined,
      ]);
      if (owners[1]?.status === 'fulfilled') constructorCleanup = undefined;
      if (owners[2]?.status === 'fulfilled') transferCleanup = undefined;
      const unsettled = owners.find((owner) => owner.status === 'rejected');
      if (unsettled?.status === 'rejected') throw unsettled.reason;
      if (instance) stopped = true;
      // Only a returned validated instance has a settled retained workspace.
      if (provider && stopped && !exportEntered) {
        exportEntered = true; report.stage = 'export';
        try {
          const exported = await provider.workspace.exportDirectory({ kind: 'workspace' }, config.workspace.exportDirectory, transferBounds());
          report.exported = { files: String(exported.summary.files), directories: String(exported.summary.directories), symlinks: String(exported.summary.symlinks),
            payloadBytes: String(exported.summary.payloadBytes), archiveBytes: String(exported.summary.archiveBytes) };
        } catch (error) { failure(error); if (transferCleanup) throw error; }
      }
      report.stage = 'destroy';
      await provider?.dispose();
      await reader?.catch(() => {});
      cleanupSettled = true; report.cleanup.settled = true; report.stage = 'complete'; return true;
    } catch (error) { report.cleanup.observedFailures += 1; report.failureStage ??= report.stage; report.cleanup.failureCode = safeFailureCode(error); return false; }
  };
  const persistReport = async (): Promise<void> => {
    try { await artifacts.write('report.json', report); }
    catch {
      report.artifactFailure = 'report_persistence_failed';
      if (cleanupSettled) throw new NativeExampleError('artifact_failed');
    }
  };
  let retryWork: Promise<NativeRunReport> | undefined;
  const retryCleanup = (): Promise<NativeRunReport> => {
    retryWork ??= (async () => {
      await settleAttempt(); completeStatus(); await persistReport();
      if (!cleanupSettled) throw new NativeCleanupPendingError(report, retryCleanup);
      return report;
    })().finally(() => { retryWork = undefined; });
    return retryWork;
  };
  for (let attempt = 0; attempt < config.limits.cleanupAttempts; attempt += 1) if (await settleAttempt()) break;
  completeStatus();
  await persistReport();
  if (!cleanupSettled) throw new NativeCleanupPendingError(report, retryCleanup);
  return report;
}
