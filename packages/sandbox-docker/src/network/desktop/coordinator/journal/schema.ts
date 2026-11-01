import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { parseSandboxRecoveryRecord, SandboxValidationError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { z } from 'zod/v4';

export const COORDINATOR_JOURNAL_LIMITS = Object.freeze({
  framedBytes: 1_048_576, nativeHeaderBytes: 148, envelopeBytes: 16_384,
  recordBytes: 65_536, memberMetadataBytes: 32_768, effectBytes: 4_096,
  tombstoneBytes: 256, members: 4, retirements: 256, queue: 16,
  ordinaryQueue: 12, cleanupQueueReserve: 4, cleanupEffectReserve: 64,
  idBytes: 256, resourceRoles: 9, vmLinks: 3, subnetSlots: 16,
});

const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const id = z.string().min(1).refine((value) => value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= COORDINATOR_JOURNAL_LIMITS.idBytes);
const ipv4 = z.string().refine((value) => {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255);
});
const mac = z.string().regex(/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u);
const subnet = z.string().refine((value) => /^10\.240\.0\.(?:0|16|32|48|64|80|96|112|128|144|160|176|192|208|224|240)\/28$/u.test(value));
const role = z.enum(['compute', 'storage', 'export', 'network', 'egress_socket', 'egress_broker', 'egress_relay', 'filesystem', 'route_observer']);
const action = z.enum(['create', 'start', 'control_close', 'delete', 'member_retire']);
const fault = z.enum(['storage', 'exclusion', 'endpoint', 'engine', 'host', 'vm', 'proxy', 'observation_timeout',
  'effect_timeout', 'unexpected_topology', 'no_observer', 'sequence_exhausted', 'capacity', 'member_binding', 'unknown_outcome']);
