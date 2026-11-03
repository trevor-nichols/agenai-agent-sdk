import { Buffer } from 'node:buffer';
import { resourceKind } from '../../../../resources/inspect.js';
import { coordinatorDigest, encodeCoordinatorSnapshot, parseCoordinatorSnapshot, recoveryRecordDigest, snapshotDigest } from '../journal/schema.js';
import type { CoordinatorSnapshot, ResourceRole } from '../journal/schema.js';
import { planCoordinatorTransition } from '../journal/plans.js';
import type { CoordinatorEvent } from '../journal/plans.js';
import { RECOVERY_JOURNAL_LIMITS, encodeRecoveryEnvelope, noIdAbsenceDigest, noIdAbsenceSchema, parseRecoveryEnvelope, recoveryEnvelopeDigest, wireRecoveryEnvelope } from './schema.js';
import type { MemberTerminal, NoIdAbsence, RecoveryEnvelope, RecoveryPhase } from './schema.js';
import type { AcceptedBarrierDecisionRef, AttemptTerminalRef, FinalInventoryDecisionRef, NativeAttemptRef, OriginArchiveRef } from './receipts.js';
import { sameReceipt } from './receipts.js';
import type { CurrentTransportAdmission, OriginalRecoveryHelper, RecoveryClaim, RecoveryHelper } from './scalars.js';
import { rawDigest, RecoveryJournalError, requireByteBound } from './scalars.js';
import { assertSupportedRecoveryOrigin, originalFrameDigest, originalRecoverySnapshot, recoveryKeyFor } from './validation.js';
import { assertDecisionBinding, sdkDecisionReceipt } from './sdkDecisions.js';
import type { BarrierAcceptanceDecision, FinalInventoryDecision } from './sdkDecisions.js';
import { activeRecoveryHelper, FIRST_SUCCESSOR_PROFILE, FIRST_SUCCESSOR_SOURCE, PREVIOUS_RECOVERY_PROFILE, PREVIOUS_RECOVERY_SOURCE } from './helperSuccession.js';

