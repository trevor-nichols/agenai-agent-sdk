import { selectAllocation } from './allocation.js';

export const LIMITS = Object.freeze({ members: 4, queuedTransitions: 16, enteredEffects: 1,
  effectMs: 30_000, observationMs: 10_000, pollMs: 1000, freshnessMs: 45_000,
  heartbeatMs: 1000, leaseMs: 60_000, commandMs: 5000, journalBytes: 512 * 1024,
  memberBytes: 32 * 1024, transitionBytes: 4096, tombstones: 256 });

type EffectPhase = 'queued' | 'resource_intent' | 'transition_intent' | 'entered' | 'uncertain'
  | 'identified' | 'member_checkpoint' | 'settled' | 'cancel_pending' | 'cancelled';
interface Transition { readonly id: number; readonly member: string; readonly resource: string;
  phase: EffectPhase; caller: 'waiting' | 'cancelled'; returnedId: string | null }
interface Member { readonly id: string; readonly subnet: string; readonly gateway: string;
  state: 'reserved' | 'active' | 'retained' | 'cleanup_pending'; observer: 'healthy' | 'absent'; resources: Set<string> }

export type FailureFacts = Readonly<{ kind: 'member'; member: string; topology: 'known_stable' | 'unresolved'; independentCensus: boolean }>
  | Readonly<{ kind: 'shared' }>;

/** In-memory decision model. Calls named persist represent successful persistence, not I/O receipts. */
export class TransitionModel {
  readonly members = new Map<string, Member>();
  readonly transitions = new Map<number, Transition>();
  readonly trace: string[] = [];
  mode: 'open' | 'quiescent' | 'fenced' = 'quiescent';
  dirty = false;
  private nextId = 0;
  private slot: number | null = null;
  private lastObservation = 0;
  private lastEffectStarted = 0;
  private mustObserve = true;
  private tombstones = 0;
  private bootstrapMember: string | null = null;

  persistMember(id: string, externalOccupancy: readonly string[] = []): void {
    if (this.mode === 'fenced') throw new Error('Group admission is fenced.');
    if (this.members.has(id) || this.members.size >= LIMITS.members) throw new Error('Member capacity exhausted before dispatch.');
    const allocation = selectAllocation(externalOccupancy, [...this.members.values()].map((member) => member.subnet), [[]]);
    this.members.set(id, { id, ...allocation, state: 'reserved', observer: 'absent', resources: new Set() });
    this.dirty = true; this.trace.push(`durable-member:${id}:${allocation.subnet}`);
  }

  enqueue(member: string, resource: string): number {
    if (this.mode === 'fenced') throw new Error('Group admission is fenced.');
    if (!this.members.has(member)) throw new Error('Member intent must be durable before a resource intent.');
    if (this.mode === 'quiescent' && (this.bootstrapMember !== member || !['observer-create', 'observer-start'].includes(resource))) {
      throw new Error('Zero-observer admission permits only registered replacement observer effects.');
    }
    if (this.transitions.size - (this.slot === null ? 0 : 1) >= LIMITS.queuedTransitions
      || this.tombstones >= LIMITS.tombstones) throw new Error('Transition capacity exhausted before dispatch.');
    const id = ++this.nextId;
    this.transitions.set(id, { id, member, resource, phase: 'queued', caller: 'waiting', returnedId: null });
    return id;
  }

  next(now: number): 'observe' | number | null {
    if (this.slot !== null || this.mode === 'fenced') return null;
    if (this.mode === 'quiescent' && this.bootstrapMember === null) return null;
    if (!(this.mode === 'quiescent' && this.bootstrapMember !== null)
      && (this.mustObserve || now - this.lastObservation >= LIMITS.pollMs)) return 'observe';
    const entry = [...this.transitions.values()].find((candidate) => candidate.phase === 'queued');
    if (!entry) return null;
    this.slot = entry.id; this.lastEffectStarted = now; return entry.id;
  }

  persistResourceIntent(id: number): void { this.advance(id, 'queued', 'resource_intent'); }
  persistTransitionIntent(id: number): void { this.advance(id, 'resource_intent', 'transition_intent'); }
  dispatch(id: number): void {
    this.advance(id, 'transition_intent', 'entered'); this.trace.push(`dispatch:${id}`);
  }

  returned(id: number, resourceId: string): void {
    const entry = this.entry(id);
    if (entry.phase !== 'entered' && entry.phase !== 'uncertain') throw new Error('Effect was not entered.');
    entry.returnedId = resourceId; entry.phase = 'identified';
    this.member(entry.member).resources.add(resourceId); this.trace.push(`returned:${id}:${resourceId}`);
  }

  persistMemberResult(id: number): void { this.advance(id, 'identified', 'member_checkpoint'); }
  persistSettlement(id: number): void {
    this.advance(id, 'member_checkpoint', 'settled'); this.release(id);
  }

  cancel(id: number): void {
    const entry = this.entry(id); entry.caller = 'cancelled';
    if (entry.phase === 'queued' || entry.phase === 'resource_intent' || entry.phase === 'transition_intent') entry.phase = 'cancel_pending';
    this.trace.push(`caller-cancel:${id}`);
  }

  persistUndispatchedCancellation(id: number): void {
    this.advance(id, 'cancel_pending', 'cancelled');
    if (this.slot === id) this.release(id); else { this.transitions.delete(id); this.tombstones += 1; }
  }

