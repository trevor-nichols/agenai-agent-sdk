// ------------------------------------------------------------------------------------------------
//                original.ts - Fenced original-owner cleanup without live topology readmission
// ------------------------------------------------------------------------------------------------

import { SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { inspectResource } from '../../../../resources/inspect.js';
import type { DesktopCoordinatorControlledRole, DesktopCoordinatorMemberJournal, DesktopCoordinatorMemberOwner } from '../member.js';
import type { ResourceRole } from '../journal/schema.js';
import { assertCleanupAcquisition, DesktopCleanupLedger, identifiedCleanupRecord, returnedResourceReference } from './ledger.js';

export class DesktopCoordinatorOriginalCleanup {
  private readonly ledger: DesktopCleanupLedger;

  constructor(private readonly journal: DesktopCoordinatorMemberJournal, private readonly owner: DesktopCoordinatorMemberOwner,
    private readonly maySettle: () => boolean) {
    this.ledger = new DesktopCleanupLedger({ api: owner.api, snapshot: () => journal.snapshot(),
      apply: (event, boundary) => journal.apply(event, boundary), assertAuthority: (signal) => journal.assertAuthority('cleanup', signal),
      run: (perform) => perform() }, journal.memberId);
  }

  private async inspect(role: ResourceRole) {
    await this.journal.assertAuthority('cleanup');
    const record = this.owner.record();
    const resource = record.resources.find((entry) => entry.role === role);
    if (!resource) throw new SandboxStateError('Original cleanup lost its reserved resource role.');
    const reference = resource.identity.kind === 'identified' ? resource.identity.id
      : returnedResourceReference(this.ledger.member, role) ?? resource.name;
    const inspection = await inspectResource(this.owner.api, this.owner.config, record, resource, reference);
    await this.journal.assertAuthority('cleanup');
    return { record, resource, inspection };
  }

  async controlClose(role: DesktopCoordinatorControlledRole, close: () => Promise<unknown>): Promise<void> {
    await this.journal.assertAuthority('cleanup');
    let publicationFailure: unknown;
    if (this.maySettle()) {
      try { await this.ledger.cancelQueued(); }
      catch (cause) { publicationFailure = cause; }
    }
    await close();
    const { record, inspection } = await this.inspect(role);
    if (publicationFailure !== undefined) throw publicationFailure;
    if (inspection && this.maySettle()) await this.ledger.joinedControl(role, record, inspection);
  }

  async remove(role: ResourceRole): Promise<void> {
    const { record, resource, inspection } = await this.inspect(role);
    let current = record;
    let publicationFailure: unknown;
    if (this.maySettle()) {
      try { await this.ledger.cancelQueued(); }
      catch (cause) { publicationFailure = cause; }
    }
    if (inspection) {
      if (resource.identity.kind === 'planned') throw new SandboxStateError('Original cleanup cannot adopt a never-armed resource.');
      assertCleanupAcquisition(this.ledger.member, role, inspection.id);
      current = identifiedCleanupRecord(record, resource, inspection);
      this.owner.retain(current);
      if (this.maySettle() && publicationFailure === undefined) {
        try {
          await this.ledger.present(role, current, inspection);
          await this.ledger.prepareDelete(role, current, inspection);
        }
        catch (cause) { publicationFailure = cause; }
      }
      await this.owner.remove(role);
      await this.journal.assertAuthority('cleanup');
    }
    if (publicationFailure !== undefined) throw publicationFailure;
    if (!this.maySettle()) return;
    if (!await this.ledger.absent(role, current)) throw new SandboxStateError('Original creating ownership remains uncertain without a returned ID or acquired readback.');
  }

  async stopped(record: SandboxRecoveryRecord): Promise<void> {
    await this.ledger.cancelQueued();
    for (const role of ['compute', 'egress_relay', 'egress_broker', 'filesystem', 'route_observer'] as const) {
      if (!record.resources.some((entry) => entry.role === role)) continue;
      const observed = await this.inspect(role);
      if (observed.inspection) throw new SandboxStateError('Fenced stop retains an original producer.');
      if (!await this.ledger.absent(role, this.owner.record())) throw new SandboxStateError('Fenced stop retains an unknown original create.');
    }
    await this.ledger.terminal('stopped', this.owner.record(), false);
  }

  async retire(record: SandboxRecoveryRecord): Promise<void> {
    await this.journal.assertAuthority('cleanup');
    if (await this.ledger.confirmRetirement()) return;
    await this.ledger.cancelQueued();
    for (const resource of record.resources) {
      const observed = await this.inspect(resource.role);
      if (observed.inspection || !await this.ledger.absent(resource.role, this.owner.record())) {
        throw new SandboxStateError('Original member retirement retains a resource or unknown create.');
      }
    }
    await this.ledger.terminal('destroyed', this.owner.record(), false);
  }

  retainRetirement(record: SandboxRecoveryRecord): void { this.ledger.retainRetirement(record); }
}
