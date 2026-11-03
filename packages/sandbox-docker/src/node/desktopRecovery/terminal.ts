import { coordinatorDigest, encodeCoordinatorSnapshot } from '../../network/desktop/coordinator/journal/schema.js';
import type { CoordinatorMember } from '../../network/desktop/coordinator/journal/schema.js';
import { validateRecoveryEvidence } from '../../network/desktop/coordinator/administrativeRecovery/evidence.js';
import type { RecoveryEvidenceGraph } from '../../network/desktop/coordinator/administrativeRecovery/evidence.js';
import { createFinalInventoryDecision, createGenerationTerminalDecision } from '../../network/desktop/coordinator/administrativeRecovery/decisions.js';
import { planCleanHandback, planFinalInventory, resourceCompletionAnchor, transitionRecovery } from '../../network/desktop/coordinator/administrativeRecovery/plans.js';
import type { RecoveryPublicationOwner } from '../../network/desktop/coordinator/administrativeRecovery/publication.js';
import { finalInventoryRefSchema, sameReceipt, terminalArchiveRefSchema } from '../../network/desktop/coordinator/administrativeRecovery/receipts.js';
import { encodeRecoveryEnvelope, isRecoveryEnvelope, parseRecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import type { RecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import { rawDigest, RecoveryJournalError } from '../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { encodeSdkDecision, terminalDecisionMember } from '../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import type { InventoryAbsence, MemberTerminalDecision } from '../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { originalRecoverySnapshot } from '../../network/desktop/coordinator/administrativeRecovery/validation.js';
import { inspectPath } from '../../resources/inspect.js';
import type { SandboxRecoveryRecord, SandboxRecoveryResource } from '@agen-ai/sandbox';
import { sameTransport, transportAdmission } from './authority.js';
import type { RecoveryAuthority } from './authority.js';
import type { RecoveryEvidence } from './evidence.js';
import type { DockerDesktopRecoveryHelper } from './contracts.js';

function invalid(message: string): never { throw new RecoveryJournalError('evidence', message); }

function knownReference(member: CoordinatorMember, resource: SandboxRecoveryResource): string | undefined {
  const role = member.roles.find((entry) => entry.role === resource.role);
  if (role === undefined) return invalid('An original terminal resource is missing its role ledger.');
  const presence = role.presence;
  if (presence.kind === 'possibly_present') return presence.returnedId ?? undefined;
  if (presence.kind === 'present') return presence.id;
  if (presence.kind === 'absent') return presence.reference;
  return undefined;
}

/** Final resource inspection and the fixed, offline terminal-to-clean storage bridge. */
export class RecoveryTerminal {
  private verifiedRecords: readonly SandboxRecoveryRecord[] = Object.freeze([]);

  constructor(private readonly authority: RecoveryAuthority, private readonly evidence: RecoveryEvidence,
    private readonly publication: RecoveryPublicationOwner, private readonly expectedPreviousHelper?: DockerDesktopRecoveryHelper) {}

  get records(): readonly SandboxRecoveryRecord[] { return this.verifiedRecords; }

  async discoverAndCompleteIfResourceComplete(): Promise<boolean> {
    await this.publication.settle();
    const current = this.publication.current;
    if (!isRecoveryEnvelope(current)) {
      if (current.generation.kind !== 'clean') return false;
      await this.completeCleanSuccessor();
      return true;
    }
    await this.assertOriginal(current);
    const graph = await validateRecoveryEvidence(current, this.evidence);
    this.verifiedRecords = graph.records;
    if (current.phase.kind !== 'terminal_ready') {
      if (graph.finalInventory === null) return false;
      await this.publication.publish(planFinalInventory(current, graph.finalInventory.decision, graph.finalInventory.ref));
    }
    await this.completeTerminal();
    return true;
  }

  async finish(): Promise<void> {
    if (await this.discoverAndCompleteIfResourceComplete()) return;
    let envelope = this.envelope();
    resourceCompletionAnchor(envelope);
    const before = await this.authority.capture();
    const admission = transportAdmission(before, envelope.sequence + 1);
    if (!sameTransport(envelope.transport, admission)) {
      await this.publication.publish(transitionRecovery(envelope, { kind: 'refresh_transport', transport: admission }));
      envelope = this.envelope();
    }
    const graph = await validateRecoveryEvidence(envelope, this.evidence);
    this.verifiedRecords = graph.records;
    const resources = await this.inspectFinalInventory(envelope, graph);
    const after = await this.authority.capture();
    if (!sameTransport(transportAdmission(before, envelope.sequence), transportAdmission(after, envelope.sequence))) {
      return invalid('Final inventory lost its exact native, Engine or endpoint bracket.');
    }
    const decision = createFinalInventoryDecision(envelope, resources);
    const published = await this.authority.native.publishSdkDecision(decision);
    if (published.kind !== 'sdk' || published.decision.kind !== 'final_inventory') return invalid('Final inventory publication returned a foreign SDK record.');
    const ref = finalInventoryRefSchema.parse(published.ref);
    // Discovery verifies the actual complete decision graph before the irreversible T commit.
    const discovered = await validateRecoveryEvidence(envelope, this.evidence);
    if (discovered.finalInventory === null || !sameReceipt(discovered.finalInventory.ref, ref)) {
      return invalid('Published final inventory cannot be joined through its fixed deterministic slot.');
    }
    await this.publication.publish(planFinalInventory(envelope, discovered.finalInventory.decision, ref));
    await this.completeTerminal();
  }

  private envelope(): RecoveryEnvelope {
    const state = this.publication.current;
    if (!isRecoveryEnvelope(state)) return invalid('Terminal recovery requires the held original envelope.');
    return state;
  }

  private async assertOriginal(envelope: RecoveryEnvelope): Promise<void> {
    this.authority.assertPreparation(envelope);
    if (this.expectedPreviousHelper) this.authority.assertExpectedPredecessor(envelope, this.expectedPreviousHelper);
    await this.authority.assertOriginal(originalRecoverySnapshot(envelope), envelope.origin.generationId);
    const archived = await this.authority.native.readReceipt({ kind: 'origin_archive', scope: 'generation' }, envelope.origin.archive);
    if (archived?.kind !== 'archive' || archived.text !== Buffer.from(envelope.origin.payloadBase64, 'base64').toString('utf8')) {
      return invalid('Terminal recovery does not retain the exact original native archive.');
    }
  }

  private async completeTerminal(): Promise<void> {
    const envelope = this.envelope();
    if (envelope.phase.kind !== 'terminal_ready') return invalid('Offline handback requires irreversible resource completion.');
    await this.assertOriginal(envelope);
    const graph = await validateRecoveryEvidence(envelope, this.evidence);
    if (graph.finalInventory === null) return invalid('Terminal recovery is missing its fully settled final inventory.');
    await this.publication.reconcile();
    const archived = await this.authority.native.archiveCurrentCanonical('terminal_archive', this.publication.digest);
    if (archived.kind !== 'archive' || archived.text !== this.publication.text
      || archived.text !== encodeRecoveryEnvelope(envelope)) return invalid('Terminal archive differs from the exact held T bytes.');
    const ref = terminalArchiveRefSchema.parse(archived.ref);
    const manifest = createGenerationTerminalDecision(envelope, ref);
    const published = await this.authority.native.publishSdkDecision(manifest);
    if (published.kind !== 'sdk' || published.decision.kind !== 'generation_terminal'
      || published.text !== encodeSdkDecision(manifest)) return invalid('Generation manifest does not name the exact planned clean successor.');
    const sealed = await validateRecoveryEvidence(envelope, this.evidence);
    if (sealed.terminal === null || !sameReceipt(sealed.terminal.ref, published.ref)) {
      return invalid('Generation terminal publication is not discoverable under the held original claim.');
    }
    const clean = planCleanHandback(envelope);
    if (encodeCoordinatorSnapshot(clean) !== manifest.cleanText) return invalid('Clean handback differs from its immutable terminal manifest.');
    await this.publication.publish(clean);
    await this.publication.settle();
  }

  private async completeCleanSuccessor(): Promise<void> {
    const archive = await this.authority.native.readReceipt({ kind: 'terminal_archive', scope: 'generation' });
    if (archive?.kind !== 'archive') return invalid('A bound clean recovery successor is missing its terminal archive.');
    const terminal = parseRecoveryEnvelope(archive.text);
    if (terminal.phase.kind !== 'terminal_ready') return invalid('A clean successor references a nonterminal recovery archive.');
    await this.assertOriginal(terminal);
    const graph = await validateRecoveryEvidence(terminal, this.evidence);
    this.verifiedRecords = graph.records;
    if (graph.terminal === null || !sameReceipt(graph.terminal.decision.terminal, archive.ref)) {
      return invalid('A clean successor is missing its exact original generation manifest.');
    }
    const expected = createGenerationTerminalDecision(terminal, terminalArchiveRefSchema.parse(archive.ref));
    if (encodeSdkDecision(expected) !== encodeSdkDecision(graph.terminal.decision)
      || expected.cleanText !== this.publication.text || expected.cleanRawDigest !== rawDigest(this.publication.text)) {
      return invalid('Held clean bytes do not match the one immutable planned recovery successor.');
    }
    const clean = this.publication.current;
    if (clean.format !== 'agenai.docker-desktop-coordinator.v1' || clean.generation.kind !== 'clean') {
      return invalid('Clean successor completion no longer holds the exact clean canonical state.');
    }
    await this.authority.assertOriginal(clean, terminal.origin.generationId);
    await this.publication.reconcile();
    await this.publication.settle();
  }

  private async inspectFinalInventory(envelope: RecoveryEnvelope, graph: RecoveryEvidenceGraph): Promise<InventoryAbsence[]> {
    const original = originalRecoverySnapshot(envelope);
    if (original.generation.kind !== 'dirty') return invalid('Final inventory lost the original dirty generation.');
    const rows: InventoryAbsence[] = [];
    for (const member of original.generation.members) {
      const terminal = graph.terminalMembers.find((entry) => entry.memberId === member.memberId);
      if (terminal === undefined) return invalid('Final inventory requires every original member terminal manifest.');
      rows.push(...await this.inspectTerminalMember(member, terminal));
    }
    return rows;
  }

  private async inspectTerminalMember(original: CoordinatorMember, decision: MemberTerminalDecision): Promise<InventoryAbsence[]> {
    const terminal = terminalDecisionMember(decision);
    const rows: InventoryAbsence[] = [];
    for (const resource of decision.record.resources) {
      const prior = original.checkpoint.record.resources.find((entry) => entry.role === resource.role);
      if (prior === undefined || prior.name !== resource.name) return invalid('Final inventory replaces an original role or reserved name.');
      const reference = resource.identity.kind === 'identified' ? resource.identity.id : knownReference(terminal, resource) ?? resource.name;
      const references = new Set([resource.name, reference]);
      for (const entry of [prior, resource]) if (entry.identity.kind === 'identified') references.add(entry.identity.id);
      for (const member of [original, terminal]) {
        const known = knownReference(member, resource);
        if (known !== undefined) references.add(known);
      }
      const observations: Array<Readonly<{ reference: string; path: string; status: 404 }>> = [];
      for (const candidate of [...references].sort()) {
        await this.authority.native.checkClaim();
        const path = inspectPath(resource, candidate);
        const response = await this.authority.api.request('GET', path, { statuses: [404] });
        if (response.statusCode !== 404) return invalid('An original resource name or real ID is still occupied.');
        observations.push({ reference: candidate, path, status: 404 });
      }
      rows.push({ memberId: original.memberId, role: resource.role, name: resource.name, reference,
        fingerprint: resource.identity.kind === 'identified' ? resource.identity.fingerprint : null, outcome: 'absent',
        inspectionDigest: coordinatorDigest('agenai.desktop-recovery.final-resource-inspection.v1', JSON.stringify({
          memberId: original.memberId, role: resource.role, observations })) });
    }
    return rows;
  }
}