const generationIdentity = z.strictObject({
  generationId: uuid, ordinal: sequence, coordinationRevision: z.literal('desktop-coordination-v1'),
  coordinationPolicyDigest: digest, engineBindingDigest: digest, endpointBindingDigest: digest,
  hostPreparationDigest: digest, nativeAssetDigest: digest,
});
const generationState = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('awaiting_first_observer') }),
  z.strictObject({ kind: z.literal('open') }),
  z.strictObject({ kind: z.literal('quiescent') }),
  z.strictObject({ kind: z.literal('admission_closed') }),
  z.strictObject({ kind: z.literal('fenced'), fault, atSequence: sequence }),
  z.strictObject({ kind: z.literal('cleanup_only'), originalStateDigest: digest }),
]);
const authorityBasis = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host_engine_only'), hostDigest: digest, engineDigest: digest, exclusionDigest: digest, atSequence: sequence }),
  z.strictObject({ kind: z.literal('full'), hostDigest: digest, engineDigest: digest, vmDigest: digest,
    externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: digest, projectionDigest: digest, atSequence: sequence }),
]);
const memberBinding = z.discriminatedUnion('profile', [
  z.strictObject({ identityDigest: digest, initialRecordDigest: digest, configurationIdentityDigest: digest,
    profile: z.literal('desktop-apple-virtualization-native-arm64'), backendRevision: z.literal('engine-1.52-v7-desktop-apple-virtualization-native-arm64') }),
  z.strictObject({ identityDigest: digest, initialRecordDigest: digest, configurationIdentityDigest: digest,
    profile: z.literal('desktop-apple-virtualization-rosetta-amd64'), backendRevision: z.literal('engine-1.52-v7-desktop-apple-virtualization-rosetta-amd64') }),
]);
const recoveryRecord = z.unknown().transform((value, context): SandboxRecoveryRecord => {
  try { return parseSandboxRecoveryRecord(value); }
  catch {
    context.addIssue({ code: 'custom', message: 'Invalid original v3 recovery record' });
    return z.NEVER;
  }
});
const checkpoint = z.strictObject({ revision: sequence, digest, record: recoveryRecord,
  callerSink: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('healthy') }), z.strictObject({ kind: z.literal('failed'), atSequence: sequence })]),
});
const memberState = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reserved') }), z.strictObject({ kind: z.literal('starting') }),
  z.strictObject({ kind: z.literal('active') }), z.strictObject({ kind: z.literal('stopping') }),
  z.strictObject({ kind: z.literal('retained') }), z.strictObject({ kind: z.literal('cleanup_pending'), fault }),
]);
const allocation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reserved'), slot: z.number().int().min(0).max(COORDINATOR_JOURNAL_LIMITS.subnetSlots - 1), subnet, gateway: ipv4 }),
  z.strictObject({ kind: z.literal('released'), previousSlot: z.number().int().min(0).max(COORDINATOR_JOURNAL_LIMITS.subnetSlots - 1), releaseSequence: sequence }),
]);
const presence = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not_entered'), provedAtSequence: sequence }),
  z.strictObject({ kind: z.literal('possibly_present'), createEffect: sequence, returnedId: id.nullable() }),
  z.strictObject({ kind: z.literal('present'), id, fingerprint: digest, inspectionDigest: digest, runtime: z.enum(['not_applicable', 'created', 'running', 'exited']) }),
  z.strictObject({ kind: z.literal('absent'), reference: id, fingerprint: digest.nullable(), inspectedAtSequence: sequence, noLateProducerAfter: sequence }),
]);
const actionReceipt = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not_applicable') }), z.strictObject({ kind: z.literal('not_entered') }),
  z.strictObject({ kind: z.literal('pending'), effect: sequence }),
  z.strictObject({ kind: z.literal('uncertain'), effect: sequence, intentDigest: digest }),
  z.strictObject({ kind: z.literal('settled'), effect: sequence,
    outcome: z.enum(['not_dispatched', 'present', 'started', 'control_joined', 'absent']), receiptDigest: digest, atSequence: sequence }),
]);
const roleLedger = z.strictObject({ role, presence, create: actionReceipt, start: actionReceipt, controlClose: actionReceipt, delete: actionReceipt });
const projectionFacts = z.strictObject({
  network: z.strictObject({ id, name: id, bridgeName: id, subnet, gateway: ipv4, identityDigest: digest }).nullable(),
  observerId: id.nullable(), computeNoneId: id.nullable(), filesystemNoneId: id.nullable(),
  broker: z.strictObject({ id, endpointId: id, mac, address: ipv4, prefixLength: z.literal(28), gateway: ipv4 }).nullable(),
  vmLinks: z.array(z.strictObject({ index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), name: id, mac, identityDigest: digest, stateDigest: digest })).max(COORDINATOR_JOURNAL_LIMITS.vmLinks),
  engineDigest: digest, vmDigest: digest,
});
const projection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('registered'), recipe: z.literal('desktop-member-projection-v1'),
    phase: z.enum(['observer_only', 'bridge_empty', 'broker_created', 'broker_active', 'started', 'retiring', 'retained_empty']), facts: projectionFacts, digest }),
]);
const workScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not_entered') }), z.strictObject({ kind: z.literal('owned'), token: uuid }),
  z.strictObject({ kind: z.literal('joined') }), z.strictObject({ kind: z.literal('unavailable_after_recovery') }),
]);
const workOwnership = z.strictObject({ initialization: workScope, primary: workScope, writers: workScope, export: workScope });
const member = z.strictObject({ memberId: uuid, memberSequence: sequence, binding: memberBinding, checkpoint,
  state: memberState, allocation, roles: z.array(roleLedger).min(1).max(COORDINATOR_JOURNAL_LIMITS.resourceRoles), projection, work: workOwnership });
const queuedFields = { effectSequence: sequence, memberId: uuid, role: z.union([role, z.literal('member')]), action,
  bindingDigest: digest, requestedAtSequence: sequence };
const queuedEffect = z.strictObject(queuedFields);
const transitionRecipe = z.string().refine((value) => {
  const [, resourceRole, resourceAction, extra] = value.split('/');
  return value.startsWith('desktop-member-projection-v1/') && extra === undefined
    && role.safeParse(resourceRole).success && action.safeParse(resourceAction).success
    && resourceAction !== 'member_retire' && applicableAction(resourceRole, resourceAction);
});
const enteredEffect = z.strictObject({ ...queuedFields, armedAtSequence: sequence, checkpointRevision: sequence,
  checkpointDigest: digest, reference: id, expectedBeforeDigest: digest, transitionRecipe, expectedInputDigest: digest,
  result: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('unobserved') }), z.strictObject({ kind: z.literal('returned'), id })]),
});
const tombstone = z.tuple([uuid, sequence, digest, digest, sequence]).transform(([memberId, memberSequence, bindingDigest, checkpointDigest, retiredAtSequence]) =>
  ({ memberId, memberSequence, bindingDigest, checkpointDigest, retiredAtSequence }));
