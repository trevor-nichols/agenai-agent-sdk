import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../../../policy/config.js';
import type { DockerApi } from '../../../resources/api.js';
import type { ResourceInspection } from '../../../resources/inspect.js';
import type { DockerDesktopRouteAuthorityBinding } from '../../routeAuthority.js';
import type { DesktopRouteCensus } from '../acquisition.js';
import type { DesktopVmObserverClient } from '../client.js';
import { captureDesktopCompleteObservation } from '../observation/complete.js';
import type { DesktopCompleteObservation } from '../observation/complete.js';
import { observationFingerprint } from '../observation/engine.js';
import type { DesktopEngineNetworkCensus } from '../observation/engine.js';
import type { DesktopHostAuthorityObservation } from '../observation/host.js';
import { requireSameAuthority } from '../topology.js';
import { selectDesktopAllocation, requireDesktopAllocationAvailable, requireDesktopAllocationDenied } from './allocation.js';
import type { DesktopAllocation } from './allocation.js';
import { captureDesktopActiveGraph, captureDesktopRetainedState, projectDesktopEngineExternal, projectDesktopExternal,
  validateDesktopProjectionCandidate } from './projection.js';
import type { DesktopExternalProjection, DesktopMemberProjection, DesktopMemberGraphReceipt } from './projection.js';
import { beginDesktopRemoval, observeDesktopMemberEffect, releaseDesktopMemberControls } from './topologyMember.js';
import { desktopJournalProjection } from './projectionJournal.js';
import type { DesktopCoordinatorControlledRole, DesktopCoordinatorEffectObservation } from './member.js';
import { DESKTOP_COORDINATOR_POLICY } from './policy.js';
import { coordinatorDigest } from './journal/schema.js';
import type { AuthorityBasis, ResourceAction, ResourceRole } from './journal/schema.js';

interface EngineObservation { readonly host: DesktopHostAuthorityObservation; readonly engine: DesktopEngineNetworkCensus }
interface MemberSource { readonly memberId: string; readonly config: DockerSandboxConfig; record(): SandboxRecoveryRecord }
interface Member {
  readonly source: MemberSource;
  readonly inspections: Map<ResourceRole, ResourceInspection | undefined>;
  readonly released: Set<ResourceRole>;
  projection: DesktopMemberProjection;
  observer?: Readonly<{ id: string; client: DesktopVmObserverClient }>;
  observerClosing: boolean;
  stopped: boolean;
  lockedExclusions?: readonly string[];
}
interface Pending {
  readonly memberId: string; readonly role: ResourceRole; readonly action: ResourceAction;
  readonly projection: DesktopMemberProjection;
}

export interface DesktopCoordinatorTopologyOptions {
  readonly api: DockerApi;
  readonly binding: DockerDesktopRouteAuthorityBinding;
  readonly initial: EngineObservation;
  assertEndpoint(signal: AbortSignal): Promise<void>;
  captureEngineBaseline(signal?: AbortSignal): Promise<EngineObservation>;
}

export class DesktopCoordinatorTopologyOwner {
  private readonly members = new Map<string, Member>();
  private readonly initialEngine: ReturnType<typeof projectDesktopEngineExternal>;
  private external: DesktopExternalProjection | undefined;
  private latest: DesktopCompleteObservation | undefined;
  private lastEngine: EngineObservation;
  private receipts: readonly DesktopMemberGraphReceipt[] = [];
  private pending: Pending | undefined;
  private finalObserverClosing = false;

  constructor(private readonly options: DesktopCoordinatorTopologyOptions) {
    this.initialEngine = projectDesktopEngineExternal(options.initial.engine, []);
    this.lastEngine = options.initial;
  }

  get observationKind(): 'host_engine_only' | 'full' | 'quiescent' {
    return this.availableObserver() ? 'full' : this.external ? 'quiescent' : 'host_engine_only';
  }

  async selectAllocation(signal?: AbortSignal): Promise<DesktopAllocation> {
    signal?.throwIfAborted();
    await this.assertCurrent();
    return selectDesktopAllocation({ host: this.lastEngine.host, engine: this.lastEngine.engine,
      ...(this.latest ? { vm: this.latest.vmAfter } : {}), occupiedSlots: this.projections().map((member) => member.allocation.slot),
      liveBrokerExclusions: this.exclusions() });
  }