  deadline(now: number): void {
    if (this.slot !== null && now - this.lastEffectStarted >= LIMITS.effectMs) {
      const entry = this.entry(this.slot);
      if (entry.phase === 'entered') entry.phase = 'uncertain';
      this.mode = 'fenced'; this.trace.push('group-fence:effect-deadline');
    }
    if (now - this.lastObservation >= LIMITS.freshnessMs) { this.mode = 'fenced'; this.trace.push('group-fence:stale-authority'); }
  }

  observe(start: number, finish: number, valid: boolean): void {
    if (this.slot !== null) throw new Error('Complete observations and topology dispatch use one sequence.');
    if (this.observationPath() === null) throw new Error('No live path can supply a complete VM observation.');
    if (!valid || finish - start > LIMITS.observationMs) {
      this.mode = 'fenced'; this.trace.push('group-fence:observation'); return;
    }
    this.lastObservation = finish; this.mustObserve = false;
    if (this.mode !== 'fenced') this.mode = [...this.members.values()].some((member) => member.observer === 'healthy') ? 'open' : 'quiescent';
    this.trace.push(`observe:${finish}`);
  }

  activate(id: string): void {
    if (this.mode === 'fenced') throw new Error('Group admission is fenced.');
    const member = this.member(id); member.state = 'active'; member.observer = 'healthy'; this.mode = 'open';
  }

  stop(id: string): void {
    const member = this.member(id); member.state = 'retained'; member.observer = 'absent';
    if (![...this.members.values()].some((candidate) => candidate.observer === 'healthy') && this.mode !== 'fenced') this.mode = 'quiescent';
  }

  failure(facts: FailureFacts): 'member' | 'group' {
    if (facts.kind === 'shared' || facts.topology === 'unresolved' || !facts.independentCensus
      || !this.observationPath(facts.member)) {
      this.mode = 'fenced'; this.trace.push('group-fence:authority-loss'); return 'group';
    }
    const member = this.member(facts.member); member.state = 'cleanup_pending'; member.observer = 'absent';
    return 'member';
  }

  // Cleanup requires original daemon/ID authority; route authority is deliberately not an input.
  confirmRemoved(memberId: string, resourceId: string, sameDaemon: boolean, exactAbsence: boolean): void {
    if (!this.member(memberId).resources.has(resourceId)) throw new Error('Cleanup cannot act on an unrecorded resource identity.');
    if (!sameDaemon || !exactAbsence) throw new Error('Exact cleanup authority or absence is unavailable.');
    this.member(memberId).resources.delete(resourceId); this.trace.push(`absent:${resourceId}`);
  }

  retire(id: string): void {
    const member = this.member(id);
    if (member.resources.size || [...this.transitions.values()].some((entry) => entry.member === id)) throw new Error('Member retains entered or recorded obligations.');
    this.members.delete(id);
  }

  bootstrapObserver(id: string, sameDaemon: boolean, preflightValid: boolean, retainedEngineValid: boolean): void {
    if (this.mode !== 'quiescent' || this.bootstrapMember !== null || !sameDaemon || !preflightValid || !retainedEngineValid) {
      throw new Error('Zero-observer re-entry requires exact Engine, host and retained network authority.');
    }
    // This authorizes queueing a new observer intent only, never compute or an old member replay.
    if (!this.members.has(id)) throw new Error('New observer member must be registered.');
    this.bootstrapMember = id;
    this.trace.push(`bootstrap-observer-only:${id}`);
  }

  completeBootstrap(id: string, completeRetainedVmValid: boolean): void {
    if (this.mode === 'fenced') throw new Error('Group admission is fenced.');
    if (this.bootstrapMember !== id || this.slot !== null || !completeRetainedVmValid) {
      this.mode = 'fenced'; throw new Error('Replacement observer did not prove complete retained VM authority.');
    }
    this.member(id).observer = 'healthy'; this.bootstrapMember = null; this.mode = 'open'; this.mustObserve = true;
  }

  observationPath(excludedMember?: string): string | null {
    return [...this.members.values()].find((member) => member.id !== excludedMember && member.observer === 'healthy')?.id ?? null;
  }

  work(id: string, kind: 'reader' | 'file' | 'tls' | 'heartbeat'): void {
    if (this.mode !== 'open' || this.member(id).state !== 'active') throw new Error('Member work admission is closed.');
    this.trace.push(`${kind}:${id}`);
  }

  close(physicalEffectsJoined: boolean): void {
    if (this.members.size || this.transitions.size || !physicalEffectsJoined) throw new Error('Dirty generation retains obligations.');
    this.dirty = false; this.trace.push('clear-dirty-generation');
  }

  private entry(id: number): Transition {
    const entry = this.transitions.get(id); if (!entry) throw new Error('Unknown transition.'); return entry;
  }
  private member(id: string): Member {
    const member = this.members.get(id); if (!member) throw new Error('Unknown member.'); return member;
  }
  private advance(id: number, expected: EffectPhase, phase: EffectPhase): void {
    const entry = this.entry(id);
    if (entry.phase !== expected || this.slot !== id && expected !== 'cancel_pending') throw new Error(`Transition cannot advance from ${entry.phase}.`);
    entry.phase = phase; this.trace.push(`${phase}:${id}`);
  }
  private release(id: number): void {
    this.transitions.delete(id); this.tombstones += 1; this.slot = null; this.mustObserve = true;
  }
}