const dirtyGeneration = z.strictObject({ kind: z.literal('dirty'), identity: generationIdentity, state: generationState,
  basis: authorityBasis, nextMemberSequence: sequence, nextEffectSequence: sequence, members: z.array(member).max(COORDINATOR_JOURNAL_LIMITS.members),
  queue: z.array(queuedEffect).max(COORDINATOR_JOURNAL_LIMITS.queue), entered: enteredEffect.nullable(), retired: z.array(tombstone).max(COORDINATOR_JOURNAL_LIMITS.retirements) });
const snapshotSchema = z.strictObject({ format: z.literal('agenai.docker-desktop-coordinator.v1'), authorityId: uuid,
  engineKey: digest, daemonId: id, sequence, previousDigest: digest.nullable(), generation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('clean'), generationOrdinal: sequence, lastGenerationId: uuid.nullable(), settledAtSequence: sequence }),
    dirtyGeneration,
  ]) });

type Immutable<Value> = Value extends string | number | boolean | null | undefined ? Value : Value extends readonly (infer Item)[] ? readonly Immutable<Item>[]
  : Value extends object ? { readonly [Key in keyof Value]: Immutable<Value[Key]> } : Value;
export type CoordinatorSnapshot = Immutable<z.output<typeof snapshotSchema>>;
export type DirtyGeneration = Extract<CoordinatorSnapshot['generation'], { kind: 'dirty' }>;
export type GenerationIdentity = Immutable<z.output<typeof generationIdentity>>;
export type AuthorityBasis = Immutable<z.output<typeof authorityBasis>>;
export type CoordinatorFault = z.output<typeof fault>;
export type CoordinatorMember = Immutable<z.output<typeof member>>;
export type MemberBinding = CoordinatorMember['binding'];
export type MemberAllocation = CoordinatorMember['allocation'];
export type MemberProjection = CoordinatorMember['projection'];
export type WorkOwnership = CoordinatorMember['work'];
export type RoleLedger = Immutable<z.output<typeof roleLedger>>;
export type ActionReceipt = Immutable<z.output<typeof actionReceipt>>;
export type QueuedEffect = Immutable<z.output<typeof queuedEffect>>;
export type EnteredEffect = Immutable<z.output<typeof enteredEffect>>;
export type MemberTombstone = DirtyGeneration['retired'][number];
export type ResourceAction = Exclude<QueuedEffect['action'], 'member_retire'>;
export type ResourceRole = RoleLedger['role'];

function invalid(message: string): never {
  throw new SandboxValidationError([{ code: 'invalid_input', path: [], message }]);
}

export function coordinatorDigest(domain: string, text: string): string {
  if (!domain.isWellFormed() || !text.isWellFormed()) invalid('Coordinator digest input must be valid Unicode');
  return `sha256:${createHash('sha256').update(domain).update('\0').update(text, 'utf8').digest('hex')}`;
}

export function coordinatorEngineKey(daemonId: string): string {
  if (!id.safeParse(daemonId).success) invalid('Invalid coordinator daemon ID');
  return coordinatorDigest('agenai.desktop-coordinator.engine.v1', daemonId);
}

function canonicalRecord(record: SandboxRecoveryRecord): SandboxRecoveryRecord {
  return { format: record.format, backendId: record.backendId, backendRevision: record.backendRevision,
    namespace: record.namespace, operationId: record.operationId, sandboxId: record.sandboxId, imageDigest: record.imageDigest,
    policyDigest: record.policyDigest, configurationDigest: record.configurationDigest, phase: record.phase,
    authority: record.authority.kind === 'unverified' ? { kind: 'unverified' }
      : { kind: 'verified', backendIdentity: record.authority.backendIdentity },
    resources: record.resources.map((resource) => ({ role: resource.role, name: resource.name,
      identity: resource.identity.kind === 'identified' ? { kind: 'identified', id: resource.identity.id, fingerprint: resource.identity.fingerprint }
        : { kind: resource.identity.kind } })),
  };
}

export function recoveryRecordDigest(record: SandboxRecoveryRecord): string {
  const text = JSON.stringify(canonicalRecord(parseSandboxRecoveryRecord(record)));
  if (!text.isWellFormed() || Buffer.byteLength(text, 'utf8') > COORDINATOR_JOURNAL_LIMITS.recordBytes) invalid('Coordinator record exceeds its byte bound');
  return coordinatorDigest('agenai.desktop-coordinator.recovery-record.v1', text);
}

function initialRecoveryDigest(record: SandboxRecoveryRecord): string {
  return recoveryRecordDigest({ ...record, phase: 'reserved', authority: { kind: 'unverified' },
    resources: record.resources.map((resource) => ({ role: resource.role, name: resource.name, identity: { kind: 'planned' } })) });
}