  addMember(source: MemberSource, allocation: DesktopAllocation): void {
    if (this.members.has(source.memberId) || this.members.size >= 4
      || [...this.members.values()].some((member) => member.projection.allocation.slot === allocation.slot)
      || source.record().operationId !== source.memberId) throw new SandboxStateError('Desktop topology member binding or capacity is invalid.');
    this.members.set(source.memberId, { source, inspections: new Map(), released: new Set(), observerClosing: false, stopped: false,
      projection: { memberId: source.memberId, allocation, observer: { kind: 'absent' },
        none: { compute: { kind: 'absent' }, filesystem: { kind: 'absent' } }, bridge: { kind: 'absent' } } });
    this.checkRetention();
  }

  observer(memberId: string, id: string, client: DesktopVmObserverClient): void {
    const member = this.member(memberId);
    if (member.observer) throw new SandboxStateError('Desktop member observer ownership is once-only.');
    const resource = member.source.record().resources.find((entry) => entry.role === 'route_observer');
    if (resource?.identity.kind !== 'identified' || resource.identity.id !== id) throw new SandboxStateError('Desktop observer differs from its original member resource.');
    member.observer = Object.freeze({ id, client });
  }

  releaseControl(memberId: string, role: DesktopCoordinatorControlledRole): boolean {
    const member = this.member(memberId);
    member.observerClosing = true;
    member.released.add(role);
    member.projection = releaseDesktopMemberControls(member.projection, member.released);
    return this.availableObserver() !== undefined;
  }

  async before(memberId: string, role: ResourceRole, action: ResourceAction, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const member = this.member(memberId);
    await this.assertCurrent();
    if (role === 'network' && action === 'create') {
      if (!this.latest || !this.external) throw new SandboxStateError('Desktop network creation requires original full VM authority.');
      requireDesktopAllocationAvailable(member.projection.allocation, { ...this.lastEngine, vm: this.latest.vmAfter },
        this.projections().filter((entry) => entry.memberId !== memberId).map((entry) => entry.allocation.slot));
      requireDesktopAllocationDenied(member.projection.allocation, this.exclusions());
    }
    const projection = beginDesktopRemoval(member.projection, role, action, this.latest);
    if (role === 'route_observer' && (action === 'control_close' || action === 'delete') && !this.availableObserver(memberId)) {
      if (this.hasProducers()) throw new SandboxStateError('Final Desktop observer cannot retire while another producer remains.');
      if (this.availableObserver()) await this.assertCurrent();
      this.finalObserverClosing = true;
    }
    this.pending = { memberId, role, action, projection };
    return coordinatorDigest('agenai.desktop-coordinator.before.v1', JSON.stringify({ external: this.external ?? this.initialEngine,
      projections: this.projections(), memberId, role, action }));
  }

  async after(memberId: string, role: ResourceRole, action: ResourceAction,
    inspection: ResourceInspection | undefined): Promise<DesktopCoordinatorEffectObservation> {
    const member = this.member(memberId);
    const pending = this.pending;
    if (!pending || pending.memberId !== memberId || pending.role !== role || pending.action !== action) {
      throw new SandboxStateError('Desktop topology settlement lost its original entered recipe.');
    }
    member.inspections.set(role, inspection);
    if (role === 'route_observer' && (action === 'control_close' || action === 'delete')) member.observerClosing = true;
    member.projection = this.released(member, pending.projection);
    const observation = await this.capture();
    member.projection = this.released(member, observeDesktopMemberEffect(member.projection, member.source.record(), role, action, inspection,
      { engine: observation.engine, ...(observation.complete ? { complete: observation.complete } : {}) }));
    await this.accept(observation, true);
    if (role === 'route_observer' && action === 'control_close') {
      const deadline = performance.now() + DESKTOP_COORDINATOR_POLICY.transitionTimeoutMs;
      while (member.projection.observer.kind !== 'absent') {
        if (inspection?.container?.State.Running || performance.now() >= deadline) {
          throw new SandboxStateError('Desktop observer control ended without settled host-network retirement.');
        }
        await delay(Math.min(DESKTOP_COORDINATOR_POLICY.pollIntervalMs, Math.max(1, deadline - performance.now())));
        const next = await this.capture();
        member.projection = this.released(member, observeDesktopMemberEffect(member.projection, member.source.record(), role, action, inspection,
          { engine: next.engine, ...(next.complete ? { complete: next.complete } : {}) }));
        await this.accept(next, true);
      }
    }
    const bridge = member.projection.bridge.kind;
    // A released endpoint settles only under its own exact broker removal; other effects must not wait on it.
    if (bridge === 'starting_endpoint' || bridge === 'removing_bridge'
      || bridge === 'removing_endpoint' && (role === 'egress_broker' || !this.releasing(member))) await this.settleBridge(member);
    if (role === 'network' && action === 'create') member.lockedExclusions = this.requireCensus().excludedCidrs;
    this.pending = undefined;
    this.checkRetention();
    const projection = desktopJournalProjection(member.projection, this.receipts.find((entry) => entry.memberId === memberId),
      this.lastEngine.engine, member.stopped, member.inspections.get('egress_broker')?.container?.State.Status === 'created',
      member.inspections.get('egress_relay')?.container?.State.Running === true);
    const inspectionDigest = coordinatorDigest('agenai.desktop-coordinator.inspection.v1', JSON.stringify(inspection ?? null));
    return Object.freeze({ inspectionDigest, projection, receiptDigest: coordinatorDigest('agenai.desktop-coordinator.receipt.v1',
      JSON.stringify({ memberId, role, action, inspectionDigest, projection })) });
  }

