// ------------------------------------------------------------------------------------------------
//                owner.ts - Exact Docker resource acquisition and cleanup - Shared neutral owner port
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxOperationError, SandboxStateError, SandboxUnsupportedError, parseSandboxGuestPath, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { OperationOptions, SandboxCleanupOwner, SandboxInputTreeEntry, SandboxInputTreeSelection, SandboxExportConsumer, SandboxPolicy, SandboxProcessSpec, SandboxRecoveryRecord, SandboxRecoveryResource, SandboxRequest } from '@agen-ai/sandbox';
import type { SandboxDriverReady, SandboxDriverReservation, SandboxDriverStartOptions, SandboxDriverTransferOptions } from '@agen-ai/sandbox/backend';
import { createSandboxSpillStore, verifySandboxSpillDirectory } from '@agen-ai/sandbox/node';
import type { DockerSandboxConfig } from '../policy/config.js';
import { DOCKER_API } from '../policy/config.js';
import { assertDockerController, assertDockerPolicy, verifyDaemon, verifyDatasetImages, verifyImage, verifyEgressImage, verifyEgressDeployment } from '../policy/preflight.js';
import { dockerProfile } from '../policy/profiles.js';
import { containerBody, verifyContainer } from '../policy/container.js';
import type { EgressHelperPlacement } from '../policy/helperContainer.js';
import { verifyFilesystemImage } from '../policy/filesystem.js';
import { verifyDesktopObserverImage } from '../policy/desktopObserver.js';
import { DockerFilesystem } from '../workspace/live/files.js';
import { captureDockerRouteLease } from '../network/census.js';
import { parseNumericAddress } from '../network/address.js';
import type { DockerRouteLease } from '../network/census.js';
import { captureDesktopRouteAcquisition, preflightDesktopRouteAuthority } from '../network/desktop/acquisition.js';
import type { DesktopBridgeAuthority, DesktopPreBridgeAuthority } from '../network/desktop/acquisition.js';
import type { DesktopOwnedNoneMembers, DesktopStartedTopologyReceipt } from '../network/desktop/topology.js';
import type { DesktopCoordinatorControlledRole, DesktopCoordinatorStartedRole } from '../network/desktop/coordinator/member.js';
import { EGRESS_PROTOCOL } from '../helpers/protocol.js';
import { desktopBridgeName, newRecoveryRecord, resourceLabels } from '../recovery/identity.js';
import type { ResourceRole } from '../recovery/identity.js';
import { importWorkspace } from '../workspace/imports.js';
import { exportWorkspace } from '../workspace/exports.js';
import { DockerApi } from './api.js';
import { DockerProcessOwner } from '../process/owner.js';
import { hasUnexpectedImageMountWarnings } from '../datasets/warnings.js';
import { inspectResource } from './inspect.js';
import type { ResourceInspection } from './inspect.js';
import { DockerMemberBridge } from './memberBridge.js';
import { DockerInfrastructure } from './infrastructure.js';
import { containerCreatedSchema } from './responses.js';
import { removeInspectedDockerResource } from './removal.js';

const volumeCreatedSchema = z.object({ Name: z.string() });
const networkCreatedSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u), Warning: z.string().optional() });

export class DockerResourceOwner implements SandboxDriverReservation, SandboxCleanupOwner {
  private current: SandboxRecoveryRecord;
  private closed = false;
  private startActual: Promise<SandboxDriverReady> | undefined;
  private stopActual: Promise<void> | undefined;
  private destroyActual: Promise<void> | undefined;
  private checkpoint: ((record: SandboxRecoveryRecord) => Promise<void>) | undefined;
  private checkpointTail: Promise<void> = Promise.resolve();
  private readonly returnedIds = new Map<ResourceRole, string>();
  private readonly createEffects = new Map<ResourceRole, Promise<unknown>>();
  private readonly absent = new Set<ResourceRole>();
  private process: DockerProcessOwner | undefined;
  private filesystem: DockerFilesystem | undefined;
  private routeLease: DockerRouteLease | undefined;
  private desktopAcquisition: DesktopPreBridgeAuthority | undefined;
  private onInfrastructureFailure: ((error: SandboxOperationError) => void) | undefined;
  private readonly memberBridge: DockerMemberBridge;
  private readonly infrastructure: DockerInfrastructure;

