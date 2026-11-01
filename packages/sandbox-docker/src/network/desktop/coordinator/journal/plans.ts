import { SandboxValidationError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import {
  actionCell, applicableAction, COORDINATOR_JOURNAL_LIMITS, coordinatorEngineKey, encodeCoordinatorSnapshot,
  memberIdentityDigest, parseCoordinatorSnapshot, recoveryRecordDigest, snapshotDigest,
} from './schema.js';
import type {
  ActionReceipt, AuthorityBasis, CoordinatorFault, CoordinatorMember, CoordinatorSnapshot, DirtyGeneration,
  EnteredEffect, GenerationIdentity, MemberBinding, MemberProjection, QueuedEffect, ResourceAction, ResourceRole,
  RoleLedger, WorkOwnership,
} from './schema.js';

export type CoordinatorPlan = Readonly<{ kind: 'rejected'; reason: string }>
  | Readonly<{ kind: 'commit'; snapshot: CoordinatorSnapshot }>
  | Readonly<{ kind: 'arm'; snapshot: CoordinatorSnapshot; recipe: EnteredEffect }>;

type CheckpointMode = 'caller_persisted' | 'canonical_cleanup';
type MemberEvent = Readonly<{ memberId: string }>;
type ScopeName = keyof WorkOwnership;
type RegistrationBinding = {
  [Profile in MemberBinding['profile']]: Pick<Extract<MemberBinding, { profile: Profile }>, 'profile' | 'backendRevision' | 'configurationIdentityDigest'>
}[MemberBinding['profile']];
export type CoordinatorEvent =
  | Readonly<{ kind: 'close_admission' }>
  | Readonly<{ kind: 'fence'; fault: CoordinatorFault }>
  | Readonly<{ kind: 'clean_close' }>
  | Readonly<{ kind: 'reopen_cleanup' }>
  | Readonly<{ kind: 'register'; record: SandboxRecoveryRecord;
    binding: RegistrationBinding; slot: number }>
  | (MemberEvent & Readonly<{ kind: 'checkpoint'; record: SandboxRecoveryRecord; mode: CheckpointMode }>)
  | (MemberEvent & Readonly<{ kind: 'caller_sink_failed' }>)
  | (MemberEvent & Readonly<{ kind: 'member_state'; state: CoordinatorMember['state'] }>)
  | (MemberEvent & Readonly<{ kind: 'work_enter'; scope: ScopeName; token: string }>)
  | (MemberEvent & Readonly<{ kind: 'work_join'; scope: ScopeName; token: string }>)
  | (MemberEvent & Readonly<{ kind: 'settle_recovered_work'; proofDigest: string }>)
  | (MemberEvent & Readonly<{ kind: 'queue'; role: QueuedEffect['role']; action: QueuedEffect['action'] }>)
  | Readonly<{ kind: 'cancel_queued'; effectSequence: number }>
  | Readonly<{ kind: 'arm'; effectSequence: number; expectedBeforeDigest: string; expectedInputDigest: string }>
  | Readonly<{ kind: 'returned'; effectSequence: number; id: string }>
  | Readonly<{ kind: 'settle'; effectSequence: number; outcome: Extract<ActionReceipt, { kind: 'settled' }>['outcome'];
    receiptDigest: string; presence: RoleLedger['presence']; record?: SandboxRecoveryRecord; mode?: CheckpointMode; projection?: MemberProjection }>
  | (MemberEvent & Readonly<{ kind: 'resolve_uncertain'; role: ResourceRole; action: ResourceAction;
    outcome: Exclude<Extract<ActionReceipt, { kind: 'settled' }>['outcome'], 'not_dispatched'>;
    receiptDigest: string; presence: RoleLedger['presence']; record?: SandboxRecoveryRecord; projection?: MemberProjection }>)
  | (MemberEvent & Readonly<{ kind: 'retire'; record: SandboxRecoveryRecord; mode: CheckpointMode }>)
  | Readonly<{ kind: 'full_basis'; basis: Extract<AuthorityBasis, { kind: 'full' }> }>
  | Readonly<{ kind: 'quiesce'; basis: Extract<AuthorityBasis, { kind: 'full' }> }>;

const rejected = (reason: string): CoordinatorPlan => Object.freeze({ kind: 'rejected', reason });
const cleanup = (entry: Pick<QueuedEffect, 'action'>) => entry.action !== 'create' && entry.action !== 'start';
const liveState = (generation: DirtyGeneration) => generation.state.kind !== 'fenced' && generation.state.kind !== 'cleanup_only';
const admissionOpen = (generation: DirtyGeneration) => liveState(generation) && generation.state.kind !== 'admission_closed';
const unenteredShutdown = (receipt: ActionReceipt) => receipt.kind === 'not_entered'
  || receipt.kind === 'settled' && receipt.outcome === 'not_dispatched';
const usableObserver = (ledger: RoleLedger) => ledger.role === 'route_observer'
  && ledger.presence.kind === 'present' && ledger.presence.runtime === 'running'
  && ledger.start.kind === 'settled' && ledger.start.outcome === 'started'
  && unenteredShutdown(ledger.controlClose) && unenteredShutdown(ledger.delete);
const hasFullObserverAuthority = (generation: DirtyGeneration) => generation.basis.kind === 'full'
  && generation.members.some((member) => member.roles.some((ledger) => usableObserver(ledger)
    && ledger.start.kind === 'settled' && ledger.start.atSequence <= generation.basis.atSequence));
const admitsGrowthRole = (generation: DirtyGeneration, role: QueuedEffect['role']) => hasFullObserverAuthority(generation)
  || role === 'route_observer' && (generation.basis.kind === 'host_engine_only' || admissionOpen(generation));
const scopesSettled = (member: CoordinatorMember) => Object.values(member.work).every((scope) => scope.kind === 'not_entered' || scope.kind === 'joined');
const roleSettled = (ledger: RoleLedger) => (ledger.presence.kind === 'absent' || ledger.presence.kind === 'not_entered')
  && [ledger.create, ledger.start, ledger.controlClose, ledger.delete].every((receipt) => receipt.kind !== 'pending' && receipt.kind !== 'uncertain');

export function createInitialCoordinatorSnapshot(input: Readonly<{ authorityId: string; daemonId: string }>): CoordinatorSnapshot {
  return parseCoordinatorSnapshot(JSON.stringify({ format: 'agenai.docker-desktop-coordinator.v1', authorityId: input.authorityId,
    engineKey: coordinatorEngineKey(input.daemonId), daemonId: input.daemonId, sequence: 0, previousDigest: null,
    generation: { kind: 'clean', generationOrdinal: 0, lastGenerationId: null, settledAtSequence: 0 } }));
}

function commit(snapshot: CoordinatorSnapshot, generation: CoordinatorSnapshot['generation'], armed?: EnteredEffect): CoordinatorPlan {
  if (snapshot.sequence === Number.MAX_SAFE_INTEGER) return rejected('Snapshot sequence is exhausted; dirty ownership must remain retained');
  const next = { ...snapshot, sequence: snapshot.sequence + 1, previousDigest: snapshotDigest(snapshot), generation };
  try {
    const parsed = parseCoordinatorSnapshot(encodeCoordinatorSnapshot(next));
    if (armed === undefined) return Object.freeze({ kind: 'commit', snapshot: parsed });
    if (parsed.generation.kind !== 'dirty' || parsed.generation.entered === null) return rejected('An arm must retain its exact entered request');
    return Object.freeze({ kind: 'arm', snapshot: parsed, recipe: parsed.generation.entered });
  } catch (error) {
    if (error instanceof SandboxValidationError) return rejected(error.message);
    throw error;
  }
}

export function beginCoordinatorGeneration(snapshot: CoordinatorSnapshot,
  input: Readonly<{ identity: GenerationIdentity; basis: AuthorityBasis }>): CoordinatorPlan {
  const previous = snapshot.generation;
  if (previous.kind !== 'clean') return rejected('An unresolved generation cannot activate');
  if (snapshot.sequence >= Number.MAX_SAFE_INTEGER - COORDINATOR_JOURNAL_LIMITS.cleanupEffectReserve
    || previous.generationOrdinal === Number.MAX_SAFE_INTEGER) return rejected('Generation sequence capacity is exhausted');
  if (input.identity.ordinal !== previous.generationOrdinal + 1 || input.identity.generationId === previous.lastGenerationId
    || input.basis.kind !== 'host_engine_only' || input.basis.atSequence !== snapshot.sequence + 1) return rejected('Generation identity or initial authority basis is inconsistent');
  return commit(snapshot, { kind: 'dirty', identity: input.identity, state: { kind: 'awaiting_first_observer' }, basis: input.basis,
    nextMemberSequence: 1, nextEffectSequence: 1, members: [], queue: [], entered: null, retired: [] });
}

function replaceMember(generation: DirtyGeneration, member: CoordinatorMember): DirtyGeneration {
  return { ...generation, members: generation.members.map((item) => item.memberId === member.memberId ? member : item) };
}

function continuation(previous: CoordinatorMember, record: SandboxRecoveryRecord, mode: CheckpointMode): CoordinatorMember | string {
  const original = previous.checkpoint.record;
  const cleanupOnly = previous.checkpoint.callerSink.kind === 'failed';
  if (mode === 'caller_persisted' && cleanupOnly) return 'A failed caller checkpoint sink cannot become healthy';
  if (mode === 'canonical_cleanup' && ['starting', 'running'].includes(record.phase) && record.phase !== original.phase) return 'Canonical cleanup cannot grant new execution authority';
  if (record.format !== original.format || record.backendId !== original.backendId || record.backendRevision !== original.backendRevision
    || record.namespace !== original.namespace || record.operationId !== original.operationId || record.sandboxId !== original.sandboxId
    || record.imageDigest !== original.imageDigest || record.policyDigest !== original.policyDigest
    || record.configurationDigest !== original.configurationDigest || record.resources.length !== original.resources.length
    || original.authority.kind === 'verified' && (record.authority.kind !== 'verified' || record.authority.backendIdentity !== original.authority.backendIdentity)) return 'Checkpoint changes the original member identity';
  for (const resource of original.resources) {
    const next = record.resources.find((item) => item.role === resource.role);
    if (next === undefined || next.name !== resource.name
      || resource.identity.kind === 'planned' && (next.identity.kind === 'identified' || next.identity.kind === 'creating' && (mode === 'canonical_cleanup' || cleanupOnly))
      || resource.identity.kind === 'creating' && next.identity.kind === 'planned'
      || resource.identity.kind === 'identified' && (next.identity.kind !== 'identified' || next.identity.id !== resource.identity.id || next.identity.fingerprint !== resource.identity.fingerprint)) return 'Checkpoint replaces an acquired identity or enters an unauthorized create';
  }
  const recordDigest = recoveryRecordDigest(record);
  if (recordDigest === previous.checkpoint.digest) return previous;
  if (previous.checkpoint.revision === Number.MAX_SAFE_INTEGER) return 'Member checkpoint revision is exhausted';
  return { ...previous, checkpoint: { ...previous.checkpoint, revision: previous.checkpoint.revision + 1, digest: recordDigest, record } };
}

function changedRole(member: CoordinatorMember, resourceRole: ResourceRole, update: (ledger: RoleLedger) => RoleLedger): CoordinatorMember {
  return { ...member, roles: member.roles.map((ledger) => ledger.role === resourceRole ? update(ledger) : ledger) };
}

function settleAction(member: CoordinatorMember, resourceRole: ResourceRole, resourceAction: ResourceAction,
  effectSequence: number, outcome: Extract<ActionReceipt, { kind: 'settled' }>['outcome'], receiptDigest: string,
  presence: RoleLedger['presence'], atSequence: number): CoordinatorMember {
  return changedRole(member, resourceRole, (ledger) => ({ ...ledger, presence,
    [actionCell(resourceAction)]: { kind: 'settled', effect: effectSequence, outcome, receiptDigest, atSequence } }));
}

function emptyRole(resourceRole: ResourceRole, atSequence: number): RoleLedger {
  const receipt = (resourceAction: ResourceAction): ActionReceipt => ({ kind: applicableAction(resourceRole, resourceAction) ? 'not_entered' : 'not_applicable' });
  return { role: resourceRole, presence: { kind: 'not_entered', provedAtSequence: atSequence },
    create: receipt('create'), start: receipt('start'), controlClose: receipt('control_close'), delete: receipt('delete') };
}

function armable(generation: DirtyGeneration, effectSequence: number): QueuedEffect | undefined {
  const growth = generation.queue.find((entry) => !cleanup(entry));
  // Growth requested before every queued cleanup can already own the physical slot when a peer publishes that cleanup.
  if (growth?.effectSequence === effectSequence
    && generation.queue.every((entry) => !cleanup(entry) || entry.requestedAtSequence > growth.requestedAtSequence)) return growth;
  const queued = generation.queue.find(cleanup) ?? generation.queue[0];
  return queued?.effectSequence === effectSequence ? queued : undefined;
}

export function planCoordinatorTransition(snapshot: CoordinatorSnapshot, event: CoordinatorEvent): CoordinatorPlan {
  const generation = snapshot.generation;
  if (generation.kind !== 'dirty') return rejected('This transition requires the original dirty generation');
  const atSequence = snapshot.sequence + 1;
  if (!Number.isSafeInteger(atSequence)) return rejected('Snapshot sequence is exhausted; dirty ownership must remain retained');
  if (event.kind === 'close_admission') return commit(snapshot, { ...generation,
    state: generation.state.kind === 'fenced' || generation.state.kind === 'cleanup_only' ? generation.state : { kind: 'admission_closed' } });
  if (event.kind === 'fence') return commit(snapshot, { ...generation,
    state: generation.state.kind === 'cleanup_only' || generation.state.kind === 'fenced' ? generation.state : { kind: 'fenced', fault: event.fault, atSequence } });
  if (event.kind === 'clean_close') {
    if (admissionOpen(generation) || generation.members.length !== 0 || generation.queue.length !== 0 || generation.entered !== null) return rejected('Clean close requires closed admission and every member and effect obligation settled');
    return commit(snapshot, { kind: 'clean', generationOrdinal: generation.identity.ordinal,
      lastGenerationId: generation.identity.generationId, settledAtSequence: atSequence });
  }
  if (event.kind === 'reopen_cleanup') {
    if (generation.state.kind === 'cleanup_only') return Object.freeze({ kind: 'commit', snapshot });
    const entered = generation.entered;
    let recovered: DirtyGeneration = { ...generation, state: { kind: 'cleanup_only', originalStateDigest: snapshotDigest(snapshot) }, queue: [], entered: null,
      members: generation.members.map((member) => ({ ...member, state: { kind: 'cleanup_pending', fault: 'unknown_outcome' },
        work: { initialization: { kind: 'unavailable_after_recovery' }, primary: { kind: 'unavailable_after_recovery' },
          writers: { kind: 'unavailable_after_recovery' }, export: { kind: 'unavailable_after_recovery' } } })) };
    if (entered !== null && entered.role !== 'member' && entered.action !== 'member_retire') {
      const member = recovered.members.find((item) => item.memberId === entered.memberId);
      if (member === undefined) return rejected('Entered effect lost its original member');
      const resourceAction = entered.action;
      recovered = replaceMember(recovered, changedRole(member, entered.role, (ledger) => ({ ...ledger,
        [actionCell(resourceAction)]: { kind: 'uncertain', effect: entered.effectSequence, intentDigest: snapshotDigest(snapshot) } })));
    }
    return commit(snapshot, recovered);
  }
  if (event.kind === 'register') {
    if (!admissionOpen(generation)) return rejected('Member admission is closed');
    if (snapshot.sequence >= Number.MAX_SAFE_INTEGER - COORDINATOR_JOURNAL_LIMITS.cleanupEffectReserve
      || generation.nextEffectSequence > Number.MAX_SAFE_INTEGER - COORDINATOR_JOURNAL_LIMITS.cleanupEffectReserve
      || generation.nextMemberSequence === Number.MAX_SAFE_INTEGER) return rejected('Normal admission must preserve cleanup sequence capacity');
    if (generation.members.length >= COORDINATOR_JOURNAL_LIMITS.members
      || generation.members.length + generation.retired.length >= COORDINATOR_JOURNAL_LIMITS.retirements) return rejected('Member or reserved retirement capacity is exhausted');
    if (generation.members.some((member) => member.memberId === event.record.operationId)
      || generation.retired.some((member) => member.memberId === event.record.operationId)
      || generation.members.some((member) => member.allocation.kind === 'reserved' && member.allocation.slot === event.slot)) return rejected('Member identity or subnet allocation is already reserved');
    if (event.record.phase !== 'reserved' || event.record.authority.kind !== 'unverified'
      || event.record.resources.some((resource) => resource.identity.kind !== 'planned')) return rejected('Registration requires the exact original inert reservation');
    const allocation = { kind: 'reserved', slot: event.slot, subnet: `10.240.0.${event.slot * 16}/28`, gateway: `10.240.0.${event.slot * 16 + 1}` } as const;
    const recordDigest = recoveryRecordDigest(event.record);
    const member: CoordinatorMember = { memberId: event.record.operationId, memberSequence: generation.nextMemberSequence,
      binding: { ...event.binding, identityDigest: memberIdentityDigest(snapshot, generation.identity, event.record, generation.nextMemberSequence, allocation, event.binding.configurationIdentityDigest),
        initialRecordDigest: recordDigest },
      checkpoint: { revision: 0, digest: recordDigest, record: event.record, callerSink: { kind: 'healthy' } }, state: { kind: 'reserved' }, allocation,
      roles: event.record.resources.map((resource) => emptyRole(resource.role, atSequence)).sort((left, right) => left.role.localeCompare(right.role)),
      projection: { kind: 'none' }, work: { initialization: { kind: 'not_entered' }, primary: { kind: 'not_entered' }, writers: { kind: 'not_entered' }, export: { kind: 'not_entered' } } };
    return commit(snapshot, { ...generation, nextMemberSequence: generation.nextMemberSequence + 1, members: [...generation.members, member] });
  }
  if (event.kind === 'full_basis') {
    if (!liveState(generation) || event.basis.atSequence !== atSequence) return rejected('Full authority requires an unfenced original live generation');
    if (!generation.members.some((member) => member.roles.some(usableObserver))) return rejected('Full authority requires an original settled running observer');
    return commit(snapshot, { ...generation,
      state: generation.state.kind === 'admission_closed' ? generation.state : { kind: 'open' }, basis: event.basis });
  }
  if (event.kind === 'quiesce') {
    if (!liveState(generation) || generation.entered !== null || generation.queue.some((entry) => !cleanup(entry)) || event.basis.atSequence !== atSequence
      || generation.members.some((member) => !scopesSettled(member) || member.roles.some((ledger) => ['compute', 'egress_broker', 'egress_relay', 'filesystem', 'route_observer'].includes(ledger.role) && !roleSettled(ledger)))) return rejected('Quiescence requires joined producers and exact terminal observations');
    return commit(snapshot, { ...generation, basis: event.basis,
      state: generation.state.kind === 'admission_closed' ? generation.state : { kind: 'quiescent' } });
  }
  if (event.kind === 'cancel_queued') {
    if (!generation.queue.some((entry) => entry.effectSequence === event.effectSequence)) return rejected('No matching unentered queue request');
    return commit(snapshot, { ...generation, queue: generation.queue.filter((entry) => entry.effectSequence !== event.effectSequence) });
  }
  if (event.kind === 'arm') {
    if (generation.entered !== null) return rejected('The entered physical effect still owns its slot');
    const queued = armable(generation, event.effectSequence);
    if (queued === undefined || queued.role === 'member' || queued.action === 'member_retire') return rejected('Only the next scheduled resource request can arm');
    const member = generation.members.find((item) => item.memberId === queued.memberId);
    const resource = member?.checkpoint.record.resources.find((item) => item.role === queued.role);
    if (member === undefined || resource === undefined) return rejected('The original member role is absent');
    if (!cleanup(queued) && (!liveState(generation) || member.checkpoint.callerSink.kind === 'failed'
      || member.state.kind === 'stopping' || member.state.kind === 'retained' || member.state.kind === 'cleanup_pending'
      || !admitsGrowthRole(generation, queued.role))) return rejected('Live authority does not admit this growth recipe');
    if (queued.action === 'create' ? resource.identity.kind !== 'creating' : resource.identity.kind !== 'identified') return rejected('Effect requires its exact checkpointed original resource identity');
    const ledger = member.roles.find((item) => item.role === queued.role);
    if (ledger === undefined) return rejected('Original role ledger is absent');
    const resourceAction = queued.action;
    const cell = ledger[actionCell(resourceAction)];
    if (cell.kind !== 'not_entered' && !(cleanup(queued) && (cell.kind === 'uncertain' || cell.kind === 'settled') && cell.effect === queued.effectSequence)) return rejected('This action already entered and cannot be replayed');
    const entered: EnteredEffect = { ...queued, armedAtSequence: atSequence, checkpointRevision: member.checkpoint.revision,
      checkpointDigest: member.checkpoint.digest, reference: resource.identity.kind === 'identified' ? resource.identity.id : resource.name,
      expectedBeforeDigest: event.expectedBeforeDigest, transitionRecipe: `desktop-member-projection-v1/${queued.role}/${queued.action}`,
      expectedInputDigest: event.expectedInputDigest, result: { kind: 'unobserved' } };
    const nextMember = changedRole(member, queued.role, (entry) => ({ ...entry,
      ...(resourceAction === 'create' ? { presence: { kind: 'possibly_present' as const, createEffect: queued.effectSequence, returnedId: null } } : {}),
      [actionCell(resourceAction)]: { kind: 'pending', effect: queued.effectSequence } }));
    return commit(snapshot, { ...replaceMember(generation, nextMember), queue: generation.queue.filter((entry) => entry !== queued), entered }, entered);
  }
  if (event.kind === 'returned' || event.kind === 'settle') {
    const entered = generation.entered;
    if (entered === null || entered.effectSequence !== event.effectSequence || entered.role === 'member' || entered.action === 'member_retire') return rejected('The original entered resource request does not match');
    const member = generation.members.find((item) => item.memberId === entered.memberId);
    if (member === undefined) return rejected('The original entered member is absent');
    if (event.kind === 'returned') {
      if (entered.action !== 'create' || entered.result.kind === 'returned' && entered.result.id !== event.id) return rejected('Returned identity cannot replace an earlier acquired ID');
      const nextMember = changedRole(member, entered.role, (ledger) => ({ ...ledger,
        presence: { kind: 'possibly_present', createEffect: entered.effectSequence, returnedId: event.id } }));
      return commit(snapshot, { ...replaceMember(generation, nextMember), entered: { ...entered, result: { kind: 'returned', id: event.id } } });
    }
    let nextMember = event.record === undefined ? member : continuation(member, event.record, event.mode ?? 'caller_persisted');
    if (typeof nextMember === 'string') return rejected(nextMember);
    if (event.outcome === 'not_dispatched' && entered.result.kind === 'returned') return rejected('An originally returned create cannot become a non-dispatch');
    if (entered.action === 'create' && event.outcome === 'present' && (event.presence.kind !== 'present'
      || (entered.result.kind === 'returned' ? event.presence.id !== entered.result.id
        : event.mode !== 'canonical_cleanup' || generation.state.kind !== 'fenced' && generation.state.kind !== 'cleanup_only'
          || event.record?.resources.find((resource) => resource.role === entered.role)?.identity.kind !== 'identified'))) {
      return rejected('Create settlement requires its original returned identity or exact cleanup readback');
    }
    if (entered.action === 'create' && event.outcome === 'absent') {
      const identity = event.record?.resources.find((resource) => resource.role === entered.role)?.identity;
      const reference = entered.result.kind === 'returned' ? entered.result.id : identity?.kind === 'identified' ? identity.id : undefined;
      if (event.mode !== 'canonical_cleanup' || generation.state.kind !== 'fenced' && generation.state.kind !== 'cleanup_only'
        || event.presence.kind !== 'absent' || reference === undefined
        || event.presence.reference !== reference) return rejected('Absent create cleanup requires its captured original returned ID or acquired identity');
    }
    nextMember = settleAction(nextMember, entered.role, entered.action, entered.effectSequence, event.outcome, event.receiptDigest, event.presence, atSequence);
    if (event.projection !== undefined) nextMember = { ...nextMember, projection: event.projection };
    return commit(snapshot, { ...replaceMember(generation, nextMember), entered: null });
  }
  const member = generation.members.find((item) => item.memberId === event.memberId);
  if (member === undefined) return rejected('No current original member matches');
  if (event.kind === 'checkpoint') {
    if (generation.entered?.memberId === member.memberId) return rejected('An entered checkpoint must settle together with its original effect');
    const next = continuation(member, event.record, event.mode);
    return typeof next === 'string' ? rejected(next) : commit(snapshot, replaceMember(generation, next));
  }
  if (event.kind === 'caller_sink_failed') return commit(snapshot, replaceMember(generation, { ...member,
    checkpoint: { ...member.checkpoint, callerSink: member.checkpoint.callerSink.kind === 'failed' ? member.checkpoint.callerSink : { kind: 'failed', atSequence } },
    state: { kind: 'cleanup_pending', fault: 'storage' } }));
  if (event.kind === 'member_state') {
    const allowed: Record<CoordinatorMember['state']['kind'], readonly CoordinatorMember['state']['kind'][]> = { reserved: ['starting', 'stopping', 'cleanup_pending'], starting: ['active', 'stopping', 'cleanup_pending'],
      active: ['stopping', 'cleanup_pending'], stopping: ['retained', 'cleanup_pending'], retained: ['cleanup_pending'], cleanup_pending: [] };
    // A member decides to stop or retain from its last snapshot, so a cleanup demand published meanwhile already subsumes it.
    const state = member.state.kind === 'cleanup_pending' && (event.state.kind === 'stopping' || event.state.kind === 'retained') ? member.state : event.state;
    if (state.kind !== member.state.kind && !allowed[member.state.kind].includes(state.kind)) return rejected('Member lifecycle cannot move backwards');
    if ((state.kind === 'starting' || state.kind === 'active') && (!liveState(generation) || member.checkpoint.callerSink.kind === 'failed'
      || state.kind === 'active' && !hasFullObserverAuthority(generation))) return rejected('Failed authority cannot grant member growth');
    return commit(snapshot, replaceMember(generation, { ...member, state }));
  }
  if (event.kind === 'work_enter') {
    if (!liveState(generation) || member.checkpoint.callerSink.kind === 'failed' || member.work[event.scope].kind !== 'not_entered'
      || (event.scope === 'primary' || event.scope === 'writers') && !hasFullObserverAuthority(generation)
      || (event.scope === 'export' ? member.state.kind !== 'retained' : member.state.kind !== 'starting' && member.state.kind !== 'active')) return rejected('Original operation scope is not available');
    return commit(snapshot, replaceMember(generation, { ...member, work: { ...member.work, [event.scope]: { kind: 'owned', token: event.token } } }));
  }
  if (event.kind === 'work_join') {
    const scope = member.work[event.scope];
    // Failed publication readback may prove entry never committed, or that the original join already committed.
    if (scope.kind === 'not_entered' || scope.kind === 'joined') return Object.freeze({ kind: 'commit', snapshot });
    if (scope.kind !== 'owned' || scope.token !== event.token) return rejected('Only the original entered scope can join');
    return commit(snapshot, replaceMember(generation, { ...member, work: { ...member.work, [event.scope]: { kind: 'joined' } } }));
  }
  if (event.kind === 'settle_recovered_work') {
    if (generation.state.kind !== 'cleanup_only' || !/^sha256:[a-f0-9]{64}$/u.test(event.proofDigest)
      || !member.roles.every(roleSettled) || generation.entered?.memberId === member.memberId
      || generation.queue.some((entry) => entry.memberId === member.memberId)) return rejected('Recovered producer absence must be established independently before joining lost scopes');
    return commit(snapshot, replaceMember(generation, { ...member, work: { initialization: { kind: 'joined' }, primary: { kind: 'joined' }, writers: { kind: 'joined' }, export: { kind: 'joined' } } }));
  }
  if (event.kind === 'queue') {
    if ((event.role === 'member') !== (event.action === 'member_retire') || event.role !== 'member'
      && (!member.roles.some((ledger) => ledger.role === event.role) || !applicableAction(event.role, event.action))) return rejected('No exact resource/action recipe exists');
    const ordinary = event.action === 'create' || event.action === 'start';
    if (ordinary && (!liveState(generation) || member.checkpoint.callerSink.kind === 'failed'
      || member.state.kind === 'stopping' || member.state.kind === 'retained' || member.state.kind === 'cleanup_pending'
      || !admitsGrowthRole(generation, event.role)
      || snapshot.sequence >= Number.MAX_SAFE_INTEGER - COORDINATOR_JOURNAL_LIMITS.cleanupEffectReserve
      || generation.nextEffectSequence > Number.MAX_SAFE_INTEGER - COORDINATOR_JOURNAL_LIMITS.cleanupEffectReserve)) return rejected('Normal effects must preserve live authority and cleanup reserve');
    if (generation.queue.length >= COORDINATOR_JOURNAL_LIMITS.queue
      || ordinary && generation.queue.filter((entry) => !cleanup(entry)).length >= COORDINATOR_JOURNAL_LIMITS.ordinaryQueue) return rejected('Queue capacity is exhausted');
    if (generation.queue.some((entry) => entry.memberId === member.memberId && entry.role === event.role && entry.action === event.action)
      || generation.entered?.memberId === member.memberId && generation.entered.role === event.role && generation.entered.action === event.action) return rejected('The action already has an original queue or dispatch owner');
    const ledger = member.roles.find((entry) => entry.role === event.role);
    const cell = ledger === undefined || event.action === 'member_retire' ? undefined : ledger[actionCell(event.action)];
    if (cell !== undefined && cell.kind !== 'not_entered' && (ordinary || cell.kind === 'not_applicable' || cell.kind === 'pending')) return rejected('An entered create/start cannot be queued again');
    const reused = cell?.kind === 'uncertain' || cell?.kind === 'settled' ? cell.effect : undefined;
    if (reused === undefined && generation.nextEffectSequence === Number.MAX_SAFE_INTEGER) return rejected('Effect sequence is exhausted');
    const queued: QueuedEffect = { effectSequence: reused ?? generation.nextEffectSequence, memberId: member.memberId,
      role: event.role, action: event.action, bindingDigest: member.binding.identityDigest, requestedAtSequence: atSequence };
    return commit(snapshot, { ...generation, nextEffectSequence: generation.nextEffectSequence + (reused === undefined ? 1 : 0),
      queue: [...generation.queue, queued].sort((left, right) => left.effectSequence - right.effectSequence) });
  }
  if (event.kind === 'resolve_uncertain') {
    const ledger = member.roles.find((entry) => entry.role === event.role);
    const cell = ledger?.[actionCell(event.action)];
    if (cell?.kind !== 'uncertain' || generation.entered?.memberId === member.memberId) return rejected('No matching retained original uncertainty can settle');
    if (event.action === 'create' && ledger?.presence.kind === 'possibly_present' && ledger.presence.returnedId !== null
      && (event.presence.kind === 'present' ? event.presence.id !== ledger.presence.returnedId
        : event.outcome !== 'absent' || event.presence.kind !== 'absent' || event.presence.reference !== ledger.presence.returnedId)) {
      return rejected('Observed identity cannot replace the originally returned create ID');
    }
    if (event.action === 'create' && event.outcome === 'absent'
      && (generation.state.kind !== 'fenced' && generation.state.kind !== 'cleanup_only'
        || ledger?.presence.kind !== 'possibly_present' || ledger.presence.returnedId === null
        || event.presence.kind !== 'absent' || event.presence.reference !== ledger.presence.returnedId)) {
      return rejected('An absent creating name without an acknowledged original ID remains uncertain');
    }
    const continued = event.record === undefined ? member : continuation(member, event.record, 'canonical_cleanup');
    if (typeof continued === 'string') return rejected(continued);
    const next = settleAction(continued, event.role, event.action, cell.effect, event.outcome, event.receiptDigest, event.presence, atSequence);
    return commit(snapshot, replaceMember(generation, event.projection === undefined ? next : { ...next, projection: event.projection }));
  }
  if (event.kind === 'retire') {
    if (!scopesSettled(member) || !member.roles.every(roleSettled) || generation.entered?.memberId === member.memberId
      || generation.queue.some((entry) => entry.memberId === member.memberId && entry.action !== 'member_retire')) return rejected('Retirement requires every original producer, callback and resource obligation settled');
    const next = continuation(member, event.record, event.mode);
    if (typeof next === 'string') return rejected(next);
    if (next.checkpoint.record.phase !== 'destroyed') return rejected('Retirement requires the exact terminal original continuation');
    return commit(snapshot, { ...generation, members: generation.members.filter((item) => item.memberId !== member.memberId),
      queue: generation.queue.filter((entry) => entry.memberId !== member.memberId),
      retired: [...generation.retired, { memberId: member.memberId, memberSequence: member.memberSequence,
        bindingDigest: member.binding.identityDigest, checkpointDigest: next.checkpoint.digest, retiredAtSequence: atSequence }]
        .sort((left, right) => left.memberSequence - right.memberSequence) });
  }
  const unreachable: never = event;
  return unreachable;
}
