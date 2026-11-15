import { parseAgentProviderKey, parseAgentSessionOpenInput } from '@agen-ai/agent-protocol';
import {
  AgentProviderSessionCleanupError, createAgentProviderSessionCleanupError, defineAgentProviderDriver,
  type AgentProviderCreateSessionInput, type AgentProviderSession, type MaterializedAgentProviderInstance,
} from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver, isNodeAcpExecutionCleanupError, type NodeAcpExecutionBoundary, type NodeAcpExecutionReservation } from '@agen-ai/provider-acp/node';
import type { Sandbox } from '@agen-ai/sandbox';
import { exportSandboxDirectory, importSandboxDirectory, reserveSandboxCredentialProcess } from '@agen-ai/sandbox/node';
import { GROK_DOCKER_APPROVAL_MAPPING, GROK_DOCKER_PROVIDER_KEY } from '../index.js';
import type { GrokDockerApprovalProfile, GrokDockerImportOptions, GrokDockerProvider } from './contracts.js';
import { fields, invalid } from './data.js';
import { BOOTSTRAP, LAUNCHER, PROCESS_ENV, WORKSPACE } from './profile.js';

/** All physical cleanup paths retain this owner; logical admission never reopens. */
export function ownProvider(profile: GrokDockerApprovalProfile, sandbox: Sandbox, credential: Uint8Array): GrokDockerProvider {
  const providerKey = parseAgentProviderKey(GROK_DOCKER_PROVIDER_KEY);
  let outer: 'open' | 'disposing' | 'disposed' = 'open';
  let admission: 'fresh' | 'materializing' | 'materialized' | 'closed' = 'fresh';
  let stopped = false;
  let openingSpent = false;
  let processSpent = false;
  let native: MaterializedAgentProviderInstance | undefined;
  let materializing: Promise<MaterializedAgentProviderInstance> | undefined;
  let opening: Promise<AgentProviderSession> | undefined;
  let stopPending: Promise<void> | undefined;
  let disposePending: Promise<void> | undefined;
  const transfers = new Set<Promise<unknown>>();
  const failedCleanup = new Set<AgentProviderSessionCleanupError | { retryCleanup(): Promise<void> }>();
  const remember = (error: unknown): void => {
    if (error instanceof AgentProviderSessionCleanupError || isNodeAcpExecutionCleanupError(error)) failedCleanup.add(error);
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    transfers.add(work);
    return work.finally(() => transfers.delete(work));
  };
  const rejectClosed = (): never => { throw new Error('The controlled Grok owner no longer admits this operation.'); };

  const stop = (): Promise<void> => {
    admission = 'closed';
    if (stopped) return Promise.resolve();
    if (!stopPending) stopPending = Promise.resolve().then(async () => {
      // Stop the workload first to interrupt any entered eager launch/opening, then join those owners.
      const workloadStop = Promise.resolve().then(() => sandbox.stop()).then(
        () => ({ kind: 'settled' as const }), (error: unknown) => ({ kind: 'failed' as const, error }));
      await Promise.allSettled([materializing, opening, ...transfers]);
      const failures: unknown[] = [];
      const workload = await workloadStop;
      if (workload.kind === 'failed') failures.push(workload.error);
      if (native) try { await native.dispose(); } catch (error) { remember(error); failures.push(error); }
      for (const owner of failedCleanup) {
        try { await owner.retryCleanup(); failedCleanup.delete(owner); }
        catch (error) { failures.push(error); }
      }
      credential.fill(0);
      if (failures.length) throw new AggregateError(failures, 'Controlled Grok stop remains incomplete.');
      stopped = true;
    }).finally(() => { stopPending = undefined; });
    return stopPending;
  };
  const boundary = Object.freeze<NodeAcpExecutionBoundary>({
    reserve(input) {
      if (outer !== 'open' || admission === 'closed' || processSpent) rejectClosed();
      processSpent = true;
      const reservation = reserveSandboxCredentialProcess(sandbox, {
        bootstrapExecutable: BOOTSTRAP,
        process: { executable: input.executable, args: input.args, cwd: input.cwd, env: input.env },
        file: { name: 'auth.json', bytes: credential }, preparationTimeoutMs: 10_000,
      });
      credential.fill(0);
      return Object.freeze<NodeAcpExecutionReservation>({
        async start(context) {
          const streams = await reservation.start({ signal: context.signal });
          return Object.freeze({ stdin: streams.stdin, stdout: streams.stdout, stderr: streams.stderr });
        },
        async release() { await sandbox.stop(); },
      });
    },
  });
  const lower = createNodeAcpProviderDriver({ providerKey, launch: {
    executable: LAUNCHER, args: [], cwd: WORKSPACE, env: PROCESS_ENV, shutdownTimeoutMs: 10_000,
  }, executionBoundary: boundary, configuration: 'managed', permissionMapping: { mapping: 'once-only-v1' },
  protocolDialect: { mapping: GROK_DOCKER_APPROVAL_MAPPING, instanceId: profile.instanceId,
    nativeSessionId: profile.nativeSessionId, policy: profile.policy } });

  const wrapSession = (session: AgentProviderSession, openingInput: AgentProviderCreateSessionInput): AgentProviderSession => Object.freeze<AgentProviderSession>({
    ...session,
    approvalPolicy: Object.freeze({ policy: Object.freeze({ kind: profile.policy }), verification: 'controlled_configuration' as const }),
    startTurn(input) {
      if (outer !== 'open' || admission !== 'materialized') rejectClosed();
      return session.startTurn(input);
    },
    async close(input) {
      try { await session.close(input); }
      catch (error) { remember(error); throw error; }
      try { await stop(); }
      catch (error) { throw createAgentProviderSessionCleanupError({ providerKey, openingInput,
        errors: [error], retryCleanup: stop }); }
    },
  });
  const createSession = (input: AgentProviderCreateSessionInput): Promise<AgentProviderSession> => {
    const owner = native;
    if (outer !== 'open' || admission !== 'materialized' || openingSpent || !owner) return Promise.reject(new Error('The controlled Grok owner no longer admits this opening.'));
    const captured = fields(input, ['sessionId', 'workingDirectory', 'configuration', 'onBindingCreated', 'approvalPolicy'], ['signal']);
    const policy = fields(captured.approvalPolicy, ['kind']);
    if (policy.kind !== profile.policy || captured.workingDirectory !== WORKSPACE || typeof captured.onBindingCreated !== 'function') invalid();
    const parsed = parseAgentSessionOpenInput({ operation: 'create', sessionId: captured.sessionId, configuration: captured.configuration });
    if (parsed.configuration.kind !== 'managed') invalid();
    if (captured.signal !== undefined && !(captured.signal instanceof AbortSignal)) invalid();
    captured.signal?.throwIfAborted();
    const bindingObserver = captured.onBindingCreated;
    const context: AgentProviderCreateSessionInput = { sessionId: parsed.sessionId, workingDirectory: WORKSPACE,
      configuration: parsed.configuration, onBindingCreated: (binding) => bindingObserver(binding),
      ...(captured.signal ? { signal: captured.signal } : {}) };
    openingSpent = true;
    opening = Promise.resolve().then(() => {
      if (outer !== 'open' || admission !== 'materialized') rejectClosed();
      return owner.adapter.createSession(context);
    }).then((session) => wrapSession(session, input)).catch((error: unknown) => {
      remember(error);
      if (error instanceof AgentProviderSessionCleanupError) throw createAgentProviderSessionCleanupError({
        providerKey, openingInput: input, errors: [error], retryCleanup: () => stop(),
      });
      throw error;
    });
    return opening;
  };
  const driver = defineAgentProviderDriver({ providerKey, supportsMultipleInstances: false,
    parseConfiguration(value) { fields(value, []); return Object.freeze({}); },
    validateConfiguration(input) {
      if (input.instanceId !== profile.instanceId || outer !== 'open' || admission !== 'fresh') rejectClosed();
    },
    createInstance(input) {
      admission = 'materializing';
      const imports = [...transfers];
      materializing = Promise.resolve().then(async () => {
        await Promise.all(imports);
        if (outer !== 'open' || admission === 'closed') rejectClosed();
        native = await lower.materialize({ providerKey, instanceId: input.instanceId, driverConfiguration: {} });
        if (outer !== 'open' || admission === 'closed') { await native.dispose(); rejectClosed(); }
        admission = 'materialized';
        return Object.freeze({ ...native, adapter: Object.freeze({ ...native.adapter,
          approvalPolicy: Object.freeze({ kind: 'supported' as const, policies: Object.freeze([
            Object.freeze({ policy: profile.policy, operations: Object.freeze(['create'] as const) }),
          ] as const) }), createSession }), dispose: stop });
      }).catch((error: unknown) => { remember(error); admission = 'closed'; credential.fill(0); throw error; });
      return materializing;
    },
  });
  return Object.freeze<GrokDockerProvider>({ driver,
    workspace: Object.freeze<GrokDockerProvider['workspace']>({
      importDirectory(directory, options) {
        if (outer !== 'open' || admission !== 'fresh') rejectClosed();
        requireTransferBounds(options);
        return track(importSandboxDirectory(sandbox, directory, options).catch((error: unknown) => {
          admission = 'closed';
          throw error;
        }));
      },
      exportDirectory(selection, directory, options) {
        if (outer !== 'open' || !stopped || stopPending || failedCleanup.size > 0) rejectClosed();
        requireTransferBounds(options);
        return track(exportSandboxDirectory(sandbox, selection, directory, options));
      },
    }),
    get recoveryRecord() { return sandbox.recoveryRecord; },
    dispose() {
      if (outer === 'disposed') return Promise.resolve();
      outer = 'disposing';
      admission = 'closed';
      if (!disposePending) disposePending = Promise.resolve().then(async () => {
        await stop();
        // A stopped guest may still have an entered host export staging/publication owner.
        await Promise.allSettled([...transfers]);
        await sandbox.destroy();
        outer = 'disposed';
      }).finally(() => { disposePending = undefined; });
      return disposePending;
    },
  });
}

function requireTransferBounds(value: GrokDockerImportOptions): void {
  const input = fields(value, ['deadlineAt', 'quotas'], ['signal', 'symlinks', 'chunkBytes']);
  if (typeof input.deadlineAt !== 'string' || !Number.isFinite(Date.parse(input.deadlineAt)) || Date.parse(input.deadlineAt) <= Date.now()) invalid();
  const quotas = fields(input.quotas, ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxArchiveBytes', 'maxPaths'], ['maxSymlinks']);
  for (const quota of Object.values(quotas)) if (typeof quota !== 'number' && typeof quota !== 'bigint'
    || typeof quota === 'number' && (!Number.isSafeInteger(quota) || quota < 0) || typeof quota === 'bigint' && quota < 0n) invalid();
  if (input.symlinks === 'preserve_internal' && quotas.maxSymlinks === undefined) invalid();
}
