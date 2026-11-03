import { reconcileSandboxRecovery } from '@agen-ai/sandbox/backend';
import { SandboxCleanupError, SandboxOperationError } from '@agen-ai/sandbox';
import type { OperationOptions, SandboxCleanupOwner, SandboxReconciliation, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { DOCKER_BACKEND_ID, parseCoordinatedDockerCleanupConfig } from '../../policy/config.js';
import { configurationBackendRevision } from '../../recovery/identity.js';
import { RecoveryCleanupJournalAdapter } from '../../network/desktop/coordinator/administrativeRecovery/cleanupAdapter.js';
import type { RecoveryCleanupAdapterPorts } from '../../network/desktop/coordinator/administrativeRecovery/cleanupAdapter.js';
import { originalRecoverySnapshot } from '../../network/desktop/coordinator/administrativeRecovery/validation.js';
import type { MemberTerminalDecision } from '../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { observeRetainedOperation } from '../../network/desktop/coordinator/operations.js';
import { captureDesktopCleanupInput } from '../desktopCoordinatorCleanup.js';
import { DockerDesktopRecoveryError } from './contracts.js';
import type { DockerDesktopRecoveryController } from './contracts.js';

/** Owns whole member operations, including gaps between their physical sequence entries. */
export class RecoveryMembers {
  readonly adapter: RecoveryCleanupJournalAdapter;
  private readonly entered = new Set<Promise<unknown>>();
  private readonly terminals = new Map<string, SandboxRecoveryRecord>();
  private readonly owners = new Map<string, SandboxCleanupOwner>();

  constructor(private readonly ports: RecoveryCleanupAdapterPorts,
    private readonly owner: DockerDesktopRecoveryController, private readonly assertAdmission: () => void) {
    this.adapter = new RecoveryCleanupJournalAdapter({ ...ports,
      publishSdkDecision: async (decision) => {
        const receipt = await ports.publishSdkDecision(decision);
        if (decision.kind === 'member_terminal') this.rememberTerminal(decision);
        return receipt;
      },
    });
  }

  get pending(): readonly Promise<unknown>[] { return [...this.entered]; }

  get records(): readonly SandboxRecoveryRecord[] {
    const current = this.ports.current();
    const original = originalRecoverySnapshot(current).generation;
    const generation = current.projection.snapshot.generation;
    if (original.kind !== 'dirty' || generation.kind !== 'dirty') throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.owner);
    return Object.freeze([...original.members].sort((left, right) => left.memberSequence - right.memberSequence).map((member) => {
      const record = generation.members.find((entry) => entry.memberId === member.memberId)?.checkpoint.record
        ?? this.terminals.get(member.memberId);
      if (!record) throw new DockerDesktopRecoveryError({ kind: 'identity_conflict', scope: 'evidence' }, this.owner);
      return record;
    }));
  }

  async initialize(): Promise<void> {
    for (const terminal of this.ports.current().memberTerminals) {
      const decision = await this.ports.readSdkDecision(terminal.receipt);
      if (decision.kind !== 'member_terminal') throw new DockerDesktopRecoveryError({ kind: 'identity_conflict', scope: 'evidence' }, this.owner);
      this.rememberTerminal(decision);
    }
    await this.adapter.members();
  }

  private rememberTerminal(decision: MemberTerminalDecision): void { this.terminals.set(decision.memberId, decision.record); }

  private track<Value>(perform: () => Promise<Value>): Promise<Value> {
    if (this.entered.size >= 16) return Promise.reject(new DockerDesktopRecoveryError({ kind: 'capacity_exhausted', resource: 'sequence' }, this.owner));
    const actual = Promise.resolve().then(perform);
    this.entered.add(actual);
    const complete = () => { this.entered.delete(actual); };
    void actual.then(complete, complete);
    return actual;
  }

  reconcile(input: unknown, options?: OperationOptions): Promise<SandboxReconciliation> {
    this.assertAdmission();
    return this.reconcileActual(input, options);
  }

  private async reconcileActual(input: unknown, options?: OperationOptions): Promise<SandboxReconciliation> {
    const captured = captureDesktopCleanupInput(input);
    const envelope = this.ports.current();
    const generation = envelope.projection.snapshot.generation;
    if (generation.kind !== 'dirty') throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.owner);
    const config = parseCoordinatedDockerCleanupConfig(captured.configuration, {
      endpoint: envelope.preparation.configuredEndpoint, configurationDigest: envelope.preparation.sharedDigest,
      identity: { protocol: 'agenai.desktop-coordinator.v1', authorityId: envelope.authorityId,
        engineKey: envelope.engineKey, daemonId: envelope.daemonId, generation: generation.identity },
    });
    let driver: SandboxCleanupOwner | undefined;
    const result = await reconcileSandboxRecovery({ backendId: DOCKER_BACKEND_ID,
      backendRevision: configurationBackendRevision(config),
      reconcile: (record, operation) => this.track(async () => {
        const reconciled = await this.adapter.reconcile(config, record, operation?.signal);
        if (reconciled.kind === 'matched' || reconciled.kind === 'uncertain') driver = reconciled.owner;
        return reconciled;
      }),
    }, captured.record, options);
    if (result.kind !== 'matched' && result.kind !== 'uncertain') return result;
    if (!driver) throw new DockerDesktopRecoveryError({ kind: 'invalid_state' }, this.owner);
    const retired = this.ports.current().memberTerminals.some((member) => member.memberId === captured.record.operationId);
    let cleanup = retired ? undefined : this.owners.get(captured.record.operationId);
    if (!cleanup) {
      // The neutral seam validates continuation; this owner retains each complete driver operation.
      cleanup = this.cleanupOwner(driver, () => result.owner.recoveryRecord);
      this.owners.set(captured.record.operationId, cleanup);
    }
    return Object.freeze({ kind: result.kind, owner: cleanup });
  }

  private cleanupOwner(driver: SandboxCleanupOwner, record: () => SandboxRecoveryRecord): SandboxCleanupOwner {
    const actions = new Map<'stop' | 'destroy', Promise<void>>();
    const run = (action: 'stop' | 'destroy') => {
      let actual = actions.get(action);
      if (!actual) {
        this.assertAdmission();
        actual = this.track(async () => {
          void record();
          await driver[action]();
          void record();
        });
        actions.set(action, actual);
        void actual.catch(() => { if (actions.get(action) === actual) actions.delete(action); });
      }
      return observeRetainedOperation(actual, { timeoutMs: 30_000 },
        (by) => new SandboxOperationError(by === 'signal' ? 'cancelled' : 'deadline_exceeded', 'Recovered cleanup observation was interrupted.'))
        .catch((cause: unknown) => { throw new SandboxCleanupError('Recovered sandbox cleanup failed.', { cause, operation: action, owner: facade }); });
    };
    const facade: SandboxCleanupOwner = Object.freeze({
      get recoveryRecord() { return record(); },
      stop() { if (this !== facade) throw new TypeError('Recovery cleanup requires its original owner.'); return run('stop'); },
      destroy() { if (this !== facade) throw new TypeError('Recovery cleanup requires its original owner.'); return run('destroy'); },
    });
    return facade;
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.pending);
    await this.adapter.settle();
  }
}