  constructor(private readonly api: DockerApi, private readonly config: DockerSandboxConfig,
    private readonly request: SandboxRequest | undefined, record?: SandboxRecoveryRecord) {
    if (record) this.current = record;
    else if (request) this.current = newRecoveryRecord(config, request);
    else throw new SandboxStateError('Docker resource ownership needs a request or verified recovery record.');
    this.memberBridge = new DockerMemberBridge({ api, config,
      record: () => this.current, retain: (current) => { this.current = current; },
      returned: (role, id) => { this.returnedIds.set(role, id); },
      creating: (role, actual) => { this.createEffects.set(role, actual); },
      remove: (role) => this.deleteResourcePhysical(role), failed: (error) => this.memberFailed(error),
    }, { closed: () => this.closed, assertOpen: (signal) => this.assertOpen(signal) });
    this.infrastructure = new DockerInfrastructure({ api, config,
      record: () => this.current, member: () => this.member, routeLease: () => this.routeLease, closed: () => this.closed,
      assertOpen: (signal) => this.assertOpen(signal), assertAuthority: (signal) => this.assertAuthority(signal),
      requirePresent: (role, signal) => this.requirePresent(role, signal), hasResource: (role) => this.hasResource(role),
      createResource: (role, signal, create, validate) => this.createResource(role, signal, create, validate),
      startContainer: (role, signal, ready, validate, beginReadiness) => this.startContainer(role, signal, ready, validate, beginReadiness),
      failed: (error) => this.infrastructureFailed(error),
      controlFailed: (role, error) => this.controlFailed(role, error),
    });
  }

  private get member() { return this.memberBridge.member; }
  private get desktopObserver() { return this.infrastructure.desktopObserver; }
  private get filesystemChannel() { return this.infrastructure.filesystemChannel; }
  private get helperControls() { return this.infrastructure.helperControls; }
  private get checkEgress() { return this.infrastructure.checkEgress; }

  get id() { return this.current.sandboxId; }
  get recoveryRecord(): SandboxRecoveryRecord { return this.current; }

  start(options: SandboxDriverStartOptions): Promise<SandboxDriverReady> {
    if (this.startActual || !this.request) return Promise.reject(new SandboxStateError('Docker resource startup is once-only.'));
    this.checkpoint = options.checkpoint;
    this.onInfrastructureFailure = options.onInfrastructureFailure;
    const policy = this.request.policy;
    this.startActual = this.memberBridge.start(policy, options, () => this.acquire(policy, options));
    return this.startActual;
  }

