import { lstat, readdir } from 'node:fs/promises';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentApprovalPolicySupport } from '@agen-ai/agent-runtime';
import { prepareNodeProviderWorkspace } from '@agen-ai/provider-tools/node';
import type { AcceptEditsPolicyKind, AcceptEditsRunConfig } from './config.js';
import { readApiKeyFile } from './credential.js';
import type { AcceptEditsDecider } from './decisions.js';
import { createDriver, OriginalOwners } from './owners.js';
import { readTurnOutputs } from './reader.js';
import { AcceptEditsCleanupPendingError, failureCode, type AcceptEditsReport } from './report.js';
import { RunStopper } from './stopper.js';

export interface AcceptEditsControls {
  /** Decides each exact action once. Unknown actions and every action after a stop are denied. */
  readonly decide: AcceptEditsDecider;
  /** Aborting requests one interruption of the active turn, then normal original-owner cleanup. */
  readonly signal?: AbortSignal;
}

class AcceptEditsRunError extends Error {
  constructor(readonly code: 'workspace_unprepared' | 'approval_policy_mismatch' | 'stopped') {
    super(`Accept-edits run failed: ${code}.`);
    this.name = 'AcceptEditsRunError';
  }
}

const instanceId = parseAgentInstanceId('accept-edits');

/** True only when this instance offers the policy for session creation. */
export function supportsCreate(support: AgentApprovalPolicySupport, policy: AcceptEditsPolicyKind): boolean {
  return support.kind === 'supported' && support.policies.some((entry) => entry.policy === policy && entry.operations.includes('create'));
}

function newReport(config: AcceptEditsRunConfig): AcceptEditsReport {
  return {
    format: 'agenai.accept-edits-report.v1', provider: config.provider, route: config.route, model: config.model,
    requestedPolicy: config.policy, status: 'failed', stage: 'credential', failureCode: null, stopCode: null,
    readiness: null, support: null, effectivePolicy: null, turnOutcome: null, interruption: 'not_requested',
    output: { events: 0, bytes: 0, toolItems: 0, fileChanges: [], refusals: [] }, requests: [],
    cleanup: { attempts: 0, settled: false, failures: [] },
  };
}

/**
 * Runs one fresh session and one text turn in an already prepared workspace. A policy the instance
 * does not offer for creation is refused before any session opens; there is no fallback policy.
 * Resolves with the report once every original owner has settled, or throws
 * `AcceptEditsCleanupPendingError` carrying a retry of exactly those owners.
 */
export async function runAcceptEdits(config: AcceptEditsRunConfig, controls: AcceptEditsControls): Promise<AcceptEditsReport> {
  const report = newReport(config);
  const owners = new OriginalOwners();
  const stopper = new RunStopper(report, config.limits.settleMs);
  const deadline = setTimeout(() => stopper.stop('deadline'), config.limits.runMs);
  const cancel = () => stopper.stop('cancelled');
  controls.signal?.addEventListener('abort', cancel, { once: true });
  if (controls.signal?.aborted) cancel();
  const throwIfStopped = () => { if (stopper.stopped) throw new AcceptEditsRunError('stopped'); };
  let reader: Promise<void> | undefined;
  try {
    throwIfStopped();
    if (!(await lstat(config.workspace.storeDirectory).catch(() => undefined))?.isDirectory()
      || (await readdir(config.workspace.storeDirectory)).length === 0) throw new AcceptEditsRunError('workspace_unprepared');
    const workspace = await prepareNodeProviderWorkspace({ directory: config.workspace.storeDirectory });
    const apiKey = await readApiKeyFile(config.credential.path);
    throwIfStopped();

    report.stage = 'materialize';
    const driver = await createDriver(config, workspace, apiKey);
    const registry = await createAgentProviderRegistry({ drivers: [driver],
      definitions: [{ providerKey: driver.providerKey, instanceId, driverConfiguration: { model: config.model } }] });
    owners.registry = registry;
    const readiness = await registry.checkReadiness(instanceId);
    report.readiness = { status: readiness.status, version: readiness.version ?? null };

    report.stage = 'discover';
    const adapter = registry.requireInstance(instanceId).adapter;
    report.support = adapter.approvalPolicy ?? { kind: 'unsupported' };
    if (!supportsCreate(report.support, config.policy)) {
      report.status = 'refused';
      report.failureCode = 'approval_policy_unsupported';
    } else {
      throwIfStopped();
      report.stage = 'open';
      const session = await adapter.createSession({ sessionId: parseAgentSessionId('accept-edits'),
        workingDirectory: workspace.workspaceDirectory,
        configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('accept-edits') },
        onBindingCreated() {}, approvalPolicy: { kind: config.policy }, signal: stopper.signal });
      owners.session = session;
      report.effectivePolicy = session.approvalPolicy ?? null;
      if (report.effectivePolicy?.policy.kind !== config.policy) throw new AcceptEditsRunError('approval_policy_mismatch');
      throwIfStopped();

      report.stage = 'turn';
      const turnId = parseAgentTurnId('accept-edits-turn');
      const execution = session.startTurn({ turnId, interactionMode: 'default', parts: [{ type: 'text', text: config.prompt }],
        deadlineAt: new Date(Date.now() + config.limits.runMs).toISOString() });
      stopper.attach(session, turnId);
      reader = readTurnOutputs({ execution, config, decide: controls.decide, stopper, report });
      // A stopped turn gets `settleMs` to end; otherwise cleanup closes it while the reader stays owned.
      await Promise.race([reader, stopper.graceElapsed]);
      report.status = stopper.stopped ? 'cancelled' : report.turnOutcome === 'completed' && report.failureCode === null ? 'completed' : 'failed';
    }
  } catch (error) {
    owners.retainFailure(error);
    report.status = stopper.stopped ? 'cancelled' : 'failed';
    report.failureCode ??= error instanceof AcceptEditsRunError && error.code === 'stopped' ? null : failureCode(error);
  } finally {
    clearTimeout(deadline);
    controls.signal?.removeEventListener('abort', cancel);
  }
  return settle(report, owners, stopper, reader, config.limits.cleanupAttempts);
}

async function settle(report: AcceptEditsReport, owners: OriginalOwners, stopper: RunStopper,
  reader: Promise<void> | undefined, attempts: number): Promise<AcceptEditsReport> {
  const outcome = report.status;
  const attempt = async (): Promise<unknown[]> => {
    report.cleanup.attempts += 1;
    await stopper.join();
    const failures = await owners.settle();
    // The reader ends once the session owner closes; it records failures and never rejects.
    if (failures.length === 0) await reader;
    report.cleanup.failures.push(...failures.map(failureCode));
    report.cleanup.settled = failures.length === 0;
    report.status = report.cleanup.settled ? outcome : 'cleanup_pending';
    return failures;
  };
  let failures: unknown[] = [];
  for (let index = 0; index < attempts && !report.cleanup.settled; index += 1) failures = await attempt();
  if (report.cleanup.settled) return report;
  const retryCleanup = async (): Promise<AcceptEditsReport> => {
    const retryFailures = await attempt();
    if (retryFailures.length > 0) throw new AcceptEditsCleanupPendingError(report, retryCleanup, new AggregateError(retryFailures));
    return report;
  };
  throw new AcceptEditsCleanupPendingError(report, retryCleanup, new AggregateError(failures));
}
