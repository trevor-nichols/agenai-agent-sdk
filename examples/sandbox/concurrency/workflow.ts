import assert from 'node:assert/strict';
import { validateConcurrentOptions } from './validation.js';
import { ConcurrentMember } from './member.js';
import type {
  ConcurrentCleanupFailure, ConcurrentContinuity, ConcurrentMemberInput, ConcurrentMemberLabel, ConcurrentOwnedMember,
  ConcurrentWorkflowObservation, ConcurrentWorkflowOptions, ConcurrentWorkflowPhase, ConcurrentWorkflowResult,
} from './types.js';

export class ConcurrentSandboxWorkflowError extends AggregateError {
  constructor(
    readonly primaryFailure: Readonly<{ error: unknown }>,
    readonly cleanupFailures: readonly ConcurrentCleanupFailure[],
    readonly ownedMembers: readonly ConcurrentOwnedMember[],
    readonly retryCleanup: () => Promise<void>,
  ) {
    super([primaryFailure.error, ...cleanupFailures.map(({ error }) => error)],
      'Concurrent sandbox workflow failed; original failures, readers and cleanup ownership are retained.');
    this.name = 'ConcurrentSandboxWorkflowError';
  }
}

/** Two independent owners, original primaries/readers, per-member policy and stopped project exports. */
export async function runConcurrentSandboxWorkflow(options: ConcurrentWorkflowOptions): Promise<ConcurrentWorkflowResult> {
  validateConcurrentOptions(options);
  const state = options.coordinator.state; assert.equal(state.kind, 'active');
  if (state.kind !== 'active') throw new Error('Original coordinator is no longer active.');
  const generation = state.generation;
  const members: ConcurrentMember[] = [];
  let sequence = 0;

  const observe = async (phase: ConcurrentWorkflowPhase, member?: ConcurrentMember, continuity?: ConcurrentContinuity,
    checkpoint?: string, label?: ConcurrentMemberLabel) => {
    const observation: ConcurrentWorkflowObservation = {
      sequence: ++sequence, phase, member: member?.label ?? label ?? null, sandboxId: member?.owner.id ?? null,
      processId: member?.processId ?? null, readerId: member?.readerId ?? null, coordinator: options.coordinator.state,
      recoveryRecord: member?.owner.recoveryRecord ?? null, ...(continuity ? { continuity } : {}), ...(checkpoint ? { checkpoint } : {}),
    };
    await options.onObservation?.(observation);
  };
  const check = async (member: ConcurrentMember, peer: ConcurrentMemberInput, checkpoint: string) => {
    options.signal?.throwIfAborted();
    await observe('continuity_before', member, undefined, checkpoint);
    const continuity = await member.continuity(peer.positive, options.signal);
    await observe('continuity', member, continuity, checkpoint);
  };
  const reserve = async (label: ConcurrentMemberLabel, input: ConcurrentMemberInput): Promise<ConcurrentMember> => {
    options.signal?.throwIfAborted();
    await observe('reserve_before', undefined, undefined, undefined, label);
    const member = new ConcurrentMember(label, input, options); members.push(member);
    assert.equal(new Set(members.map(({ owner }) => owner.id)).size, members.length, 'An independent owner reused a sandbox identity.');
    await observe('reserved', member); return member;
  };
  const transition = async (before: ConcurrentWorkflowPhase, after: ConcurrentWorkflowPhase, member: ConcurrentMember,
    operation: () => Promise<void>, peer?: ConcurrentMember) => {
    options.signal?.throwIfAborted();
    if (peer) await check(peer, member.input, member.label + ':' + before + ':before');
    await observe(before, member);
    const entered = operation();
    void entered.catch(() => {});
    const work = peer ? check(peer, member.input, member.label + ':' + before + ':entered') : Promise.resolve();
    const [effect, continuity] = await Promise.allSettled([entered, work]);
    if (effect.status === 'rejected' && continuity.status === 'rejected') {
      throw new AggregateError([effect.reason, continuity.reason], 'Member transition and original peer continuity both failed.');
    }
    if (effect.status === 'rejected') throw effect.reason;
    if (continuity.status === 'rejected') throw continuity.reason;
    await observe(after, member);
    if (peer) await check(peer, member.input, member.label + ':' + after + ':after');
  };
  const prepare = (member: ConcurrentMember, peer?: ConcurrentMember) =>
    transition('prepare_before', 'prepared', member, () => member.prepare(), peer);
  const dispatch = (member: ConcurrentMember, peer?: ConcurrentMember) =>
    transition('dispatch_before', 'dispatched', member, () => member.dispatch(), peer);
  const remove = async (member: ConcurrentMember, peer?: ConcurrentMember) => {
    await transition('cancel_before', 'cancelled', member, () => member.cancel(), peer);
    await transition('stop_before', 'stopped', member, () => member.stop(), peer);
    await transition('export_before', 'exported', member, () => member.exportProject(), peer);
    await transition('destroy_before', 'destroyed', member, () => member.destroy(), peer);
  };
  const cleanup = async (): Promise<readonly ConcurrentCleanupFailure[]> => {
    const failures: ConcurrentCleanupFailure[] = [];
    for (const member of [...members].reverse()) failures.push(...await member.cleanup());
    return failures;
  };

  try {
    let a: ConcurrentMember; let b: ConcurrentMember;
    if (options.startMode === 'prepare_both') {
      a = await reserve('a', options.members[0]); b = await reserve('b', options.members[1]);
      await prepare(a); await prepare(b); await dispatch(a); await dispatch(b, a);
    } else {
      a = await reserve('a', options.members[0]); await prepare(a); await dispatch(a);
      await check(a, options.members[1], 'a:before-staged-addition');
      b = await reserve('b', options.members[1]); await prepare(b, a); await dispatch(b, a);
    }
    assert.notEqual(a.session.identity.session, b.session.identity.session);
    assert.notEqual(a.session.identity.networkNamespace, b.session.identity.networkNamespace);
    assert.notEqual(a.readerId, b.readerId);
    await check(a, b.input, 'both-initial:a'); await check(b, a.input, 'both-initial:b');
    await transition('mutation_before', 'mutated', a, () => a.mutate(), b);
    await check(a, b.input, 'a:own-mutation'); await check(b, a.input, 'b:peer-still-initial');
    await transition('mutation_before', 'mutated', b, () => b.mutate(), a);
    await check(b, a.input, 'b:own-mutation'); await check(a, b.input, 'a:peer-mutation-isolated');
    const first = options.removalOrder[0] === 'a' ? a : b;
    const survivor = options.removalOrder[1] === 'a' ? a : b;
    await remove(first, survivor);
    await observe('replacement_before', undefined, undefined, 'survivor:' + survivor.label, 'c');
    const c = await reserve('c', options.replacement);
    await prepare(c, survivor);
    assert(!first.owner.recoveryRecord.resources.some((old) =>
      old.identity.kind === 'identified' && c.owner.recoveryRecord.resources.some((next) =>
        next.identity.kind === 'identified' && old.identity.kind === 'identified' && next.identity.id === old.identity.id)),
    'Replacement reused an original resource identity.');
    await dispatch(c, survivor);
    await observe('replacement_ready', c);
    await transition('mutation_before', 'mutated', c, () => c.mutate(), survivor);
    await check(c, survivor.input, 'replacement:own-mutation'); await check(survivor, c.input, 'survivor:replacement-active');
    await remove(survivor, c); await remove(c);
    const completed = options.coordinator.state;
    assert.equal(completed.kind, 'active');
    if (completed.kind === 'active') { assert.equal(completed.generation, generation); assert.equal(completed.members.length, 0); }
    await observe('completed');
    return { startMode: options.startMode, removalOrder: options.removalOrder, generation,
      members: await Promise.all(members.map((member) => member.result())), observations: sequence };
  } catch (error) {
    const failures: ConcurrentCleanupFailure[] = [];
    if (options.coordinator.state.kind === 'active') {
      for (const member of members.filter(({ owner, readerId }) => owner.state.kind === 'ready' && readerId !== null)) {
        const peer = members.find((candidate) => candidate !== member && candidate.input.positive.hostname !== member.input.positive.hostname)
          ?? (member.label === 'b' ? { input: options.members[0] } : { input: options.members[1] });
        try {
          await observe('cleanup_continuity_before', member, undefined, 'failure:surviving-original-primary');
          const continuity = await member.continuity(peer.input.positive);
          await observe('cleanup_continuity', member, continuity, 'failure:surviving-original-primary');
        } catch (continuityError) { failures.push({ member: member.label, operation: 'continuity', error: continuityError }); }
      }
    }
    failures.push(...await cleanup());
    const retryCleanup = async () => {
      const retry = await cleanup();
      const retained = retry.filter(({ operation }) => operation === 'destroy' || operation === 'export_directory'
        || operation === 'reader_settlement' || operation === 'entered_operation_settlement');
      if (retained.length) throw new AggregateError(retained.map(({ error: failure }) => failure), 'Original member cleanup remains owned.');
    };
    throw new ConcurrentSandboxWorkflowError({ error }, Object.freeze([...failures]),
      Object.freeze(members.map(({ label, owner }) => ({ label, owner }))), retryCleanup);
  }
}
