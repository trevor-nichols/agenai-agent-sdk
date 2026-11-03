import { Buffer } from 'node:buffer';
import { coordinatorDigest, encodeCoordinatorSnapshot, parseCoordinatorSnapshot, snapshotDigest } from '../journal/schema.js';
import type { CoordinatorMember, CoordinatorSnapshot } from '../journal/schema.js';
import { resourceKind } from '../../../../resources/inspect.js';
import { rawDigest, RecoveryJournalError, requireByteBound } from './scalars.js';
import { RECOVERY_JOURNAL_LIMITS, noIdAbsenceDigest } from './schema.js';
import type { RecoveryEnvelope } from './schema.js';
import { sameReceipt } from './receipts.js';
import { FIRST_SUCCESSOR_SOURCE, PREVIOUS_RECOVERY_SOURCE } from './helperSuccession.js';

function invalid(message: string): never { throw new RecoveryJournalError('invalid', message); }
export function originalRecoverySnapshot(envelope: RecoveryEnvelope): CoordinatorSnapshot {
  const bytes = Buffer.from(envelope.origin.payloadBase64, 'base64');
  if (bytes.toString('base64') !== envelope.origin.payloadBase64 || bytes.length !== envelope.origin.payloadBytes) invalid('Recovery origin has invalid base64 or byte length.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return invalid('Recovery origin requires exact UTF-8 bytes.'); }
  if (!bytes.equals(Buffer.from(text, 'utf8')) || rawDigest(text) !== envelope.origin.rawDigest) invalid('Recovery origin bytes do not match their original digest.');
  return parseCoordinatorSnapshot(text);
}
export function originalFrameDigest(text: string, snapshot: CoordinatorSnapshot): string {
  return rawDigest(`AGENAI-SNAPSHOT-1\n${snapshot.engineKey.slice(7)}\n${rawDigest(text).slice(7)}\n${text}`);
}
export function recoveryKeyFor(snapshot: CoordinatorSnapshot, originalRawDigest: string, originalClaimDigest: string): string {
  if (snapshot.generation.kind !== 'dirty') throw new RecoveryJournalError('invalid', 'Recovery requires an original dirty generation.');
  return coordinatorDigest('agenai.docker-desktop-recovery.transaction.v1', JSON.stringify({ authorityId: snapshot.authorityId,
    engineKey: snapshot.engineKey, generationId: snapshot.generation.identity.generationId, originalRawDigest, originalClaimDigest }));
}
export function assertSupportedRecoveryOrigin(snapshot: CoordinatorSnapshot): void {
  if (snapshot.generation.kind !== 'dirty') throw new RecoveryJournalError('invalid', 'Recovery requires an original dirty generation.');
  for (const member of snapshot.generation.members) for (const resource of member.checkpoint.record.resources) {
    const role = member.roles.find((entry) => entry.role === resource.role);
    if (resourceKind(resource.role) !== 'container' && resource.identity.kind === 'creating'
      && (role?.create.kind === 'pending' || role?.create.kind === 'uncertain')
      && role.presence.kind === 'possibly_present' && role.presence.returnedId === null) {
      throw new RecoveryJournalError('unsupported_no_id_noncontainer', 'An original unresolved no-ID non-container create cannot enter administrative recovery.');
    }
  }
}
export function validateOriginalMemberContinuation(original: CoordinatorMember, current: CoordinatorMember): void {
  if (JSON.stringify(original.binding) !== JSON.stringify(current.binding) || original.memberSequence !== current.memberSequence
    || original.memberId !== current.memberId || JSON.stringify(original.allocation) !== JSON.stringify(current.allocation)) invalid('Recovery projection replaces original member identity.');
  const before = original.checkpoint.record;
  const after = current.checkpoint.record;
  if (before.format !== after.format || before.backendId !== after.backendId || before.backendRevision !== after.backendRevision
    || before.namespace !== after.namespace || before.operationId !== after.operationId || before.sandboxId !== after.sandboxId
    || before.imageDigest !== after.imageDigest || before.policyDigest !== after.policyDigest || before.configurationDigest !== after.configurationDigest
    || before.resources.length !== after.resources.length || current.checkpoint.revision < original.checkpoint.revision
    || original.checkpoint.callerSink.kind === 'failed' && JSON.stringify(current.checkpoint.callerSink) !== JSON.stringify(original.checkpoint.callerSink)
    || before.authority.kind === 'verified' && (after.authority.kind !== 'verified' || before.authority.backendIdentity !== after.authority.backendIdentity)
    || (after.phase === 'starting' || after.phase === 'running') && after.phase !== before.phase) invalid('Recovery checkpoint replaces the original configuration or execution authority.');
  for (const resource of before.resources) {
    const next = after.resources.find((entry) => entry.role === resource.role);
    if (!next || resource.name !== next.name || resource.identity.kind === 'identified'
      && (next.identity.kind !== 'identified' || resource.identity.id !== next.identity.id || resource.identity.fingerprint !== next.identity.fingerprint)
      || resource.identity.kind === 'planned' && next.identity.kind !== 'planned'
      || resource.identity.kind === 'creating' && next.identity.kind === 'planned') invalid('Recovery checkpoint replaces an original resource identity.');
  }
  for (const ledger of original.roles) {
    const next = current.roles.find((entry) => entry.role === ledger.role);
    if (!next) invalid('Recovery loses an original role ledger.');
    for (const action of ['create', 'start', 'controlClose', 'delete'] as const) {
      const priorReceipt = ledger[action];
      const receipt = next[action];
      if (priorReceipt.kind === 'pending' || priorReceipt.kind === 'uncertain') {
        if (receipt.kind !== 'pending' && receipt.kind !== 'uncertain' && receipt.kind !== 'settled') invalid('Recovery erases an original entered action.');
        if (receipt.effect !== priorReceipt.effect || receipt.kind === 'settled' && receipt.outcome === 'not_dispatched') invalid('Recovery replaces an original entered action or invents non-dispatch.');
      }
    }
    if (ledger.create.kind === 'settled' && JSON.stringify(next.create) !== JSON.stringify(ledger.create)) invalid('Recovery replaces an original settled create receipt.');
  }
  for (const [name, scope] of Object.entries(current.work)) {
    if (scope.kind === 'owned') invalid(`Recovery cannot enter ${name} work.`);
  }
}
export function validateRecoveryEnvelope(envelope: RecoveryEnvelope): void {
  const original = originalRecoverySnapshot(envelope);
  assertSupportedRecoveryOrigin(original);
  if (original.generation.kind !== 'dirty') return invalid('Original recovery generation is not dirty.');
  const generation = envelope.projection.snapshot.generation;
  const originalGeneration = original.generation;
  if (generation.kind !== 'dirty' || generation.state.kind !== 'cleanup_only') return invalid('Recovery projection must remain cleanup-only.');
  const originalText = Buffer.from(envelope.origin.payloadBase64, 'base64').toString('utf8');
  const claimDigest = coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(envelope.origin.claim));
  if (envelope.authorityId !== original.authorityId || envelope.engineKey !== original.engineKey || envelope.daemonId !== original.daemonId
    || envelope.origin.sequence !== original.sequence || envelope.origin.generationId !== originalGeneration.identity.generationId
    || envelope.origin.generationOrdinal !== originalGeneration.identity.ordinal || envelope.origin.snapshotDigest !== snapshotDigest(original)
    || envelope.origin.framedDigest !== originalFrameDigest(originalText, original) || envelope.origin.archive.digest !== envelope.origin.framedDigest
    || envelope.origin.archive.bytes !== Buffer.byteLength(originalText) + RECOVERY_JOURNAL_LIMITS.nativeHeaderBytes
    || originalGeneration.basis.exclusionDigest !== claimDigest
    || envelope.recoveryKey !== recoveryKeyFor(original, envelope.origin.rawDigest, claimDigest)) invalid('Recovery origin does not bind the canonical original claim and bytes.');
  const identity = originalGeneration.identity;
  if (identity.hostPreparationDigest !== envelope.preparation.sharedDigest
    || identity.engineBindingDigest !== coordinatorDigest('agenai.desktop-coordinator.engine-binding.v1', JSON.stringify({ daemonId: original.daemonId, shared: envelope.preparation.sharedDigest }))
    || identity.nativeAssetDigest !== coordinatorDigest('agenai.desktop-coordinator.native-asset.v1', JSON.stringify(envelope.preparation.originalHelper))) invalid('Recovery preparation changes the original generation.');
  const projection = envelope.projection.snapshot;
  if (projection.authorityId !== original.authorityId || projection.engineKey !== original.engineKey || projection.daemonId !== original.daemonId
    || projection.sequence !== envelope.sequence || envelope.sequence <= original.sequence || envelope.transport.admittedAtSequence > envelope.sequence
    || JSON.stringify(generation.identity) !== JSON.stringify(identity) || generation.nextMemberSequence !== originalGeneration.nextMemberSequence
    || JSON.stringify(generation.basis) !== JSON.stringify(originalGeneration.basis)
    || generation.state.originalStateDigest !== (originalGeneration.state.kind === 'cleanup_only'
      ? originalGeneration.state.originalStateDigest : envelope.origin.snapshotDigest)
    || generation.nextEffectSequence < originalGeneration.nextEffectSequence) invalid('Recovery projection changes the original generation or counters.');
  if (envelope.sequence === original.sequence + 1
    ? envelope.predecessor.format !== 'coordinator-v1' || envelope.predecessor.digest !== envelope.origin.snapshotDigest
    : envelope.format === 'agenai.docker-desktop-recovery.v1' ? envelope.predecessor.format !== 'recovery-v1'
      : envelope.format === 'agenai.docker-desktop-recovery.v2'
        ? envelope.predecessor.format !== 'recovery-v1' && envelope.predecessor.format !== 'recovery-v2'
        : envelope.predecessor.format !== 'recovery-v2' && envelope.predecessor.format !== 'recovery-v3') invalid('Recovery predecessor crosses the original journal boundary incorrectly.');
  if (envelope.format === 'agenai.docker-desktop-recovery.v2'
    && (envelope.preparation.recoveryHelper.sourceDigest !== PREVIOUS_RECOVERY_SOURCE
      || envelope.activeHelper.sourceDigest === PREVIOUS_RECOVERY_SOURCE
      || envelope.previousIssuer.throughAttempt >= envelope.nextAttempt
      || envelope.historyHead === null || envelope.historyHead.attempt < envelope.previousIssuer.throughAttempt
      || (envelope.phase.kind === 'attempt_prepared' || envelope.phase.kind === 'armed' || envelope.phase.kind === 'stopped')
        && envelope.phase.ordinal <= envelope.previousIssuer.throughAttempt
      || envelope.phase.kind === 'cleanup' && envelope.phase.barrier.attempt <= envelope.previousIssuer.throughAttempt
      || envelope.noIdAbsences.some((row) => row.barrier.attempt <= envelope.previousIssuer.throughAttempt))) invalid('Recovery helper succession loses its fixed original issuer boundary.');
  if (envelope.format === 'agenai.docker-desktop-recovery.v3') {
    const [originalIssuer, firstSuccessor] = envelope.previousIssuers;
    if (envelope.preparation.recoveryHelper.sourceDigest !== PREVIOUS_RECOVERY_SOURCE
      || firstSuccessor.helper.sourceDigest !== FIRST_SUCCESSOR_SOURCE
      || envelope.activeHelper.sourceDigest === PREVIOUS_RECOVERY_SOURCE || envelope.activeHelper.sourceDigest === FIRST_SUCCESSOR_SOURCE
      || originalIssuer.throughAttempt >= firstSuccessor.throughAttempt || firstSuccessor.throughAttempt >= envelope.nextAttempt
      || envelope.historyHead === null || envelope.historyHead.attempt < firstSuccessor.throughAttempt
      || (envelope.phase.kind === 'attempt_prepared' || envelope.phase.kind === 'armed' || envelope.phase.kind === 'stopped')
        && envelope.phase.ordinal <= firstSuccessor.throughAttempt
      || envelope.phase.kind === 'cleanup' && envelope.phase.barrier.attempt <= firstSuccessor.throughAttempt
      || envelope.noIdAbsences.some((row) => row.barrier.attempt <= firstSuccessor.throughAttempt)) {
      invalid('Recovery second helper succession loses its two fixed historical issuer intervals.');
    }
  }
  for (const prior of originalGeneration.retired) {
    if (!generation.retired.some((entry) => JSON.stringify(entry) === JSON.stringify(prior))) invalid('Recovery loses original retirement history.');
  }
  if (generation.retired.some((entry) => !originalGeneration.retired.some((prior) => prior.memberId === entry.memberId)
    && !originalGeneration.members.some((prior) => prior.memberId === entry.memberId))) invalid('Recovery adds foreign retirement history.');
  for (const member of generation.members) {
    const prior = originalGeneration.members.find((entry) => entry.memberId === member.memberId);
    if (!prior) invalid('Recovery adds a foreign member.');
    validateOriginalMemberContinuation(prior, member);
  }
  for (const prior of originalGeneration.members) {
    const current = generation.members.find((entry) => entry.memberId === prior.memberId);
    const retired = generation.retired.find((entry) => entry.memberId === prior.memberId);
    if ((current === undefined) === (retired === undefined)) invalid('Every original member must remain current or exactly retired.');
    const terminal = envelope.memberTerminals.find((entry) => entry.memberId === prior.memberId);
    if (retired && (!terminal || terminal.memberSequence !== prior.memberSequence || terminal.checkpointDigest !== retired.checkpointDigest
      || terminal.receipt.memberId !== prior.memberId || retired.bindingDigest !== prior.binding.identityDigest)) invalid('Original retirement lacks its exact terminal manifest.');
    if (current && terminal) invalid('A terminal member manifest cannot replace a current member.');
  }
  if (new Set(envelope.memberTerminals.map((entry) => entry.memberId)).size !== envelope.memberTerminals.length
    || envelope.memberTerminals.some((entry, index) => !originalGeneration.members.some((member) => member.memberId === entry.memberId)
      || index > 0 && entry.memberSequence <= (envelope.memberTerminals[index - 1]?.memberSequence ?? 0))) invalid('Invalid original terminal manifest inventory.');
  const rows = new Map<string, typeof envelope.noIdAbsences[number]>();
  let previousRow: Readonly<{ memberSequence: number; role: string }> | undefined;
  for (const row of envelope.noIdAbsences) {
    requireByteBound(row, RECOVERY_JOURNAL_LIMITS.noIdRowBytes, 'No-ID settlement');
    const key = `${row.memberId}/${row.role}`;
    if (rows.has(key) || row.settledAtSequence > envelope.sequence || row.barrier.attempt >= envelope.nextAttempt) invalid('Invalid no-ID settlement sequence or duplicate.');
    rows.set(key, row);
    const prior = originalGeneration.members.find((entry) => entry.memberId === row.memberId);
    const ledger = prior?.roles.find((entry) => entry.role === row.role);
    const resource = prior?.checkpoint.record.resources.find((entry) => entry.role === row.role);
    if (!prior || !ledger || !resource || resource.identity.kind !== 'creating' || ledger.create.kind !== 'pending' && ledger.create.kind !== 'uncertain'
      || ledger.create.effect !== row.createEffect || ledger.presence.kind !== 'possibly_present' || ledger.presence.returnedId !== null) invalid('No-ID settlement does not bind original uncertainty.');
    if (previousRow && (prior.memberSequence < previousRow.memberSequence
      || prior.memberSequence === previousRow.memberSequence && row.role <= previousRow.role)) invalid('No-ID settlements must be sorted by original member sequence and role.');
    previousRow = { memberSequence: prior.memberSequence, role: row.role };
    const current = generation.members.find((entry) => entry.memberId === row.memberId);
    if (current) {
      const settled = current.roles.find((entry) => entry.role === row.role);
      if (settled?.create.kind !== 'settled' || settled.create.outcome !== 'absent' || settled.create.effect !== row.createEffect
        || settled.create.receiptDigest !== noIdAbsenceDigest(row) || settled.presence.kind !== 'absent'
        || settled.presence.reference !== resource.name || settled.presence.fingerprint !== null) invalid('Recovery name absence lacks its exact projected receipt.');
    }
  }
  for (const member of generation.members) for (const ledger of member.roles) {
    const prior = originalGeneration.members.find((entry) => entry.memberId === member.memberId)?.roles.find((entry) => entry.role === ledger.role);
    const resource = member.checkpoint.record.resources.find((entry) => entry.role === ledger.role);
    if (prior?.presence.kind === 'possibly_present' && prior.presence.returnedId === null
      && (prior.create.kind === 'pending' || prior.create.kind === 'uncertain') && resource?.identity.kind === 'creating'
      && ledger.create.kind === 'settled' && ledger.create.outcome === 'absent' && !rows.has(`${member.memberId}/${ledger.role}`)) invalid('A no-ID create cannot silently become absent.');
  }
  if (generation.queue.some((entry) => entry.action === 'create' || entry.action === 'start')
    || generation.entered?.action === 'create' || generation.entered?.action === 'start') invalid('Recovery cannot dispatch growth.');
  if (envelope.phase.kind === 'cleanup' && (envelope.phase.barrier.attempt !== envelope.nextAttempt - 1
    || envelope.phase.acceptedAtSequence !== envelope.transport.admittedAtSequence
    || envelope.phase.acceptedAtSequence > envelope.sequence
    || envelope.historyHead && envelope.historyHead.attempt >= envelope.phase.barrier.attempt)) invalid('Invalid accepted barrier sequence.');
  if ('ordinal' in envelope.phase && (envelope.phase.ordinal !== envelope.nextAttempt - 1
    || envelope.phase.kind !== 'attempt_closed' && envelope.historyHead && envelope.historyHead.attempt >= envelope.phase.ordinal)) invalid('Invalid current attempt ordinal.');
  if ((envelope.phase.kind === 'armed' || envelope.phase.kind === 'stopped') && (envelope.phase.armed.attempt !== envelope.phase.ordinal
    || envelope.phase.kind === 'stopped' && envelope.phase.stopped.attempt !== envelope.phase.ordinal)) invalid('Native observation stages replace the current attempt.');
  if (envelope.phase.kind === 'attempt_closed' && (envelope.phase.terminal.attempt !== envelope.phase.ordinal
    || !envelope.historyHead || !sameReceipt(envelope.phase.terminal, envelope.historyHead))) invalid('Closed attempt loses its exact immutable history head.');
  if (envelope.historyHead && envelope.historyHead.attempt >= envelope.nextAttempt) invalid('Invalid original attempt history.');
  if (envelope.release.kind === 'requested' && envelope.release.atSequence > envelope.sequence) invalid('Invalid retained release sequence.');
  if (envelope.phase.kind === 'terminal_ready' && (generation.members.length !== 0 || generation.queue.length !== 0 || generation.entered !== null)) invalid('Terminal recovery still owns a resource or effect.');
  requireByteBound(JSON.parse(encodeCoordinatorSnapshot(projection)), RECOVERY_JOURNAL_LIMITS.projectionBytes, 'Cleanup projection');
  const { origin, projection: omittedProjection, noIdAbsences: omittedRows, ...control } = envelope;
  void omittedProjection; void omittedRows;
  const { payloadBase64: omittedPayload, ...originMetadata } = origin; void omittedPayload;
  requireByteBound({ ...control, origin: originMetadata }, RECOVERY_JOURNAL_LIMITS.controlBytes, 'Recovery control');
}
