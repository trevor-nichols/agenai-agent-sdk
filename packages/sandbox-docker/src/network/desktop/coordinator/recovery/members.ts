// ------------------------------------------------------------------------------------------------
//                members.ts - Original canonical inventory and cleanup-only recovered member owners
// ------------------------------------------------------------------------------------------------

import { SandboxStateError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { SandboxCleanupOwner, SandboxReconciliation, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../../../../policy/config.js';
import { inspectResource, resourceKind } from '../../../../resources/inspect.js';
import type { ResourceInspection } from '../../../../resources/inspect.js';
import { removeInspectedDockerResource } from '../../../../resources/removal.js';
import type { CoordinatorMember, ResourceRole } from '../journal/schema.js';
import type { DesktopCoordinatorCleanupJournal, DesktopCoordinatorRecoveryMembers } from './contracts.js';
import { validateCleanupRecord } from './identity.js';
import { assertCleanupAcquisition, DesktopCleanupLedger, identifiedCleanupRecord, originalCoordinatorMember, returnedResourceReference } from './ledger.js';

const producers: readonly ResourceRole[] = ['compute', 'egress_relay', 'egress_broker', 'filesystem', 'route_observer'];

function unresolvedCreate(member: CoordinatorMember, role: ResourceRole): boolean {
  const create = member.roles.find((entry) => entry.role === role)?.create;
  return create?.kind === 'pending' || create?.kind === 'uncertain';
}

class RecoveredMember implements SandboxCleanupOwner {
  private current: SandboxRecoveryRecord;
  private readonly ledger: DesktopCleanupLedger;
  private stopping: Promise<void> | undefined;
  private destroying: Promise<void> | undefined;
  private retired = false;
  private readonly acquired = new Map<ResourceRole, ResourceInspection>();

  constructor(private readonly journal: DesktopCoordinatorCleanupJournal, private readonly config: DockerSandboxConfig,
    record: SandboxRecoveryRecord) {
    this.current = record;
    this.ledger = new DesktopCleanupLedger(journal, record.operationId);
  }

  get recoveryRecord(): SandboxRecoveryRecord { return this.current; }

  get uncertain(): boolean {
    const member = this.ledger.member;
    return this.current.resources.some((resource) => resource.identity.kind === 'creating'
      && returnedResourceReference(member, resource.role) === undefined
      && unresolvedCreate(member, resource.role));
  }

  stop(): Promise<void> {
    if (this.retired) return Promise.resolve();
    this.stopping ??= this.journal.run(() => this.stopActual()).catch((cause: unknown) => { this.stopping = undefined; throw cause; });
    return this.stopping;
  }

  destroy(): Promise<void> {
    if (this.retired) return Promise.resolve();
    this.destroying ??= this.destroyActual().catch((cause: unknown) => { this.destroying = undefined; throw cause; });
    return this.destroying;
  }

  private enter(phase: 'stopping' | 'destroying'): void {
    this.current = parseSandboxRecoveryRecord({ ...this.current, phase,
      authority: { kind: 'verified', backendIdentity: this.journal.snapshot().daemonId } });
  }

  private async remove(role: ResourceRole): Promise<void> {
    const resource = this.current.resources.find((entry) => entry.role === role);
    if (!resource) return;
    await this.journal.assertAuthority();
    const reference = resource.identity.kind === 'identified' ? resource.identity.id
      : returnedResourceReference(this.ledger.member, role) ?? resource.name;
    const inspection = await inspectResource(this.journal.api, this.config, this.current, resource, reference);
    await this.journal.assertAuthority();
    let publicationFailure: unknown;
    if (inspection) {
      if (resource.identity.kind === 'planned') throw new SandboxStateError('Cleanup cannot adopt a resource that never received an original create arm.');
      assertCleanupAcquisition(this.ledger.member, role, inspection.id);
      this.current = identifiedCleanupRecord(this.current, resource, inspection);
      this.acquired.set(role, inspection);
      try {
        await this.ledger.present(role, this.current, inspection);
        await this.ledger.prepareDelete(role, this.current, inspection);
      } catch (cause) { publicationFailure = cause; }
      const acquired = this.current.resources.find((entry) => entry.role === role);
      if (!acquired) throw new SandboxStateError('Cleanup lost its acquired original role.');
      await this.journal.assertAuthority();
      try {
        await removeInspectedDockerResource(this.journal.api, role, inspection,
          () => inspectResource(this.journal.api, this.config, this.current, acquired, inspection.id));
      } catch (cause) {
        if (publicationFailure !== undefined) throw new AggregateError([publicationFailure, cause], 'Original cleanup and canonical publication did not both settle.');
        throw cause;
      }
      await this.journal.assertAuthority();
    } else {
      const original = this.acquired.get(role);
      if (original && this.ledger.member.roles.find((entry) => entry.role === role)?.presence.kind !== 'absent') {
        await this.ledger.present(role, this.current, original);
      }
    }
    if (publicationFailure !== undefined) throw publicationFailure;
    if (!await this.ledger.absent(role, this.current)) throw new SandboxStateError('An absent original creating name without a returned ID remains uncertain.');
    this.acquired.delete(role);
  }

  private async confirmRetirement(): Promise<boolean> {
    const settled = await this.ledger.confirmRetirement();
    if (!settled) return false;
    this.current = settled;
    this.retired = true;
    return true;
  }

  private async stopActual(): Promise<void> {
    await this.journal.assertAuthority();
    if (await this.confirmRetirement()) return;
    this.enter('stopping');
    const failures: unknown[] = [];
    try { await this.ledger.cancelQueued(); } catch (cause) { failures.push(cause); }
    for (const role of producers) {
      try { await this.remove(role); } catch (cause) { failures.push(cause); }
    }
    if (failures.length) throw new AggregateError(failures, 'Recovered stop retains original producer ownership.');
    const stopped = await this.ledger.terminal('stopped', this.current, true);
    this.current = parseSandboxRecoveryRecord({ ...this.current, phase: stopped.phase, authority: stopped.authority });
  }

  private async destroyActual(): Promise<void> {
    let stopFailure: unknown;
    try { await this.stop(); } catch (cause) { stopFailure = cause; }
    await this.journal.run(async () => {
      await this.journal.assertAuthority();
      if (await this.confirmRetirement()) return;
      this.enter('destroying');
      const failures: unknown[] = stopFailure === undefined ? [] : [stopFailure];
      try { await this.ledger.cancelQueued(); } catch (cause) { failures.push(cause); }
      for (const resource of this.current.resources.filter((entry) => resourceKind(entry.role) === 'container')) {
        try { await this.remove(resource.role); } catch (cause) { failures.push(cause); }
      }
      if (failures.length) throw new AggregateError(failures, 'Recovered destruction retains original container or late-create ownership.');
      for (const role of ['storage', 'egress_socket', 'network'] as const) {
        try { await this.remove(role); } catch (cause) { failures.push(cause); }
      }
      if (failures.length) throw new AggregateError(failures, 'Recovered destruction retains exact original resource ownership.');
      this.current = await this.ledger.terminal('destroyed', this.current, true);
      this.retired = true;
    });
  }
}

class RecoveryMembers implements DesktopCoordinatorRecoveryMembers {
  private readonly owners = new Map<string, RecoveredMember>();

  constructor(private readonly journal: DesktopCoordinatorCleanupJournal) {}

  get members(): readonly SandboxRecoveryRecord[] {
    const generation = this.journal.snapshot().generation;
    return Object.freeze(generation.kind === 'dirty' ? generation.members.map((member) => member.checkpoint.record) : []);
  }

  reconcile(config: DockerSandboxConfig, supplied: SandboxRecoveryRecord, signal?: AbortSignal): Promise<SandboxReconciliation> {
    return this.journal.run(async () => {
      signal?.throwIfAborted();
      await this.journal.assertAuthority(signal);
      const generation = this.journal.snapshot().generation;
      if (generation.kind !== 'dirty' || generation.state.kind !== 'cleanup_only') {
        throw new SandboxStateError('Fresh member recovery requires the original cleanup-only generation.');
      }
      let current = parseSandboxRecoveryRecord(supplied);
      let uncertain = false;
      try {
        const member = originalCoordinatorMember(this.journal, current.operationId);
        validateCleanupRecord(this.journal, config, member, current);
        const existing = this.owners.get(current.operationId);
        if (existing) return Object.freeze({ kind: existing.uncertain ? 'uncertain' as const : 'matched' as const, owner: existing });
        for (const resource of current.resources) {
          const reference = resource.identity.kind === 'identified' ? resource.identity.id
            : returnedResourceReference(member, resource.role) ?? resource.name;
          const inspection = await inspectResource(this.journal.api, config, current, resource, reference, signal);
          if (inspection) {
            if (resource.identity.kind === 'planned') throw new SandboxStateError('A planned original resource name is occupied.');
            assertCleanupAcquisition(member, resource.role, inspection.id);
            if (resource.identity.kind === 'creating') current = identifiedCleanupRecord(current, resource, inspection);
          } else if (resource.identity.kind === 'creating' && returnedResourceReference(member, resource.role) === undefined
            && unresolvedCreate(member, resource.role)) uncertain = true;
        }
        await this.journal.assertAuthority(signal);
      } catch (cause) {
        if (!(cause instanceof SandboxStateError)) throw cause;
        return Object.freeze({ kind: 'conflict' as const, reason: cause.message.slice(0, 1024) });
      }
      const owner = new RecoveredMember(this.journal, config, current);
      this.owners.set(current.operationId, owner);
      return Object.freeze({ kind: uncertain ? 'uncertain' as const : 'matched' as const, owner });
    });
  }
}

export function createDesktopCoordinatorRecoveryMembers(journal: DesktopCoordinatorCleanupJournal): DesktopCoordinatorRecoveryMembers {
  return new RecoveryMembers(journal);
}