export function memberIdentityDigest(snapshot: Pick<CoordinatorSnapshot, 'authorityId' | 'engineKey'>,
  identity: GenerationIdentity, record: SandboxRecoveryRecord, memberSequence: number,
  memberAllocation: Extract<MemberAllocation, { kind: 'reserved' }>, configurationIdentityDigest: string): string {
  return coordinatorDigest('agenai.desktop-coordinator.member.v1', JSON.stringify({ authorityId: snapshot.authorityId,
    engineKey: snapshot.engineKey, generationId: identity.generationId, generationOrdinal: identity.ordinal,
    coordinationPolicyDigest: identity.coordinationPolicyDigest, configurationIdentityDigest, memberId: record.operationId,
    memberSequence, allocation: { slot: memberAllocation.slot, subnet: memberAllocation.subnet, gateway: memberAllocation.gateway },
    record: { format: record.format, backendId: record.backendId, backendRevision: record.backendRevision, namespace: record.namespace,
      operationId: record.operationId, sandboxId: record.sandboxId, imageDigest: record.imageDigest, policyDigest: record.policyDigest,
      configurationDigest: record.configurationDigest, resources: record.resources.map(({ role: resourceRole, name }) => ({ role: resourceRole, name })) } }));
}

export function projectionDigest(value: Extract<MemberProjection, { kind: 'registered' }>): string {
  const parsed = projectionFacts.safeParse(value.facts);
  if (!parsed.success) invalid('Invalid bounded member projection facts');
  return coordinatorDigest('agenai.desktop-coordinator.projection.v1', JSON.stringify({ recipe: value.recipe, phase: value.phase, facts: parsed.data }));
}

export function applicableAction(resourceRole: string | undefined, resourceAction: string | undefined): boolean {
  if (resourceAction === 'create' || resourceAction === 'delete') return role.safeParse(resourceRole).success;
  if (resourceAction === 'start') return ['compute', 'filesystem', 'route_observer', 'egress_broker', 'egress_relay'].includes(resourceRole ?? '');
  if (resourceAction === 'control_close') return ['filesystem', 'route_observer', 'egress_broker', 'egress_relay'].includes(resourceRole ?? '');
  return false;
}

export function actionCell(resourceAction: ResourceAction): 'create' | 'start' | 'controlClose' | 'delete' {
  return resourceAction === 'control_close' ? 'controlClose' : resourceAction;
}

function tombstoneWire(value: MemberTombstone) {
  return [value.memberId, value.memberSequence, value.bindingDigest, value.checkpointDigest, value.retiredAtSequence];
}

function wireSnapshot(snapshot: CoordinatorSnapshot): unknown {
  if (snapshot.generation.kind === 'clean') return snapshot;
  return { ...snapshot, generation: { ...snapshot.generation,
    members: snapshot.generation.members.map((item) => ({ ...item, checkpoint: { ...item.checkpoint, record: canonicalRecord(parseSandboxRecoveryRecord(item.checkpoint.record)) } })),
    retired: snapshot.generation.retired.map(tombstoneWire) } };
}

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

function sortedUnique<Value>(values: readonly Value[], key: (value: Value) => string | number): boolean {
  return values.every((value, index) => index === 0 || key(values[index - 1]) < key(value));
}