export interface RecoveryConversionBinding {
  readonly claim: RecoveryClaim;
  readonly archive: OriginArchiveRef;
  readonly preparation: Readonly<{ configuredEndpoint: string; sharedDigest: string;
    originalHelper: OriginalRecoveryHelper; recoveryHelper: RecoveryHelper }>;
  readonly transport: CurrentTransportAdmission;
}
function rejected(message: string): never { throw new RecoveryJournalError('transition', message); }
function normalize(snapshot: CoordinatorSnapshot): CoordinatorSnapshot {
  const planned = planCoordinatorTransition(snapshot, { kind: 'reopen_cleanup' });
  if (planned.kind === 'rejected') return rejected(planned.reason);
  return planned.snapshot;
}
function nextSequence(envelope: RecoveryEnvelope): number {
  const next = envelope.sequence + 1;
  if (!Number.isSafeInteger(next)) throw new RecoveryJournalError('capacity', 'Recovery snapshot sequence is exhausted.');
  return next;
}
function rebaseProjection(snapshot: CoordinatorSnapshot, atSequence: number): CoordinatorSnapshot {
  if (snapshot.sequence === atSequence) return snapshot;
  if (snapshot.sequence + 1 !== atSequence) return rejected('A cleanup projection must advance exactly once.');
  return parseCoordinatorSnapshot(encodeCoordinatorSnapshot({ ...snapshot, sequence: atSequence, previousDigest: snapshotDigest(snapshot) }));
}
function commit(envelope: RecoveryEnvelope, changes: Partial<Pick<RecoveryEnvelope,
  'phase' | 'transport' | 'historyHead' | 'nextAttempt' | 'release' | 'noIdAbsences' | 'memberTerminals'>>,
  projection = envelope.projection.snapshot): RecoveryEnvelope {
  if (envelope.phase.kind === 'terminal_ready') return rejected('Resource-complete recovery cannot re-enter a mutable phase.');
  const atSequence = nextSequence(envelope);
  const digest = recoveryEnvelopeDigest(envelope);
  const continued: RecoveryEnvelope = envelope.format === 'agenai.docker-desktop-recovery.v1'
    ? { ...envelope, predecessor: { format: 'recovery-v1', digest } }
    : envelope.format === 'agenai.docker-desktop-recovery.v2' ? { ...envelope, predecessor: { format: 'recovery-v2', digest } }
      : { ...envelope, predecessor: { format: 'recovery-v3', digest } };
  return parseRecoveryEnvelope(JSON.stringify(wireRecoveryEnvelope({ ...continued, ...changes,
    sequence: atSequence,
    projection: { ...envelope.projection, snapshot: rebaseProjection(projection, atSequence) } })));
}
export function planHelperReplacement(envelope: RecoveryEnvelope, expected: RecoveryHelper,
  helper: RecoveryHelper, profileDigest: string): RecoveryEnvelope {
  const generation = envelope.projection.snapshot.generation;
  if (envelope.format === 'agenai.docker-desktop-recovery.v3'
    || JSON.stringify(expected) !== JSON.stringify(activeRecoveryHelper(envelope))
    || helper.sourceDigest === PREVIOUS_RECOVERY_SOURCE
    || profileDigest === PREVIOUS_RECOVERY_PROFILE || envelope.phase.kind !== 'attempt_closed'
    || envelope.phase.terminal.slot !== 'outcome' || envelope.release.kind !== 'requested'
    || envelope.phase.ordinal !== envelope.nextAttempt - 1 || !envelope.historyHead || !sameReceipt(envelope.historyHead, envelope.phase.terminal)
    || generation.kind !== 'dirty' || generation.members.length === 0 || generation.queue.length || generation.entered !== null
    || generation.members.some((member) => Object.values(member.work).some((scope) => scope.kind === 'owned'))
    || envelope.noIdAbsences.length || envelope.memberTerminals.length) return rejected('Only the exact released supported predecessor may adopt its current helper successor.');
  const sequence = nextSequence(envelope);
  if (envelope.format === 'agenai.docker-desktop-recovery.v2') {
    if (expected.sourceDigest !== FIRST_SUCCESSOR_SOURCE || envelope.activeProfileDigest !== FIRST_SUCCESSOR_PROFILE
      || helper.sourceDigest === FIRST_SUCCESSOR_SOURCE || envelope.previousIssuer.throughAttempt >= envelope.nextAttempt - 1) {
      return rejected('Second helper succession requires the exact reviewed first successor and a nonempty closed issuer interval.');
    }
    const { previousIssuer, ...previous } = envelope;
    return parseRecoveryEnvelope(JSON.stringify(wireRecoveryEnvelope({ ...previous, format: 'agenai.docker-desktop-recovery.v3',
      sequence, predecessor: { format: 'recovery-v2', digest: recoveryEnvelopeDigest(envelope) },
      projection: { ...envelope.projection, snapshot: rebaseProjection(envelope.projection.snapshot, sequence) },
      activeHelper: helper, activeProfileDigest: profileDigest,
      previousIssuers: [
        { kind: 'original', ...previousIssuer },
        { kind: 'first_successor', throughAttempt: envelope.nextAttempt - 1, helper: envelope.activeHelper, profileDigest: FIRST_SUCCESSOR_PROFILE },
      ] })));
  }
  if (expected.sourceDigest !== PREVIOUS_RECOVERY_SOURCE) return rejected('First helper succession requires its exact reviewed original source.');
  return parseRecoveryEnvelope(JSON.stringify(wireRecoveryEnvelope({ ...envelope, format: 'agenai.docker-desktop-recovery.v2',
    sequence, predecessor: { format: 'recovery-v1', digest: recoveryEnvelopeDigest(envelope) },
    projection: { ...envelope.projection, snapshot: rebaseProjection(envelope.projection.snapshot, sequence) },
    activeHelper: helper, activeProfileDigest: profileDigest,
    previousIssuer: { throughAttempt: envelope.nextAttempt - 1, profileDigest: PREVIOUS_RECOVERY_PROFILE } })));
}
export function createRecoveryEnvelope(originalText: string, binding: RecoveryConversionBinding): RecoveryEnvelope {
  const original = parseCoordinatorSnapshot(originalText);
  assertSupportedRecoveryOrigin(original);
  if (original.generation.kind !== 'dirty') return rejected('Only an original dirty generation can enter recovery.');
  if (Buffer.byteLength(originalText) > RECOVERY_JOURNAL_LIMITS.originalBytes
    || original.sequence > Number.MAX_SAFE_INTEGER - RECOVERY_JOURNAL_LIMITS.sequenceAdmissionReserve
    || original.generation.nextEffectSequence > Number.MAX_SAFE_INTEGER - 36) {
    throw new RecoveryJournalError('capacity', 'Original recovery lacks its bounded cleanup reserve.');
  }
  const projected = rebaseProjection(normalize(original), original.sequence + 1);
  if (Buffer.byteLength(encodeCoordinatorSnapshot(projected)) + 36 * RECOVERY_JOURNAL_LIMITS.roleGrowthBytes
    + 4 * RECOVERY_JOURNAL_LIMITS.memberGrowthBytes + RECOVERY_JOURNAL_LIMITS.rootGrowthBytes > RECOVERY_JOURNAL_LIMITS.projectionBytes) {
    throw new RecoveryJournalError('capacity', 'Original recovery cannot reserve every cleanup continuation.');
  }
  const claimDigest = coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(binding.claim));
  return parseRecoveryEnvelope(JSON.stringify(wireRecoveryEnvelope({ format: 'agenai.docker-desktop-recovery.v1',
    recoveryKey: recoveryKeyFor(original, rawDigest(originalText), claimDigest), authorityId: original.authorityId,
    engineKey: original.engineKey, daemonId: original.daemonId, sequence: original.sequence + 1,
    predecessor: { format: 'coordinator-v1', digest: snapshotDigest(original) }, origin: {
      payloadBase64: Buffer.from(originalText).toString('base64'), payloadBytes: Buffer.byteLength(originalText),
      rawDigest: rawDigest(originalText), snapshotDigest: snapshotDigest(original), framedDigest: originalFrameDigest(originalText, original),
      sequence: original.sequence, generationId: original.generation.identity.generationId,
      generationOrdinal: original.generation.identity.ordinal, claim: binding.claim, archive: binding.archive },
    preparation: binding.preparation, transport: { ...binding.transport, admittedAtSequence: original.sequence + 1 },
    projection: { format: 'agenai.desktop-recovery.cleanup-projection.v1', snapshot: projected }, noIdAbsences: [], memberTerminals: [],
    nextAttempt: 1, historyHead: null, phase: { kind: 'prepared' }, release: { kind: 'none' } })));
}
export type RecoveryEvent =
  | Readonly<{ kind: 'refresh_transport'; transport: CurrentTransportAdmission }>
  | Readonly<{ kind: 'prepare_attempt' }>
  | Readonly<{ kind: 'armed'; preparedRawDigest: string; armed: NativeAttemptRef }>
  | Readonly<{ kind: 'stopped'; stopped: NativeAttemptRef }>
  | Readonly<{ kind: 'accept_barrier'; decision: BarrierAcceptanceDecision; receipt: AcceptedBarrierDecisionRef }>
  | Readonly<{ kind: 'close_attempt'; terminal: AttemptTerminalRef }>
  | Readonly<{ kind: 'request_release' }>
  | Readonly<{ kind: 'clear_release' }>;
