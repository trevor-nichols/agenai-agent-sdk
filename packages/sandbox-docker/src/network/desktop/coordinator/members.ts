import { SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import { configurationDigest } from '../../../recovery/identity.js';
import { configurationBackendRevision } from '../../../recovery/identity.js';
import type { CoordinatorEvent } from './journal/plans.js';
import type { CoordinatorSnapshot } from './journal/schema.js';
import { createDesktopCoordinatorMemberEffects } from './memberEffects.js';
import type { DesktopCoordinatorMember, DesktopCoordinatorMemberJournal, DesktopCoordinatorMemberOwner } from './member.js';
import type { DesktopCoordinatorSequence } from './sequence.js';
import { DesktopCoordinatorSequence as CleanupSequence } from './sequence.js';
import type { DesktopCoordinatorTopologyOwner } from './topologyOwner.js';

export interface DesktopCoordinatorGroupOwner {
  readonly ordering: DesktopCoordinatorSequence;
  readonly topology: DesktopCoordinatorTopologyOwner;
  readonly fenced: Promise<void>;
  snapshot(): CoordinatorSnapshot;
  apply(event: CoordinatorEvent, boundary: 'member' | 'transition' | 'settlement'): Promise<void>;
  assertAdmission(): void;
  assertAuthority(kind: 'growth' | 'cleanup', signal?: AbortSignal): Promise<void>;
  isFenced(): boolean;
  fence(cause: unknown): void;
  observed(): void;
}

interface MemberOwner {
  readonly source: DesktopCoordinatorMemberOwner;
  readonly member: DesktopCoordinatorMember;
}

export class DesktopCoordinatorMembers {
  private readonly members = new Map<string, MemberOwner>();
  private readonly conservative = new CleanupSequence();
  private readonly cleanups = new Set<Promise<void>>();

  constructor(private readonly owner: DesktopCoordinatorGroupOwner) {}

  settle(): Promise<void> {
    return Promise.all([...this.cleanups]).then(() => {});
  }

  private async trackCleanup<Value>(perform: () => Promise<Value>): Promise<Value> {
    const completion = Promise.withResolvers<void>();
    // Register before dispatch, including member-local queues and later conservative handoffs.
    this.cleanups.add(completion.promise);
    try { return await perform(); }
    finally { this.cleanups.delete(completion.promise); completion.resolve(); }
  }

  enroll(source: DesktopCoordinatorMemberOwner, signal?: AbortSignal): Promise<DesktopCoordinatorMember> {
    return this.owner.ordering.run('ordinary', async () => {
      this.owner.assertAdmission();
      const record = source.record();
      const config = source.config;
      if (config.coordination === undefined) throw new SandboxStateError('Coordinated member configuration is required.');
      const current = this.owner.snapshot();
      if (current.generation.kind !== 'dirty' || config.coordination.authorityId !== current.authorityId
        || config.coordination.generation.generationId !== current.generation.identity.generationId) {
        throw new SandboxStateError('Member configuration belongs to another original coordinator generation.');
      }
      const allocation = await this.owner.topology.selectAllocation(signal);
      this.owner.assertAdmission();
      signal?.throwIfAborted();
      const backendRevision = configurationBackendRevision(config);
      const binding = config.profile === 'desktop-apple-virtualization-native-arm64'
        ? { profile: config.profile, backendRevision: 'engine-1.52-v7-desktop-apple-virtualization-native-arm64' as const, configurationIdentityDigest: configurationDigest(config) }
        : { profile: config.profile, backendRevision: 'engine-1.52-v7-desktop-apple-virtualization-rosetta-amd64' as const, configurationIdentityDigest: configurationDigest(config) };
      if (record.backendRevision !== backendRevision) throw new SandboxStateError('Member revision differs from its original configuration.');
      this.owner.topology.addMember({ memberId: record.operationId, config, record: () => source.record() }, allocation);
      const member = createDesktopCoordinatorMemberEffects(this.journal(source, allocation), source);
      try { await this.owner.apply({ kind: 'register', record, binding, slot: allocation.slot }, 'member'); }
      catch (cause) {
        const observed = this.owner.snapshot().generation;
        if (observed.kind === 'dirty' && observed.members.some((entry) => entry.memberId === record.operationId)) {
          this.members.set(record.operationId, { source, member });
          source.enrolled(member);
          member.closeAdmission();
        } else this.owner.topology.retire(record.operationId);
        throw cause;
      }
      this.members.set(record.operationId, { source, member });
      source.enrolled(member);
      await this.owner.apply({ kind: 'member_state', memberId: record.operationId, state: { kind: 'starting' } }, 'member');
      return member;
    }, { signal });
  }

  failed(cause: unknown): void {
    const error = cause instanceof SandboxOperationError ? cause
      : new SandboxOperationError('driver_failure', 'The shared Desktop coordinator authority was lost.', { cause });
    for (const { member, source } of this.members.values()) {
      member.closeAdmission();
      source.failed(error);
    }
  }

  private journal(source: DesktopCoordinatorMemberOwner, allocation: DesktopCoordinatorMemberJournal['allocation']): DesktopCoordinatorMemberJournal {
    const owner = this.owner;
    const memberId = source.record().operationId;
    const group = this;
    let cleanup: { entered: boolean; completed: boolean; cancel: AbortController } | undefined;
    let closed = false;
    return {
      memberId, allocation,
      get census() { return owner.topology.census(memberId); },
      snapshot: () => owner.snapshot(),
      trackCleanup: (perform) => this.trackCleanup(perform),
      apply: async (event, boundary) => {
        await owner.apply(event, boundary);
        if (event.kind === 'retire') {
          if (!owner.isFenced()) owner.topology.retire(memberId);
          group.members.delete(memberId);
        }
      },
      run: (kind, perform, signal) => {
        const originalCleanup = kind === 'cleanup' ? cleanup : undefined;
        const queuedSignal = originalCleanup ? originalCleanup.cancel.signal : signal;
        return owner.ordering.run(kind, async () => {
          if (owner.isFenced()) throw new SandboxStateError('A fenced coordinator admits only conservative original cleanup.');
          if (kind === 'ordinary' && closed) throw new SandboxStateError('Original member growth is closed.');
          if (originalCleanup) originalCleanup.entered = true;
          return perform();
        }, { signal: queuedSignal });
      },
      runCleanup: async (canonical, conservative) => {
        const runConservative = () => group.conservative.run('cleanup', async () => {
          await owner.assertAuthority('cleanup');
          return conservative();
        });
        if (owner.isFenced()) return runConservative();
        if (cleanup) throw new SandboxStateError('An original member cleanup operation is already pending.');
        const attempt = { entered: false, completed: false, cancel: new AbortController() };
        cleanup = attempt;
        const actual = canonical().finally(() => { attempt.completed = true; if (cleanup === attempt) cleanup = undefined; });
        void actual.catch(() => {});
        const fenced = owner.fenced.then(async () => {
          if (attempt.entered || attempt.completed) return actual;
          attempt.cancel.abort();
          await actual.catch(() => {});
          return runConservative();
        });
        const result = actual.catch((cause: unknown) => {
          if (owner.isFenced() && !attempt.entered) return fenced;
          throw cause;
        });
        return Promise.race([result, fenced]);
      },
      assertAuthority: async (kind, signal) => {
        if (kind === 'growth' && closed) throw new SandboxStateError('Original member growth is closed.');
        await owner.assertAuthority(kind, signal);
      },
      before: async (role, action, signal) => {
        signal?.throwIfAborted();
        try {
          const digest = await owner.topology.before(memberId, role, action);
          owner.observed();
          return digest;
        } catch (cause) { owner.fence(cause); throw cause; }
      },
      after: async (role, action, inspection) => {
        try {
          const observation = await owner.topology.after(memberId, role, action, inspection);
          owner.observed();
          return observation;
        } catch (cause) { owner.fence(cause); throw cause; }
      },
      observer: (id, client) => owner.topology.observer(memberId, id, client),
      closeAdmission: () => { closed = true; },
      controlFailed: (role, error) => {
        const notify = !closed;
        closed = true;
        let independent: boolean;
        try { independent = owner.topology.releaseControl(memberId, role); }
        catch (cause) { owner.fence(cause); return; }
        if (!notify) return;
        if (!independent) {
          owner.fence(error);
          return;
        }
        const proof = owner.ordering.run('cleanup', async () => {
          if (owner.isFenced()) throw new SandboxStateError('A failed control cannot restore shared Desktop authority.');
          await owner.assertAuthority('growth');
          await owner.topology.assertCurrent();
          owner.observed();
        });
        void proof.catch((cause: unknown) => owner.fence(cause));
        source.failed(error);
      },
      fence: (cause) => owner.fence(cause),
      isFenced: () => owner.isFenced(),
      stopped: () => owner.ordering.run('cleanup', () => owner.topology.stopped(memberId)),
    };
  }
}