  async assertCurrent(): Promise<void> { await this.accept(await this.capture(), false); }

  census(memberId: string): DesktopRouteCensus { this.member(memberId); return this.requireCensus(); }

  async stopped(memberId: string): Promise<void> {
    const member = this.member(memberId);
    if (['compute', 'filesystem', 'egress_broker', 'egress_relay', 'route_observer'].some((role) =>
      member.inspections.get(role as ResourceRole) !== undefined)) throw new SandboxStateError('Stopped Desktop member retains a producer.');
    await this.assertCurrent();
    member.stopped = true;
  }

  retire(memberId: string): void {
    const member = this.member(memberId);
    if (member.projection.bridge.kind !== 'absent' || [...member.inspections.values()].some((inspection) => inspection !== undefined)) {
      throw new SandboxStateError('Desktop member retirement retains an original resource.');
    }
    this.members.delete(memberId);
  }

  currentBasis(atSequence: number, exclusionDigest: string): Extract<AuthorityBasis, { kind: 'full' }> | undefined {
    if (!this.external || !this.latest) return undefined;
    return Object.freeze({ kind: 'full', atSequence, exclusionDigest,
      hostDigest: `sha256:${this.lastEngine.host.fingerprint}`, engineDigest: `sha256:${observationFingerprint(this.lastEngine.engine)}`,
      vmDigest: `sha256:${this.latest.vmAfter.fingerprint}`, externalEngineDigest: `sha256:${observationFingerprint(this.external.engine)}`,
      externalVmDigest: `sha256:${observationFingerprint(this.external.vm)}`,
      projectionDigest: `sha256:${observationFingerprint(this.projections())}` });
  }

  private member(memberId: string): Member {
    const member = this.members.get(memberId);
    if (!member) throw new SandboxStateError('Desktop topology has no original registered member.');
    return member;
  }

  private projections(): readonly DesktopMemberProjection[] { return [...this.members.values()].map((member) => member.projection); }
  private released(member: Member, projection: DesktopMemberProjection): DesktopMemberProjection {
    return releaseDesktopMemberControls(projection, member.released);
  }
  private releasing(member: Member): boolean {
    return member.released.has('egress_broker') && member.projection.bridge.kind === 'removing_endpoint';
  }
  private exclusions(): readonly (readonly string[])[] {
    return [...this.members.values()].flatMap((member) => member.lockedExclusions ? [member.lockedExclusions] : []);
  }
  private availableObserver(excluding?: string): DesktopVmObserverClient | undefined {
    return [...this.members.values()].find((member) => member.source.memberId !== excluding && !member.observerClosing
      && member.inspections.get('route_observer')?.container?.State.Running && member.observer)?.observer?.client;
  }
  private hasProducers(): boolean {
    return [...this.members.values()].some((member) => ['compute', 'filesystem', 'egress_broker', 'egress_relay'].some((role) =>
      member.inspections.get(role as ResourceRole) !== undefined));
  }
  private requireCensus(): DesktopRouteCensus {
    if (!this.latest) throw new SandboxStateError('Desktop VM authority has not been established by an original member observer.');
    return this.latest.census;
  }
  private async capture(): Promise<EngineObservation & Readonly<{ complete?: DesktopCompleteObservation }>> {
    const signal = AbortSignal.timeout(DESKTOP_COORDINATOR_POLICY.observationTimeoutMs);
    const observer = this.availableObserver();
    if (!observer) {
      if (this.external && !this.finalObserverClosing) throw new SandboxStateError('Desktop full authority lost every original observer.');
      return this.options.captureEngineBaseline(signal);
    }
    const complete = await captureDesktopCompleteObservation({ api: this.options.api, binding: this.options.binding, observer,
      expectedHost: this.options.initial.host, assertEndpoint: this.options.assertEndpoint }, signal);
    return { host: complete.host, engine: complete.engine, complete };
  }