function observing(phase: RecoveryPhase): boolean { return phase.kind === 'attempt_prepared' || phase.kind === 'armed' || phase.kind === 'stopped'; }
export function transitionRecovery(envelope: RecoveryEnvelope, event: RecoveryEvent): RecoveryEnvelope {
  if (envelope.phase.kind === 'terminal_ready') {
    if (event.kind === 'request_release' || event.kind === 'clear_release') return envelope;
    return rejected('Terminal recovery only permits its exact offline handback.');
  }
  if (event.kind === 'refresh_transport') {
    if (observing(envelope.phase)) return rejected('An active observation owns its transport until it settles.');
    const unchanged = event.transport.endpointDigest === envelope.transport.endpointDigest
      && event.transport.engineFactsDigest === envelope.transport.engineFactsDigest && event.transport.nativeFactsDigest === envelope.transport.nativeFactsDigest;
    if (unchanged) return envelope.phase.kind === 'attempt_closed'
      ? commit(envelope, { phase: { kind: 'prepared' } }) : envelope;
    return commit(envelope, { transport: { ...event.transport, admittedAtSequence: nextSequence(envelope) },
      ...(envelope.phase.kind === 'cleanup' ? { historyHead: envelope.phase.barrier, phase: { kind: 'prepared' } }
        : envelope.phase.kind === 'attempt_closed' ? { phase: { kind: 'prepared' } } : {}) });
  }
  if (event.kind === 'prepare_attempt') {
    const projection = envelope.projection.snapshot.generation;
    if (envelope.phase.kind !== 'prepared' && envelope.phase.kind !== 'cleanup'
      || projection.kind !== 'dirty' || projection.members.length === 0 || projection.entered !== null || projection.queue.length !== 0) return rejected('Observation requires renewed admission and joined original cleanup ownership.');
    if (envelope.sequence > Number.MAX_SAFE_INTEGER - RECOVERY_JOURNAL_LIMITS.cleanupSequenceReserve - RECOVERY_JOURNAL_LIMITS.attemptSequenceReserve
      || envelope.nextAttempt === Number.MAX_SAFE_INTEGER) throw new RecoveryJournalError('capacity', 'Observation must preserve cleanup and attempt capacity.');
    return commit(envelope, { phase: { kind: 'attempt_prepared', ordinal: envelope.nextAttempt }, nextAttempt: envelope.nextAttempt + 1,
      ...(envelope.phase.kind === 'cleanup' ? { historyHead: envelope.phase.barrier } : {}) });
  }
  if (event.kind === 'armed') {
    if (envelope.phase.kind !== 'attempt_prepared' || event.armed.slot !== 'armed' || event.armed.attempt !== envelope.phase.ordinal) return rejected('Only the exact prepared attempt can arm.');
    if (event.preparedRawDigest !== rawDigest(encodeRecoveryEnvelope(envelope))) return rejected('Native arming does not bind its exact prepared canonical bytes.');
    return commit(envelope, { phase: { kind: 'armed', ordinal: envelope.phase.ordinal, preparedRawDigest: event.preparedRawDigest, armed: event.armed } });
  }
  if (event.kind === 'stopped') {
    if (envelope.phase.kind !== 'armed' || event.stopped.slot !== 'stopped' || event.stopped.attempt !== envelope.phase.ordinal) return rejected('Only the original armed observation can establish a stopped interval.');
    return commit(envelope, { phase: { ...envelope.phase, kind: 'stopped', stopped: event.stopped } });
  }
  if (event.kind === 'accept_barrier') {
    const phase = envelope.phase;
    if (phase.kind !== 'stopped') return rejected('Accepted restoration requires the original stopped observation.');
    assertDecisionBinding(envelope, event.decision);
    if (event.decision.attempt !== phase.ordinal || event.decision.preparedRawDigest !== phase.preparedRawDigest
      || !sameReceipt(event.decision.native.armed, phase.armed) || !sameReceipt(event.decision.native.stopped, phase.stopped)
      || JSON.stringify(event.decision.previousHistory) !== JSON.stringify(envelope.historyHead)
      || event.decision.transport.admittedAtSequence !== nextSequence(envelope)
      || !sameReceipt(sdkDecisionReceipt(event.decision), event.receipt)) return rejected('Accepted restoration replaces the original attempt or its exact receipt.');
    return commit(envelope, { transport: { ...event.decision.transport, admittedAtSequence: nextSequence(envelope) },
      phase: { kind: 'cleanup', barrier: event.receipt, acceptedAtSequence: nextSequence(envelope) } });
  }
  if (event.kind === 'close_attempt') {
    if (!('ordinal' in envelope.phase) || event.terminal.attempt !== envelope.phase.ordinal) return rejected('No exact active attempt can close.');
    if (envelope.historyHead && event.terminal.attempt <= envelope.historyHead.attempt) return rejected('Closed attempt cannot replace older immutable history.');
    return commit(envelope, { historyHead: event.terminal, phase: { kind: 'attempt_closed', ordinal: event.terminal.attempt, terminal: event.terminal } });
  }
  if (event.kind === 'request_release') {
    if (observing(envelope.phase)) return rejected('Passive observation must join before retained release.');
    if (envelope.release.kind === 'requested') return envelope;
    return commit(envelope, { release: { kind: 'requested', atSequence: nextSequence(envelope) } });
  }
  if (event.kind === 'clear_release') return envelope.release.kind === 'none' ? envelope : commit(envelope, { release: { kind: 'none' } });
  const exhaustive: never = event;
  return exhaustive;
}
export function planCleanupTransition(envelope: RecoveryEnvelope, event: CoordinatorEvent, terminal?: MemberTerminal): RecoveryEnvelope {
  if (observing(envelope.phase)) return rejected('Cleanup cannot race an active Desktop observation.');
  if (event.kind === 'register' || event.kind === 'work_enter' || event.kind === 'full_basis' || event.kind === 'quiesce'
    || event.kind === 'queue' && event.action !== 'delete' || event.kind === 'clean_close' || event.kind === 'reopen_cleanup'
    || event.kind === 'returned' || event.kind === 'member_state' && (event.state.kind === 'active' || event.state.kind === 'starting' || event.state.kind === 'reserved')) return rejected('Administrative recovery does not grant live execution.');
  if (event.kind === 'checkpoint' && event.mode !== 'canonical_cleanup'
    || event.kind === 'settle' && event.outcome === 'not_dispatched') return rejected('Fresh administrative cleanup cannot invent caller or non-dispatch authority.');
  if (event.kind === 'arm') {
    const generation = envelope.projection.snapshot.generation;
    if (generation.kind !== 'dirty' || !generation.queue.some((entry) => entry.effectSequence === event.effectSequence && entry.action === 'delete')) return rejected('Administrative cleanup can arm only an original exact delete.');
  }
  const plan = planCoordinatorTransition(envelope.projection.snapshot, event);
  if (plan.kind === 'rejected') return rejected(plan.reason);
  if (snapshotDigest(plan.snapshot) === snapshotDigest(envelope.projection.snapshot)) return envelope;
  let memberTerminals = envelope.memberTerminals;
  if (event.kind === 'retire') {
    if (!terminal || terminal.memberId !== event.memberId || terminal.checkpointDigest !== recoveryRecordDigest(event.record)) return rejected('Retirement requires its durably published exact original manifest.');
    memberTerminals = [...memberTerminals, terminal].sort((left, right) => left.memberSequence - right.memberSequence);
  }
  return commit(envelope, { memberTerminals }, plan.snapshot);
}
export function planNameAbsence(envelope: RecoveryEnvelope, input: Readonly<{ memberId: string; role: ResourceRole;
  inspectionDigest: string; barrier: AcceptedBarrierDecisionRef }>): RecoveryEnvelope {
  if (resourceKind(input.role) !== 'container' || envelope.phase.kind !== 'cleanup' || !sameReceipt(envelope.phase.barrier, input.barrier)) return rejected('Name absence requires the current accepted original barrier.');
  const generation = envelope.projection.snapshot.generation;
  if (generation.kind !== 'dirty') return rejected('Name absence requires the original cleanup-only generation.');
  const member = generation.members.find((entry) => entry.memberId === input.memberId);
  const ledger = member?.roles.find((entry) => entry.role === input.role);
  const resource = member?.checkpoint.record.resources.find((entry) => entry.role === input.role);
  if (!member || !ledger || !resource || resource.identity.kind !== 'creating' || ledger.create.kind !== 'uncertain'
    || ledger.presence.kind !== 'possibly_present' || ledger.presence.returnedId !== null
    || generation.entered?.memberId === member.memberId && generation.entered.role === input.role) return rejected('No exact original unresolved creating role can settle by name.');
  const row = noIdRow(input, ledger.create.effect, member.checkpoint.digest, nextSequence(envelope));
  requireByteBound(row, RECOVERY_JOURNAL_LIMITS.noIdRowBytes, 'No-ID settlement');
  const createEffect = ledger.create.effect;
  const acceptedAtSequence = envelope.phase.acceptedAtSequence;
  const changed = { ...member, projection: { kind: 'none' as const }, roles: member.roles.map((entry) => entry.role !== input.role ? entry : {
    ...entry, create: { kind: 'settled' as const, effect: createEffect,
      outcome: 'absent' as const, receiptDigest: noIdAbsenceDigest(row), atSequence: row.settledAtSequence },
    presence: { kind: 'absent' as const, reference: resource.name, fingerprint: null,
      inspectedAtSequence: row.settledAtSequence, noLateProducerAfter: acceptedAtSequence } }) };
  const projected = parseCoordinatorSnapshot(encodeCoordinatorSnapshot({ ...envelope.projection.snapshot,
    sequence: nextSequence(envelope), previousDigest: snapshotDigest(envelope.projection.snapshot),
    generation: { ...generation, members: generation.members.map((entry) => entry.memberId === changed.memberId ? changed : entry) } }));
  const original = originalRecoverySnapshot(envelope);
  if (original.generation.kind !== 'dirty') return rejected('Name absence lost its original generation.');
  const memberIds = original.generation.members.map((entry) => entry.memberId);
  return commit(envelope, { noIdAbsences: [...envelope.noIdAbsences, row].sort((left, right) =>
    memberIds.indexOf(left.memberId) - memberIds.indexOf(right.memberId) || (left.role < right.role ? -1 : left.role > right.role ? 1 : 0)) }, projected);
}
function noIdRow(input: Readonly<{ memberId: string; role: ResourceRole; inspectionDigest: string; barrier: AcceptedBarrierDecisionRef }>,
  effect: number, checkpoint: string, atSequence: number): NoIdAbsence {
  const parsed = noIdAbsenceSchema.parse({ memberId: input.memberId, role: input.role, createEffect: effect,
    checkpointDigestAtInspection: checkpoint, barrier: input.barrier, inspectionDigest: input.inspectionDigest, settledAtSequence: atSequence });
  return parsed;
}
export function resourceCompletionAnchor(envelope: RecoveryEnvelope): string {
  const projection = envelope.projection.snapshot.generation;
  if (projection.kind !== 'dirty' || projection.members.length !== 0 || projection.queue.length !== 0 || projection.entered !== null) return rejected('Original resources have not all retired.');
  return coordinatorDigest('agenai.docker-desktop-recovery.completion.v1', JSON.stringify({ recoveryKey: envelope.recoveryKey,
    authorityId: envelope.authorityId, engineKey: envelope.engineKey, generationId: envelope.origin.generationId,
    originalRawDigest: envelope.origin.rawDigest, memberTerminals: envelope.memberTerminals, noIdAbsences: envelope.noIdAbsences }));
}
export function planFinalInventory(envelope: RecoveryEnvelope, decision: FinalInventoryDecision, receipt: FinalInventoryDecisionRef): RecoveryEnvelope {
  if (observing(envelope.phase)) return rejected('Resource completion must join its active native observation first.');
  assertDecisionBinding(envelope, decision);
  if (decision.completionAnchor !== resourceCompletionAnchor(envelope) || !sameReceipt(sdkDecisionReceipt(decision), receipt)
    || JSON.stringify(decision.members) !== JSON.stringify(envelope.memberTerminals.map((entry) => entry.receipt))) return rejected('Final inventory does not match the actual settled original graph.');
  const original = originalRecoverySnapshot(envelope);
  if (original.generation.kind !== 'dirty') return rejected('Final inventory lost its original generation.');
  const expected = original.generation.members.flatMap((member) => member.checkpoint.record.resources.map((resource) => ({ memberId: member.memberId, role: resource.role, name: resource.name })));
  if (decision.resources.length !== expected.length || expected.some((entry) => decision.resources.filter((row) => row.memberId === entry.memberId
    && row.role === entry.role && row.name === entry.name).length !== 1)) return rejected('Final inventory must independently cover every original role and name.');
  if (envelope.phase.kind === 'terminal_ready') {
    if (!sameReceipt(envelope.phase.finalInventory, receipt)) return rejected('Resource completion cannot replace its exact final inventory.');
    return envelope;
  }
  return commit(envelope, { phase: { kind: 'terminal_ready', finalInventory: receipt },
    ...(envelope.phase.kind === 'cleanup' ? { historyHead: envelope.phase.barrier } : {}) });
}
export function planCleanHandback(envelope: RecoveryEnvelope): CoordinatorSnapshot {
  if (envelope.phase.kind !== 'terminal_ready') return rejected('Clean handback requires irreversible resource completion.');
  const planned = planCoordinatorTransition(envelope.projection.snapshot, { kind: 'clean_close' });
  if (planned.kind === 'rejected') return rejected(planned.reason);
  return parseCoordinatorSnapshot(encodeCoordinatorSnapshot({ ...planned.snapshot, previousDigest: recoveryEnvelopeDigest(envelope) }));
}