  private async acquire(policy: SandboxPolicy, options: SandboxDriverStartOptions): Promise<SandboxDriverReady> {
    assertDockerPolicy(policy);
    this.assertOpen(options.signal);
    assertDockerController(this.config);
    await verifySandboxSpillDirectory(this.config.spillDirectory, { signal: options.signal });
    this.assertOpen(options.signal);
    const backendIdentity = await verifyDaemon(this.api, this.config, options.signal);
    await verifyImage(this.api, this.config, options.signal);
    await verifyDatasetImages(this.api, this.config, options.signal);
    if (policy.files.kind !== 'disabled') await verifyFilesystemImage(this.api, this.config, options.signal);
    const desktopBinding = policy.network.kind === 'restricted_https' && this.config.egressAuthority?.kind === 'local_docker_desktop'
      ? this.config.egressAuthority : undefined;
    if (policy.network.kind === 'restricted_https') {
      if (!this.config.egress) throw new SandboxUnsupportedError('Restricted HTTPS requires explicitly prepared helpers and route authority.');
      await verifyEgressImage(this.api, this.config, options.signal);
      if (desktopBinding) await verifyDesktopObserverImage(this.api, this.config, options.signal);
      else {
        this.routeLease = await captureDockerRouteLease(this.config.egressAuthority, options.signal);
        await verifyEgressDeployment(this.api, this.config, this.routeLease.census, options.signal);
      }
    }
    const desktopPreflight = desktopBinding && !this.member ? await preflightDesktopRouteAuthority(desktopBinding, options.signal) : undefined;
    let desktopBridge: DesktopBridgeAuthority | undefined;
    this.assertOpen(options.signal);
    await this.publish({ ...this.current, phase: 'starting', authority: { kind: 'verified', backendIdentity } });
    if (desktopBinding && this.member) {
      await this.infrastructure.startDesktopObserver(options.signal);
    } else if (desktopBinding && desktopPreflight) {
      const observer = await this.infrastructure.startDesktopObserver(options.signal);
      if (!this.desktopObserver) throw new SandboxStateError('Desktop route acquisition lost its owned observer control.');
      const acquisition = await captureDesktopRouteAcquisition({ api: this.api, binding: desktopBinding,
        observer: this.desktopObserver, hostPreflight: desktopPreflight, ownedObserverId: observer.id }, options.signal);
      this.desktopAcquisition = acquisition;
      try { this.assertOpen(options.signal); }
      catch (cause) {
        try { await acquisition.close(); }
        catch (cleanup) { throw new AggregateError([cause, cleanup], 'Desktop authority acquisition and late control cleanup failed.'); }
        throw cause;
      }
    }
    const storage = await this.createResource('storage', options.signal, async (resource) => {
      const result = await this.api.json('POST', `${DOCKER_API}/volumes/create`, volumeCreatedSchema,
        { body: { Name: resource.name, Driver: 'local', Labels: resourceLabels(this.current, 'storage') } });
      return { id: result.Name };
    });
    if (policy.files.kind !== 'disabled' && !this.member) {
      this.filesystem = await this.infrastructure.startFilesystem(storage.id, policy.files.kind, options.signal);
    }
    const network = policy.network.kind !== 'isolated' ? await this.createResource('network', options.signal, async (resource) => {
      const result = await this.api.json('POST', `${DOCKER_API}/networks/create`, networkCreatedSchema, { body: {
        Name: resource.name, Driver: 'bridge', Internal: false, Attachable: false, Ingress: false,
        EnableIPv6: false, CheckDuplicate: true, Labels: resourceLabels(this.current, 'network'),
        ...(desktopBinding ? { Options: { 'com.docker.network.bridge.name': desktopBridgeName(this.current) } } : {}),
        ...(this.member ? { IPAM: { Driver: 'default', Config: [{ Subnet: this.member.allocation.subnet,
          Gateway: this.member.allocation.gateway }] } } : {}),
      } });
      return { id: result.Id, warning: Boolean(result.Warning) };
    }) : undefined;
    if (policy.files.kind !== 'disabled' && this.member) {
      this.filesystem = await this.infrastructure.startFilesystem(storage.id, policy.files.kind, options.signal);
    }
    let restricted: Readonly<{ socketVolumeId: string; broker: ResourceInspection;
      placement: Extract<EgressHelperPlacement, { role: 'egress_broker' }> }> | undefined;
    if (policy.network.kind === 'restricted_https') {
      const egress = this.config.egress;
      if (desktopBinding && network && this.desktopAcquisition) {
        desktopBridge = await this.desktopAcquisition.admitBridge({ networkId: network.id,
          name: this.resource('network').name, bridgeName: desktopBridgeName(this.current), labels: resourceLabels(this.current, 'network') },
        this.ownedNoneMembers(), options.signal);
        this.routeLease = desktopBridge;
      }
      if (!egress || !network || !this.routeLease && !this.member) throw new SandboxStateError('Restricted acquisition lacks its admitted topology.');
      if (this.member) await this.member.assertCurrent(options.signal);
      else await this.routeLease?.assertCurrent(options.signal);
      const socketVolume = await this.createResource('egress_socket', options.signal, async (resource) => {
        const result = await this.api.json('POST', `${DOCKER_API}/volumes/create`, volumeCreatedSchema,
          { body: { Name: resource.name, Driver: 'local', Labels: resourceLabels(this.current, 'egress_socket') } });
        return { id: result.Name };
      });
      const census = this.member ? this.member.census : this.routeLease?.census;
      if (!census) throw new SandboxStateError('Restricted acquisition lost its original route census.');
      const placement: Extract<EgressHelperPlacement, { role: 'egress_broker' }> = { role: 'egress_broker', networkId: network.id, configuration: {
        protocol: EGRESS_PROTOCOL, role: 'broker', destinations: policy.network.destinations,
        excludedCidrs: census.excludedCidrs, leaseTimeoutMs: egress.control.leaseTimeoutMs,
      } };
      const broker = await this.infrastructure.startHelper(socketVolume.id, placement, options.signal);
      restricted = { socketVolumeId: socketVolume.id, broker, placement };
    }
    const platform = `linux/${dockerProfile(this.config.profile).workloadImageArchitecture}`;
    const createContainer = (role: 'compute' | 'export') => this.createResource(role, options.signal, async (resource) => {
      const result = await this.api.json('POST', `${DOCKER_API}/containers/create?name=${encodeURIComponent(resource.name)}&platform=${encodeURIComponent(platform)}`,
        containerCreatedSchema, { body: containerBody(this.config, this.current, policy, role, storage.id, network?.id) });
      return { id: result.Id,
        warning: hasUnexpectedImageMountWarnings(result.Warnings ?? [], role === 'compute' ? this.config.datasets.length : 0) };
    }, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker did not inspect the created container.');
      verifyContainer(inspection.container, this.config, policy, role, storage.id, network?.id, false, this.hasResource('filesystem'));
    });
    const compute = await createContainer('compute');
    await createContainer('export');
    this.assertOpen(options.signal);
    await this.assertAuthority(options.signal);
    await importWorkspace(this.api, compute.id, (async function* () {})(), this.config.user, {
      signal: options.signal ?? new AbortController().signal, buffers: policy.transfers, quotas: {}, symlinks: 'reject',
    }, this.hasResource('filesystem'));
    this.assertOpen(options.signal);
    await this.assertAuthority(options.signal);
    const running = await this.startContainer('compute', options.signal, undefined, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker workload disappeared during startup.');
      verifyContainer(inspection.container, this.config, policy, 'compute', storage.id, network?.id, true, this.hasResource('filesystem'));
    });
    this.assertOpen(options.signal);
    if (!running?.container) throw new SandboxStateError('Docker workload disappeared during startup.');
    verifyContainer(running.container, this.config, policy, 'compute', storage.id, network?.id, true, this.hasResource('filesystem'));
    if (policy.network.kind === 'restricted_https') {
      const egress = this.config.egress;
      if (!egress || !restricted || !network) throw new SandboxStateError('Restricted acquisition lacks its owned helpers.');
      if (desktopBinding && !this.member) {
        if (!desktopBridge) {
          throw new SandboxStateError('Desktop readiness requires its original unsealed bridge acquisition.');
        }
        this.routeLease = await desktopBridge.seal(this.startedDesktopTopology(restricted.broker, network.id), options.signal);
        this.assertOpen(options.signal);
      }
      const relayPlacement: Extract<EgressHelperPlacement, { role: 'egress_relay' }> = { role: 'egress_relay', computeId: compute.id, configuration: {
        protocol: EGRESS_PROTOCOL, role: 'relay', leaseTimeoutMs: egress.control.leaseTimeoutMs,
      } };
      await this.infrastructure.startHelper(restricted.socketVolumeId, relayPlacement, options.signal);
      this.infrastructure.installEgressHealth(policy, storage.id, restricted.socketVolumeId, network.id, restricted.broker.id, restricted.placement, relayPlacement);
      await this.checkEgress?.(options.signal);
      this.assertOpen(options.signal);
      this.infrastructure.scheduleHealth();
    }
    await this.publish({ ...this.current, phase: 'running' });
    this.assertOpen(options.signal);
    return Object.freeze({
      effective: Object.freeze({ backendIdentity, isolation: 'container' as const, resources: policy.resources,
        temporaryStorage: policy.temporaryStorage, network: policy.network,
        files: policy.files,
        nonRoot: true as const, readOnlyRoot: true as const, workspaceDiskQuota: Object.freeze({ kind: 'not_requested' as const }) }),
      files: this.filesystem ? this.memberBridge.files(this.filesystem.files) : undefined,
      workspace: parseSandboxGuestPath('/workspace/work'),
      openSpill: (operation?: OperationOptions) => createSandboxSpillStore({ directory: this.config.spillDirectory, signal: operation?.signal }),
      importTree: (entries: AsyncIterable<SandboxInputTreeEntry>, operation: SandboxDriverTransferOptions) => this.importTree(entries, operation),
      reserveProcess: (spec: SandboxProcessSpec) => {
        this.assertOpen();
        if (this.process) throw new SandboxStateError('Docker admits only one process reservation.');
        this.process = new DockerProcessOwner(this.api, this.config, compute.id, spec, policy, async (signal) => {
          this.assertOpen(signal);
          await this.memberBridge.enterPrimary();
          await this.assertAuthority(signal);
          await this.requirePresent('compute', signal);
          await this.checkEgress?.(signal);
          this.assertOpen(signal);
        }, () => this.stop());
        return this.process;
      },
      exportTree: (selection: SandboxInputTreeSelection, consume: SandboxExportConsumer, operation: SandboxDriverTransferOptions) =>
        this.exportTree(selection, consume, operation, policy, storage.id, network?.id),
    });
  }

  private async importTree(entries: AsyncIterable<SandboxInputTreeEntry>, options: SandboxDriverTransferOptions) {
    this.assertOpen(options.signal);
    await this.assertAuthority(options.signal);
    const compute = await this.requirePresent('compute', options.signal);
    await this.checkEgress?.(options.signal);
    this.assertOpen(options.signal);
    return this.memberBridge.write(() => importWorkspace(this.api, compute.id, entries, this.config.user, options, this.hasResource('filesystem')));
  }

  private ownedNoneMembers(): DesktopOwnedNoneMembers {
    const member = (role: 'compute' | 'filesystem') => {
      if (!this.hasResource(role)) return { kind: 'absent' } as const;
      const identity = this.resource(role).identity;
      if (identity.kind === 'creating') throw new SandboxStateError('Desktop topology cannot admit an unsettled producer identity.');
      return identity.kind === 'identified' ? { kind: 'present', id: identity.id } as const : { kind: 'absent' } as const;
    };
    return { compute: member('compute'), filesystem: member('filesystem') };
  }

  private startedDesktopTopology(broker: ResourceInspection, networkId: string): DesktopStartedTopologyReceipt {
    const endpoints = Object.values(broker.container?.NetworkSettings.Networks ?? {});
    const endpoint = endpoints[0];
    if (endpoints.length !== 1 || !endpoint || endpoint.NetworkID !== networkId
      || !endpoint.EndpointID || !/^[a-f0-9]{64}$/u.test(endpoint.EndpointID)
      || !endpoint.MacAddress || !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(endpoint.MacAddress)
      || !endpoint.IPAddress || parseNumericAddress(endpoint.IPAddress)?.family !== 4
      || !endpoint.Gateway || parseNumericAddress(endpoint.Gateway)?.family !== 4
      || endpoint.IPPrefixLen === undefined || endpoint.IPPrefixLen < 1 || endpoint.IPPrefixLen > 32) {
      throw new SandboxStateError('Desktop broker lacks the exact started IPv4 Engine endpoint receipt.');
    }
    return { broker: { id: broker.id, networkId, endpointId: endpoint.EndpointID, macAddress: endpoint.MacAddress,
      address: endpoint.IPAddress, prefixLength: endpoint.IPPrefixLen, gateway: endpoint.Gateway }, members: this.ownedNoneMembers() };
  }

  private infrastructureFailed(error: SandboxOperationError): void {
    this.member?.infrastructureFailed(error);
    this.memberFailed(error);
  }

  private controlFailed(role: DesktopCoordinatorControlledRole, error: SandboxOperationError): void {
    if (this.member) this.member.controlFailed(role, error);
    else if (!this.closed) this.memberFailed(error);
  }

  private memberFailed(error: SandboxOperationError): void {
    this.infrastructure.stopRenewal();
    if (this.closed) return;
    this.closed = true;
    this.member?.closeAdmission();
    this.process?.closeAdmission();
    this.infrastructure.closeFilesAdmission();
    this.onInfrastructureFailure?.(error);
    void this.stop().catch(() => {});
  }

  private async exportTree(selection: SandboxInputTreeSelection, consume: SandboxExportConsumer, options: SandboxDriverTransferOptions,
    policy: SandboxPolicy, storageId: string, networkId: string | undefined) {
    await this.assertAuthority(options.signal);
    if (await this.resolveResource('compute', options.signal)) throw new SandboxStateError('Workspace export requires exact compute absence.');
    for (const role of ['egress_relay', 'egress_broker', 'filesystem', 'route_observer'] satisfies ResourceRole[]) {
      if (this.hasResource(role) && await this.resolveResource(role, options.signal)) {
        throw new SandboxStateError('Workspace export requires every owned infrastructure producer to be absent.');
      }
    }
    await this.requirePresent('storage', options.signal);
    const accessor = await this.requirePresent('export', options.signal);
    if (!accessor.container) throw new SandboxStateError('Workspace export requires the exact archive accessor.');
    verifyContainer(accessor.container, this.config, policy, 'export', storageId, networkId, false, this.hasResource('filesystem'));
    return this.memberBridge.export(() => exportWorkspace(this.api, accessor.id, selection, consume, options, this.hasResource('filesystem')));
  }

  private async createResource(role: ResourceRole, signal: AbortSignal | undefined,
    create: (resource: SandboxRecoveryResource) => Promise<{ id: string; warning?: boolean }>, validate?: (inspection: ResourceInspection) => void): Promise<ResourceInspection> {
    if (this.member) return this.member.create(role, signal, { dispatch: create, validate,
      input: { role, configurationDigest: this.current.configurationDigest, policyDigest: this.current.policyDigest,
        resources: this.current.resources.map(({ role: resourceRole, name, identity }) => ({ role: resourceRole, name, identity })),
        allocation: this.member.allocation } });
    this.assertOpen(signal);
    await this.assertAuthority(signal);
    await this.updateIdentity(role, { kind: 'creating' });
    this.assertOpen(signal);
    const effect = create(this.resource(role)).then((created) => {
      this.returnedIds.set(role, created.id);
      return created;
    });
    this.createEffects.set(role, effect);
    const { id, warning } = await effect;
    if (warning) throw new SandboxUnsupportedError('Docker warned while creating the requested resource.');
    const resource = this.resource(role);
    const inspection = await inspectResource(this.api, this.config, this.current, resource, id);
    if (!inspection || inspection.id !== id) throw new SandboxStateError('Docker did not confirm the exact created resource ID.');
    validate?.(inspection);
    await this.updateIdentity(role, { kind: 'identified', id, fingerprint: inspection.fingerprint });
    this.assertOpen(signal);
    return inspection;
  }

  private async startContainer(role: DesktopCoordinatorStartedRole, signal: AbortSignal | undefined,
    ready: Promise<void> | undefined, validate: (inspection: ResourceInspection) => void,
    beginReadiness?: () => void): Promise<ResourceInspection> {
    if (this.member) return this.member.start(role, signal, { ready, validate, beginReadiness });
    const resource = this.resource(role);
    if (resource.identity.kind !== 'identified') throw new SandboxStateError('Docker startup requires its original identified resource.');
    beginReadiness?.();
    await this.api.request('POST', `${DOCKER_API}/containers/${resource.identity.id}/start`, { signal });
    await ready;
    this.assertOpen(signal);
    const running = await this.requirePresent(role, signal);
    validate(running);
    return running;
  }

  stop(): Promise<void> {
    this.closed = true;
    this.member?.closeAdmission();
    this.process?.closeAdmission();
    this.infrastructure.closeFilesAdmission();
    this.stopActual ??= this.cleanupCompute().catch((error: unknown) => { this.stopActual = undefined; throw error; });
    return this.stopActual;
  }

  private async cleanupCompute(): Promise<void> {
    if (this.config.coordinator) return this.cleanupCoordinatedCompute();
    this.cleanupPhase('stopping');
    this.infrastructure.stopHealth();
    const controls = Promise.allSettled([
      ...[...this.helperControls.values()].map((control) => control.close()),
      ...(this.filesystemChannel ? [this.filesystemChannel.close()] : []),
      ...(this.desktopAcquisition ? [this.desktopAcquisition.close()] : []),
      ...(this.routeLease ? [this.routeLease.close()] : []),
      ...(this.desktopObserver ? [this.desktopObserver.close()] : []),
    ]);
    const failures: unknown[] = [];
    for (const role of ['compute', 'egress_relay', 'egress_broker', 'filesystem', 'route_observer'] satisfies ResourceRole[]) {
      if (!this.hasResource(role)) continue;
      const entered = this.createEffects.get(role);
      // Persistence may be blocked after a producer becomes live. Remove before joining it.
      if (entered || !this.request) {
        try { await this.deleteResource(role); }
        catch (error) { if (!entered) { failures.push(error); continue; } }
        await entered?.catch(() => {});
        if (!this.absent.has(role)) {
          try { await this.deleteResource(role); } catch (error) { failures.push(error); }
        }
      }
    }
    if (this.absent.has('compute') || this.resource('compute').identity.kind === 'planned'
      || this.request !== undefined && !this.createEffects.has('compute')) {
      try { await this.process?.computeStopped(); } catch (error) { failures.push(error); }
    }
    for (const result of await controls) if (result.status === 'rejected') failures.push(result.reason);
    await this.infrastructure.healthSettled;
    if (failures.length) throw new AggregateError(failures, 'Sandbox infrastructure cleanup retains unresolved ownership.');
    this.cleanupPhase('stopped');
    await this.checkpointTail;
  }

  private async cleanupCoordinatedCompute(): Promise<void> {
    await this.memberBridge.settleEnrollment();
    const member = this.member;
    if (!member) return;
    const failures: unknown[] = [];
    try {
      await member.beginStop();
      if (this.current.authority.kind === 'unverified') {
        const backendIdentity = await verifyDaemon(this.api, this.config);
        this.current = parseSandboxRecoveryRecord({ ...this.current, authority: { kind: 'verified', backendIdentity } });
      }
    } catch (error) { failures.push(error); }
    this.cleanupPhase('stopping');
    this.infrastructure.stopHealth();
    const remove = async (role: ResourceRole) => {
      if (!this.hasResource(role)) return;
      try { await this.deleteResource(role); } catch (error) { failures.push(error); }
    };
    await remove('compute');
    for (const role of ['egress_relay', 'egress_broker', 'filesystem'] as const) {
      const control = role === 'filesystem' ? this.filesystemChannel : this.helperControls.get(role);
      if (control) {
        try { await this.infrastructure.closeControl(role, () => control.close()); } catch (error) { failures.push(error); }
      }
      await remove(role);
    }
    // Every known resource receives a cleanup attempt before an unknown late create is joined.
    await Promise.allSettled([...this.createEffects.values()]);
    for (const role of ['compute', 'egress_relay', 'egress_broker', 'filesystem'] as const) {
      if (!this.absent.has(role)) await remove(role);
    }
    if (this.absent.has('compute') || !this.createEffects.has('compute')) {
      try { await this.process?.computeStopped(); } catch (error) { failures.push(error); }
    }
    await this.startActual?.catch(() => {});
    failures.push(...await this.memberBridge.joinProducers());
    if (this.desktopObserver) {
      try { await this.infrastructure.closeControl('route_observer', () => this.desktopObserver?.close() ?? Promise.resolve()); }
      catch (error) { failures.push(error); }
    }
    await remove('route_observer');
    await this.infrastructure.healthSettled;
    if (failures.length) throw new AggregateError(failures, 'Coordinated sandbox cleanup retains original resource or callback ownership.');
    this.cleanupPhase('stopped');
    await this.checkpointTail;
    await member.stopped(this.current);
  }

  destroy(): Promise<void> {
    this.closed = true;
    this.destroyActual ??= this.cleanupAll().catch((error: unknown) => { this.destroyActual = undefined; throw error; });
    return this.destroyActual;
  }

  private async cleanupAll(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.stop(); } catch (error) { failures.push(error); }
    this.cleanupPhase('destroying');
    if (this.member) failures.push(...await this.memberBridge.joinExports());
    for (const role of ['export', 'storage', 'egress_socket', 'network'] satisfies ResourceRole[]) {
      if (!this.current.resources.some((resource) => resource.role === role)) continue;
      try { await this.deleteResource(role); } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      await this.checkpointTail;
      throw new AggregateError(failures, 'Docker cleanup retains unresolved resource ownership.');
    }
    this.cleanupPhase('destroyed');
    await this.checkpointTail;
    await this.member?.retire(this.current);
  }

  async resolveResource(role: ResourceRole, signal?: AbortSignal): Promise<ResourceInspection | undefined> {
    const resource = this.resource(role);
    if (resource.identity.kind === 'planned') return undefined;
    // Only the original owner can prove that a persisted intent never reached create dispatch.
    if (this.request !== undefined && !this.createEffects.has(role)) return undefined;
    const reference = resource.identity.kind === 'identified' ? resource.identity.id : this.returnedIds.get(role) ?? resource.name;
    const inspection = await inspectResource(this.api, this.config, this.current, resource, reference, signal);
    if (!inspection && resource.identity.kind === 'creating') {
      throw new SandboxStateError('Docker acquisition entered without a settled resource identity; an absent name cannot prove absence.');
    }
    if (inspection && resource.identity.kind === 'creating') {
      this.publishCleanup({ ...this.current, resources: this.current.resources.map((candidate) => candidate.role === role ? { ...candidate,
        identity: { kind: 'identified', id: inspection.id, fingerprint: inspection.fingerprint } } : candidate) });
    }
    return inspection;
  }

  private async requirePresent(role: ResourceRole, signal?: AbortSignal): Promise<ResourceInspection> {
    const inspection = await this.resolveResource(role, signal);
    if (!inspection) throw new SandboxStateError('The exact Docker resource is absent.');
    return inspection;
  }

  private async deleteResource(role: ResourceRole): Promise<void> {
    if (this.absent.has(role) || this.resource(role).identity.kind === 'planned') return;
    if (this.member) {
      await this.member.delete(role);
      this.absent.add(role);
      return;
    }
    return this.deleteResourcePhysical(role);
  }

  private async deleteResourcePhysical(role: ResourceRole): Promise<void> {
    if (this.absent.has(role) || this.resource(role).identity.kind === 'planned') return;
    await this.assertAuthority();
    const inspection = await this.resolveResource(role);
    if (!inspection) { this.absent.add(role); return; }
    await removeInspectedDockerResource(this.api, role, inspection, () => this.resolveResource(role));
    this.absent.add(role);
  }

  private resource(role: ResourceRole): SandboxRecoveryResource {
    const resource = this.current.resources.find((candidate) => candidate.role === role);
    if (!resource) throw new SandboxStateError('Docker recovery record omits an owned resource role.');
    return resource;
  }

  private hasResource(role: ResourceRole): boolean {
    return this.current.resources.some((resource) => resource.role === role);
  }

  private updateIdentity(role: ResourceRole, identity: SandboxRecoveryResource['identity']): Promise<void> {
    const next = { ...this.current, resources: this.current.resources.map((resource) => resource.role === role ? { ...resource, identity } : resource) };
    return this.publish(next);
  }

  private cleanupPhase(phase: SandboxRecoveryRecord['phase']): void {
    if (this.current.authority.kind === 'verified') this.publishCleanup({ ...this.current, phase });
  }

  private publishCleanup(record: SandboxRecoveryRecord): void {
    this.current = parseSandboxRecoveryRecord(record);
    this.submitCheckpoint(this.current);
  }

  private async publish(record: SandboxRecoveryRecord): Promise<void> {
    this.current = parseSandboxRecoveryRecord(record);
    await this.submitCheckpoint(this.current);
  }

  private submitCheckpoint(record: SandboxRecoveryRecord): Promise<void> {
    const writing = this.member ? this.member.checkpoint(record) : this.checkpoint?.(record) ?? Promise.resolve();
    this.checkpointTail = Promise.allSettled([this.checkpointTail, writing]).then(() => {});
    return writing;
  }

  private async assertAuthority(signal?: AbortSignal): Promise<void> {
    if (this.member && !this.closed) await this.member.assertCurrent(signal);
    if (this.current.authority.kind !== 'verified' || await verifyDaemon(this.api, this.config, signal) !== this.current.authority.backendIdentity) {
      throw new SandboxStateError('Docker resource operations cannot act on a different or unverified daemon.');
    }
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted) throw new SandboxOperationError('cancelled', 'Docker sandbox admission is closed.');
  }
}