  private async accept(observed: EngineObservation & Readonly<{ complete?: DesktopCompleteObservation }>, effect: boolean,
    settling?: Member): Promise<boolean> {
    requireSameAuthority(observed.host.fingerprint, this.options.initial.host.fingerprint, 'Desktop host authority differs from the original baseline.');
    requireSameAuthority(observed.host.executableIdentity, this.options.initial.host.executableIdentity, 'Desktop host observer identity changed.');
    const engine = projectDesktopEngineExternal(observed.engine, this.projections());
    requireSameAuthority(engine, this.initialEngine, 'External Desktop Engine topology changed.');
    this.lastEngine = { host: observed.host, engine: observed.engine };
    if (!observed.complete) return true;
    if (!this.external) {
      const before = projectDesktopExternal({ engine: observed.engine, vm: observed.complete.vmBefore }, this.projections());
      const after = projectDesktopExternal({ engine: observed.engine, vm: observed.complete.vmAfter }, this.projections());
      requireSameAuthority(before.external, after.external, 'Desktop VM baseline changed during initial observer bootstrap.');
      this.external = after.external;
    }
    const result = validateDesktopProjectionCandidate(observed.complete, this.projections(), this.external);
    this.receipts = result.members;
    this.latest = { ...observed.complete, vmBefore: observed.complete.vmAfter };
    this.finalObserverClosing = false;
    for (const member of this.members.values()) if (member.lockedExclusions) {
      requireSameAuthority(observed.complete.census.excludedCidrs, member.lockedExclusions, 'Desktop locked broker exclusion coverage changed.');
    }
    const unsettled = result.unsettled.filter((memberId) => {
      const member = this.members.get(memberId);
      return member === undefined || member === settling || !this.releasing(member);
    });
    if (!effect && unsettled.length) throw new SandboxStateError('Desktop fixed authority contains an unsettled transition.');
    this.checkRetention();
    return unsettled.length === 0;
  }

  private async settleBridge(member: Member): Promise<void> {
    const deadline = performance.now() + DESKTOP_COORDINATOR_POLICY.transitionTimeoutMs;
    let previous: string | undefined;
    while (true) {
      const observed = await this.capture();
      const settled = await this.accept(observed, true, member);
      const receipt = this.receipts.find((entry) => entry.memberId === member.source.memberId);
      const fingerprint = receipt?.graph?.fingerprint ?? 'absent';
      if (settled && previous === fingerprint) {
        const bridge = member.projection.bridge;
        if (bridge.kind === 'starting_endpoint') {
          if (!observed.complete) throw new SandboxStateError('Desktop endpoint settlement requires live VM authority.');
          member.projection = this.released(member, { ...member.projection, bridge: { ...bridge, kind: 'active',
            graph: captureDesktopActiveGraph(bridge.owned, observed.complete.vmAfter) } });
        } else if (bridge.kind === 'removing_endpoint') {
          if (!observed.complete) throw new SandboxStateError('Desktop endpoint removal requires live VM authority.');
          member.projection = { ...member.projection, bridge: { kind: 'retained', owned: bridge.owned,
            state: captureDesktopRetainedState(bridge.transition, observed.complete.vmAfter) } };
        } else if (bridge.kind === 'removing_bridge') member.projection = { ...member.projection, bridge: { kind: 'absent' } };
        if (member.projection.bridge.kind === 'absent') this.receipts = this.receipts.map((entry) => entry.memberId === member.source.memberId
          ? Object.freeze({ memberId: entry.memberId, kind: 'absent', settled: true, graph: null }) : entry);
        return;
      }
      previous = settled ? fingerprint : undefined;
      if (performance.now() >= deadline) throw new SandboxOperationError('deadline_exceeded', 'Desktop finite topology transition did not settle.');
      await delay(Math.min(DESKTOP_COORDINATOR_POLICY.pollIntervalMs, Math.max(1, deadline - performance.now())));
    }
  }

  private checkRetention(): void {
    const bytes = Buffer.byteLength(JSON.stringify({ initial: this.options.initial, external: this.external,
      members: this.projections(), latest: this.latest, receipts: this.receipts }), 'utf8');
    if (bytes > DESKTOP_COORDINATOR_POLICY.observationBytes) throw new SandboxOperationError('output_limit', 'Desktop retained topology authority exceeds its normalized byte bound.');
  }
}