function validateSnapshot(snapshot: CoordinatorSnapshot): void {
  const at = (value: number) => value <= snapshot.sequence;
  if (snapshot.engineKey !== coordinatorEngineKey(snapshot.daemonId)) invalid('Engine key does not bind the daemon ID');
  if ((snapshot.sequence === 0) !== (snapshot.previousDigest === null)) invalid('Initial sequence alone has no previous digest');
  const generation = snapshot.generation;
  if (generation.kind === 'clean') {
    if (!at(generation.settledAtSequence) || generation.settledAtSequence !== snapshot.sequence
      || (generation.generationOrdinal === 0) !== (generation.lastGenerationId === null)
      || (snapshot.sequence === 0) !== (generation.generationOrdinal === 0)) invalid('Invalid clean generation settlement');
    return;
  }
  if (snapshot.sequence === 0 || generation.identity.ordinal === 0 || generation.nextMemberSequence === 0 || generation.nextEffectSequence === 0
    || generation.identity.generationId === snapshot.authorityId
    || !at(generation.basis.atSequence)
    || generation.state.kind === 'fenced' && !at(generation.state.atSequence)) invalid('Invalid dirty generation counters');
  if (generation.state.kind === 'awaiting_first_observer' && generation.basis.kind !== 'host_engine_only'
    || (generation.state.kind === 'open' || generation.state.kind === 'quiescent') && generation.basis.kind !== 'full') invalid('Generation state has an incompatible authority basis');
  if (generation.members.length + generation.retired.length > COORDINATOR_JOURNAL_LIMITS.retirements) invalid('Generation retirement reservations exhausted');
  if (!sortedUnique(generation.members, (item) => item.memberSequence) || !sortedUnique(generation.retired, (item) => item.memberSequence)
    || !sortedUnique(generation.queue, (item) => item.effectSequence)) invalid('Coordinator arrays must be sorted and unique');
  const allMembers = [...generation.members, ...generation.retired];
  if (new Set(allMembers.map((item) => item.memberId)).size !== allMembers.length
    || new Set(allMembers.map((item) => item.memberSequence)).size !== allMembers.length
    || allMembers.some((item) => item.memberSequence === 0 || item.memberSequence >= generation.nextMemberSequence
      || item.memberId === snapshot.authorityId || item.memberId === generation.identity.generationId)) invalid('Member identity or sequence was reused');
  const slots = generation.members.flatMap((item) => item.allocation.kind === 'reserved' ? [item.allocation.slot] : []);
  if (new Set(slots).size !== slots.length) invalid('Reserved subnet slots must be unique');
  const effectOwners = new Map<number, string>();
  const pending: number[] = [];
  const resourceNames = new Set<string>();
  const resourceIds = new Set<string>();
  const workTokens = new Set<string>();
  for (const item of generation.members) {
    const record = item.checkpoint.record;
    for (const resource of record.resources) {
      if (resourceNames.has(resource.name) || resource.identity.kind === 'identified' && resourceIds.has(resource.identity.id)) invalid('Members cannot share original resource names or acquired IDs');
      resourceNames.add(resource.name);
      if (resource.identity.kind === 'identified') resourceIds.add(resource.identity.id);
    }
    if (record.operationId !== item.memberId || record.backendId !== 'agenai-docker'
      || record.backendRevision !== item.binding.backendRevision || record.configurationDigest !== item.binding.configurationIdentityDigest
      || record.sandboxId !== `docker-${item.memberId}` || record.authority.kind === 'verified' && record.authority.backendIdentity !== snapshot.daemonId
      || item.checkpoint.digest !== recoveryRecordDigest(record) || item.binding.initialRecordDigest !== initialRecoveryDigest(record)
      || !at(item.checkpoint.revision)
      || item.checkpoint.revision === 0 && (item.binding.initialRecordDigest !== item.checkpoint.digest || record.phase !== 'reserved'
        || record.authority.kind !== 'unverified' || record.resources.some((resource) => resource.identity.kind !== 'planned'))
      || item.checkpoint.callerSink.kind === 'failed' && !at(item.checkpoint.callerSink.atSequence)) invalid('Member checkpoint does not match its original binding');
    if (!sortedUnique(item.roles, (entry) => entry.role) || item.roles.length !== record.resources.length
      || item.roles.some((entry) => !record.resources.some((resource) => resource.role === entry.role))) invalid('Role ledger must exactly match the original record');
    if (item.allocation.kind === 'reserved') {
      if (item.allocation.subnet !== `10.240.0.${item.allocation.slot * 16}/28`
        || item.allocation.gateway !== `10.240.0.${item.allocation.slot * 16 + 1}`
        || item.binding.identityDigest !== memberIdentityDigest(snapshot, generation.identity, record, item.memberSequence, item.allocation, item.binding.configurationIdentityDigest)) invalid('Member subnet or identity binding is inconsistent');
    } else {
      const originalAllocation = { kind: 'reserved', slot: item.allocation.previousSlot,
        subnet: `10.240.0.${item.allocation.previousSlot * 16}/28`, gateway: `10.240.0.${item.allocation.previousSlot * 16 + 1}` } as const;
      if (!at(item.allocation.releaseSequence) || item.binding.identityDigest !== memberIdentityDigest(snapshot, generation.identity, record,
        item.memberSequence, originalAllocation, item.binding.configurationIdentityDigest)
        || item.roles.some((ledger) => ledger.presence.kind !== 'not_entered' && ledger.presence.kind !== 'absent'
          || [ledger.create, ledger.start, ledger.controlClose, ledger.delete].some((receipt) => receipt.kind === 'pending' || receipt.kind === 'uncertain'))) invalid('Invalid allocation release settlement');
    }
    if (item.projection.kind === 'registered') {
      if (item.projection.digest !== projectionDigest(item.projection) || !sortedUnique(item.projection.facts.vmLinks, (link) => link.index)
        || new Set(item.projection.facts.vmLinks.map((link) => link.name)).size !== item.projection.facts.vmLinks.length) invalid('Invalid projection descriptor');
      const facts = item.projection.facts;
      const network = facts.network;
      if (network !== null && (item.allocation.kind !== 'reserved' || network.subnet !== item.allocation.subnet || network.gateway !== item.allocation.gateway)) invalid('Projection network differs from reserved allocation');
      for (const [resourceRole, resourceId] of [['network', network?.id], ['route_observer', item.projection.facts.observerId],
        ['compute', item.projection.facts.computeNoneId], ['filesystem', item.projection.facts.filesystemNoneId], ['egress_broker', item.projection.facts.broker?.id]]) {
        if (resourceId != null && (!record.resources.some((resource) => resource.role === resourceRole && resource.identity.kind === 'identified' && resource.identity.id === resourceId)
          || !item.roles.some((ledger) => ledger.role === resourceRole && ledger.presence.kind === 'present' && ledger.presence.id === resourceId))) invalid('Projection contains an unowned or absent resource');
      }
      if (network !== null && network.name !== record.resources.find((resource) => resource.role === 'network')?.name) invalid('Projection network name differs from its original role');
      if (facts.broker !== null) {
        const address = Number(facts.broker.address.split('.')[3]);
        const base = item.allocation.kind === 'reserved' ? item.allocation.slot * 16 : -16;
        if (network === null || facts.broker.gateway !== network.gateway || !facts.broker.address.startsWith('10.240.0.')
          || address <= base + 1 || address >= base + 15) invalid('Broker projection requires an address within its reserved network');
      }
      if (item.projection.phase === 'observer_only' && (network !== null || facts.broker !== null || facts.computeNoneId !== null || facts.filesystemNoneId !== null)
        || item.projection.phase === 'bridge_empty' && (network === null || facts.broker !== null)
        || (item.projection.phase === 'broker_created' || item.projection.phase === 'broker_active') && (network === null || facts.broker === null)
        || item.projection.phase === 'retained_empty' && (facts.observerId !== null || facts.computeNoneId !== null || facts.filesystemNoneId !== null || facts.broker !== null)) invalid('Projection phase contradicts its finite facts');
    }
    const { record: omittedRecord, ...checkpointMetadata } = item.checkpoint;
    void omittedRecord;
    if (bytes({ ...item, checkpoint: checkpointMetadata }) > COORDINATOR_JOURNAL_LIMITS.memberMetadataBytes) invalid('Member metadata exceeds its byte capacity');
    const tokens = Object.values(item.work).flatMap((scope) => scope.kind === 'owned' ? [scope.token] : []);
    for (const token of tokens) {
      if (workTokens.has(token)) invalid('Original operation scope tokens cannot be shared');
      workTokens.add(token);
    }
    if (new Set(tokens).size !== tokens.length || generation.state.kind === 'cleanup_only' && tokens.length !== 0) invalid('Invalid operation scope ownership');
    for (const ledger of item.roles) {
      const resource = record.resources.find((candidate) => candidate.role === ledger.role);
      if (resource === undefined) invalid('Missing original role');
      const observed = ledger.presence;
      const returnedCreateAbsent = ledger.create.kind === 'settled' && ledger.create.outcome === 'absent';
      if (observed.kind === 'possibly_present' && observed.returnedId !== null && resource.identity.kind !== 'identified') {
        if (resourceIds.has(observed.returnedId)) invalid('Returned create IDs cannot refer to another original resource');
        resourceIds.add(observed.returnedId);
      }
      if (observed.kind === 'not_entered' && (!at(observed.provedAtSequence) || resource.identity.kind === 'identified')
        || observed.kind === 'possibly_present' && (resource.identity.kind === 'planned' || observed.createEffect >= generation.nextEffectSequence
          || resource.identity.kind === 'identified' && observed.returnedId !== null && observed.returnedId !== resource.identity.id)
        || observed.kind === 'present' && (resource.identity.kind !== 'identified' || observed.id !== resource.identity.id || observed.fingerprint !== resource.identity.fingerprint)
        || observed.kind === 'absent' && (!at(observed.inspectedAtSequence) || !at(observed.noLateProducerAfter) || observed.noLateProducerAfter > observed.inspectedAtSequence
          || (resource.identity.kind === 'identified' ? observed.reference !== resource.identity.id || observed.fingerprint !== resource.identity.fingerprint
            : returnedCreateAbsent ? resource.identity.kind !== 'creating' || observed.fingerprint !== null
              : observed.reference !== resource.name || observed.fingerprint !== null))) invalid('Role presence contradicts the original checkpoint');
      if (observed.kind === 'present' && (['storage', 'network', 'egress_socket'].includes(ledger.role) !== (observed.runtime === 'not_applicable'))) invalid('Runtime state does not apply to this role');
      for (const resourceAction of ['create', 'start', 'control_close', 'delete'] as const) {
        const receipt = ledger[actionCell(resourceAction)];
        if (applicableAction(ledger.role, resourceAction) === (receipt.kind === 'not_applicable')) invalid('Invalid applicable action cell');
        if (receipt.kind === 'not_applicable' || receipt.kind === 'not_entered') continue;
        if (receipt.effect === 0 || receipt.effect >= generation.nextEffectSequence || receipt.kind === 'settled' && !at(receipt.atSequence)) invalid('Action receipt refers to a future sequence');
        const owner = `${item.memberId}/${ledger.role}/${resourceAction}`;
        if (effectOwners.has(receipt.effect) && effectOwners.get(receipt.effect) !== owner) invalid('Effect sequence is owned by multiple actions');
        effectOwners.set(receipt.effect, owner);
        if (receipt.kind === 'pending') pending.push(receipt.effect);
        if (receipt.kind === 'settled' && receipt.outcome !== 'not_dispatched'
          && !((resourceAction === 'start' || resourceAction === 'create') && receipt.outcome === 'absent')
          && receipt.outcome !== ({ create: 'present', start: 'started', control_close: 'control_joined', delete: 'absent' } as const)[resourceAction]) invalid('Action receipt has the wrong outcome');
      }
      if (observed.kind === 'possibly_present' && (ledger.create.kind !== 'pending' && ledger.create.kind !== 'uncertain'
        || ledger.create.effect !== observed.createEffect)) invalid('Possible presence must retain its original create obligation');
      if (observed.kind === 'absent' && resource.identity.kind !== 'identified'
        && ledger.create.kind !== 'not_entered' && !(ledger.create.kind === 'settled'
          && (ledger.create.outcome === 'not_dispatched' || ledger.create.outcome === 'absent'))) invalid('Unresolved create cannot be declared absent by name');
      if ((observed.kind === 'present' || observed.kind === 'absent' && resource.identity.kind === 'identified')
        && (ledger.create.kind !== 'settled' || ledger.create.outcome !== 'present'
          && !(observed.kind === 'absent' && ledger.create.outcome === 'absent'))) invalid('Acquired presence requires its settled original create');
      if (ledger.create.kind === 'settled' && ledger.create.outcome === 'present' && resource.identity.kind !== 'identified'
        || ledger.create.kind === 'settled' && ledger.create.outcome === 'absent' && observed.kind !== 'absent'
        || ledger.delete.kind === 'settled' && ledger.delete.outcome === 'absent' && observed.kind !== 'absent'
        || ledger.start.kind === 'settled' && ledger.start.outcome === 'absent' && observed.kind !== 'absent') invalid('Settled action contradicts its original resource presence');
    }
    if (item.state.kind === 'retained' && (['initialization', 'primary', 'writers'] as const).some((scope) => item.work[scope].kind === 'owned')
      || item.state.kind === 'retained' && item.roles.some((ledger) => ['compute', 'filesystem', 'route_observer', 'egress_broker', 'egress_relay'].includes(ledger.role)
        && (ledger.presence.kind !== 'absent' && ledger.presence.kind !== 'not_entered'
          || [ledger.create, ledger.start, ledger.controlClose, ledger.delete].some((receipt) => receipt.kind === 'pending' || receipt.kind === 'uncertain')))) invalid('Retained member still has a live producer obligation');
  }
  const effects = generation.entered === null ? generation.queue : [...generation.queue, generation.entered];
  if (new Set(effects.map((entry) => entry.effectSequence)).size !== effects.length
    || new Set(effects.map((entry) => `${entry.memberId}/${entry.role}/${entry.action}`)).size !== effects.length) invalid('Queued and entered effects must have distinct original owners');
  if (generation.queue.filter((entry) => entry.action === 'create' || entry.action === 'start').length > COORDINATOR_JOURNAL_LIMITS.ordinaryQueue) invalid('Ordinary queue consumed cleanup reserve');
  for (const effect of effects) {
    const owner = generation.members.find((item) => item.memberId === effect.memberId);
    if (owner === undefined || owner.binding.identityDigest !== effect.bindingDigest || effect.effectSequence === 0 || effect.effectSequence >= generation.nextEffectSequence
      || !at(effect.requestedAtSequence) || bytes(effect) > COORDINATOR_JOURNAL_LIMITS.effectBytes
      || (effect.role === 'member') !== (effect.action === 'member_retire')
      || effect.role !== 'member' && (!owner.roles.some((entry) => entry.role === effect.role) || !applicableAction(effect.role, effect.action))
      || generation.state.kind === 'cleanup_only' && (effect.action === 'create' || effect.action === 'start')) invalid('Effect does not bind a current member action');
    if (generation.queue.includes(effect) && effectOwners.has(effect.effectSequence)
      && (effect.action === 'create' || effect.action === 'start'
        || effectOwners.get(effect.effectSequence) !== `${effect.memberId}/${effect.role}/${effect.action}`)) invalid('Queued effect reuses another action identity');
  }
  const entered = generation.entered;
  if (entered !== null) {
    const owner = generation.members.find((item) => item.memberId === entered.memberId);
    const resource = owner?.checkpoint.record.resources.find((item) => item.role === entered.role);
    if (owner === undefined || resource === undefined || entered.role === 'member' || entered.action === 'member_retire'
      || entered.checkpointRevision !== owner.checkpoint.revision || entered.checkpointDigest !== owner.checkpoint.digest
      || !at(entered.armedAtSequence) || entered.armedAtSequence < entered.requestedAtSequence
      || entered.reference !== (resource.identity.kind === 'identified' ? resource.identity.id : resource.name)
      || (entered.action === 'create' ? resource.identity.kind !== 'creating' : resource.identity.kind !== 'identified')
      || entered.transitionRecipe !== `desktop-member-projection-v1/${entered.role}/${entered.action}`
      || entered.result.kind === 'returned' && entered.action !== 'create') invalid('Invalid armed effect binding');
    if (entered.action === 'create') {
      const observed = owner.roles.find((ledger) => ledger.role === entered.role)?.presence;
      if (observed?.kind !== 'possibly_present' || observed.returnedId !== (entered.result.kind === 'returned' ? entered.result.id : null)) invalid('Armed create must preserve its exact returned ID');
    }
    if (pending.length !== 1 || pending[0] !== entered.effectSequence) invalid('Entered effect must own the sole pending action cell');
  } else if (pending.length !== 0) invalid('Pending action cell has no entered owner');
  for (const retired of generation.retired) {
    if (!at(retired.retiredAtSequence) || bytes(tombstoneWire(retired)) > COORDINATOR_JOURNAL_LIMITS.tombstoneBytes) invalid('Invalid retirement tombstone');
  }
  const { members: omittedMembers, queue: omittedQueue, entered: omittedEntered, retired: omittedRetired, ...generationEnvelope } = generation;
  void omittedMembers; void omittedQueue; void omittedEntered; void omittedRetired;
  if (bytes({ ...snapshot, generation: generationEnvelope }) > COORDINATOR_JOURNAL_LIMITS.envelopeBytes) invalid('Coordinator envelope exceeds its byte capacity');
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function parseCoordinatorSnapshot(text: string): CoordinatorSnapshot {
  if (typeof text !== 'string' || !text.isWellFormed()
    || Buffer.byteLength(text, 'utf8') + COORDINATOR_JOURNAL_LIMITS.nativeHeaderBytes > COORDINATOR_JOURNAL_LIMITS.framedBytes) invalid('Coordinator snapshot exceeds its framed byte capacity');
  let input: unknown;
  try { input = JSON.parse(text); } catch { invalid('Coordinator snapshot must be complete JSON'); }
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) invalid('Coordinator snapshot does not match the closed v1 schema');
  validateSnapshot(parsed.data);
  return freeze(parsed.data);
}

export function encodeCoordinatorSnapshot(snapshot: CoordinatorSnapshot): string {
  const parsed = parseCoordinatorSnapshot(JSON.stringify(wireSnapshot(snapshot)));
  const text = JSON.stringify(wireSnapshot(parsed));
  if (Buffer.byteLength(text, 'utf8') + COORDINATOR_JOURNAL_LIMITS.nativeHeaderBytes > COORDINATOR_JOURNAL_LIMITS.framedBytes) invalid('Coordinator snapshot exceeds its framed byte capacity');
  return text;
}

export function snapshotDigest(snapshot: CoordinatorSnapshot): string {
  return coordinatorDigest('agenai.desktop-coordinator.snapshot.v1', encodeCoordinatorSnapshot(snapshot));
}
