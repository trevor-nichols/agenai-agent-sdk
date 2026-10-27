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
import { helperContainerBody, verifyHelperContainer } from '../policy/helperContainer.js';
import type { EgressHelperPlacement } from '../policy/helperContainer.js';
import { filesystemContainerBody, verifyFilesystemContainer, verifyFilesystemImage } from '../policy/filesystem.js';
import { desktopObserverConfiguration, desktopObserverContainerBody, desktopObserverIdentity,
  verifyDesktopObserverContainer, verifyDesktopObserverImage } from '../policy/desktopObserver.js';
import type { FilesystemAccess } from '../policy/filesystem.js';
import { FilesystemChannel } from '../workspace/live/channel.js';
import { DockerFilesystem } from '../workspace/live/files.js';
import { captureDockerRouteLease } from '../network/census.js';
import { parseNumericAddress } from '../network/address.js';
import type { DockerRouteLease } from '../network/census.js';
import { createDesktopVmObserverClient } from '../network/desktop/client.js';
import type { DesktopVmObserverClient } from '../network/desktop/client.js';
import { captureDesktopRouteAcquisition, preflightDesktopRouteAuthority } from '../network/desktop/acquisition.js';
import type { DesktopBridgeAuthority, DesktopPreBridgeAuthority } from '../network/desktop/acquisition.js';
import type { DesktopOwnedNoneMembers, DesktopStartedTopologyReceipt } from '../network/desktop/topology.js';
import { createEgressHelperController } from '../network/controller.js';
import type { EgressHelperController } from '../network/controller.js';
import { EGRESS_PROTOCOL } from '../helpers/protocol.js';
import { desktopBridgeName, newRecoveryRecord, resourceLabels } from '../recovery/identity.js';
import type { ResourceRole } from '../recovery/identity.js';
import { importWorkspace } from '../workspace/imports.js';
import { exportWorkspace } from '../workspace/exports.js';
import { DockerApi } from './api.js';
import { DockerProcessOwner } from '../process/owner.js';
import { MAX_DATASET_ATTACHMENTS } from '../datasets/configuration.js';
import { hasUnexpectedImageMountWarnings } from '../datasets/warnings.js';
import { inspectResource, resourceKind, verifyNetworkMembership } from './inspect.js';
import type { ResourceInspection } from './inspect.js';

const containerCreatedSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u), Warnings: z.array(z.string()).max(MAX_DATASET_ATTACHMENTS).nullable().optional() });
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
  private readonly helperControls = new Map<'egress_broker' | 'egress_relay', EgressHelperController>();
  private filesystemChannel: FilesystemChannel | undefined;
  private filesystem: DockerFilesystem | undefined;
  private readonly healthController = new AbortController();
  private healthTimer: ReturnType<typeof setTimeout> | undefined;
  private healthActual: Promise<void> = Promise.resolve();
  private routeLease: DockerRouteLease | undefined;
  private desktopObserver: DesktopVmObserverClient | undefined;
  private desktopAcquisition: DesktopPreBridgeAuthority | undefined;
  private checkEgress: ((signal?: AbortSignal) => Promise<void>) | undefined;
  private onInfrastructureFailure: ((error: SandboxOperationError) => void) | undefined;

  constructor(private readonly api: DockerApi, private readonly config: DockerSandboxConfig,
    private readonly request: SandboxRequest | undefined, record?: SandboxRecoveryRecord) {
    if (record) this.current = record;
    else if (request) this.current = newRecoveryRecord(config, request);
    else throw new SandboxStateError('Docker resource ownership needs a request or verified recovery record.');
  }

  get id() { return this.current.sandboxId; }
  get recoveryRecord(): SandboxRecoveryRecord { return this.current; }

  start(options: SandboxDriverStartOptions): Promise<SandboxDriverReady> {
    if (this.startActual || !this.request) return Promise.reject(new SandboxStateError('Docker resource startup is once-only.'));
    this.checkpoint = options.checkpoint;
    this.onInfrastructureFailure = options.onInfrastructureFailure;
    this.startActual = this.acquire(this.request.policy, options);
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
    const desktopPreflight = desktopBinding ? await preflightDesktopRouteAuthority(desktopBinding, options.signal) : undefined;
    let desktopBridge: DesktopBridgeAuthority | undefined;
    this.assertOpen(options.signal);
    await this.publish({ ...this.current, phase: 'starting', authority: { kind: 'verified', backendIdentity } });
    if (desktopBinding && desktopPreflight) {
      const observer = await this.startDesktopObserver(options.signal);
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
    if (policy.files.kind !== 'disabled') {
      this.filesystem = await this.startFilesystem(storage.id, policy.files.kind, options.signal);
    }
    const network = policy.network.kind !== 'isolated' ? await this.createResource('network', options.signal, async (resource) => {
      const result = await this.api.json('POST', `${DOCKER_API}/networks/create`, networkCreatedSchema, { body: {
        Name: resource.name, Driver: 'bridge', Internal: false, Attachable: false, Ingress: false,
        EnableIPv6: false, CheckDuplicate: true, Labels: resourceLabels(this.current, 'network'),
        ...(desktopBinding ? { Options: { 'com.docker.network.bridge.name': desktopBridgeName(this.current) } } : {}),
      } });
      return { id: result.Id, warning: Boolean(result.Warning) };
    }) : undefined;
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
      if (!egress || !network || !this.routeLease) throw new SandboxStateError('Restricted acquisition lacks its admitted topology.');
      await this.routeLease.assertCurrent(options.signal);
      const socketVolume = await this.createResource('egress_socket', options.signal, async (resource) => {
        const result = await this.api.json('POST', `${DOCKER_API}/volumes/create`, volumeCreatedSchema,
          { body: { Name: resource.name, Driver: 'local', Labels: resourceLabels(this.current, 'egress_socket') } });
        return { id: result.Name };
      });
      const placement: Extract<EgressHelperPlacement, { role: 'egress_broker' }> = { role: 'egress_broker', networkId: network.id, configuration: {
        protocol: EGRESS_PROTOCOL, role: 'broker', destinations: policy.network.destinations,
        excludedCidrs: this.routeLease.census.excludedCidrs, leaseTimeoutMs: egress.control.leaseTimeoutMs,
      } };
      const broker = await this.startHelper(socketVolume.id, placement, options.signal);
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
    await this.api.request('POST', `${DOCKER_API}/containers/${compute.id}/start`, { signal: options.signal });
    this.assertOpen(options.signal);
    const running = await inspectResource(this.api, this.config, this.current, this.resource('compute'), compute.id, options.signal);
    if (!running?.container) throw new SandboxStateError('Docker workload disappeared during startup.');
    verifyContainer(running.container, this.config, policy, 'compute', storage.id, network?.id, true, this.hasResource('filesystem'));
    if (policy.network.kind === 'restricted_https') {
      const egress = this.config.egress;
      if (!egress || !restricted || !network) throw new SandboxStateError('Restricted acquisition lacks its owned helpers.');
      if (desktopBinding) {
        if (!desktopBridge) {
          throw new SandboxStateError('Desktop readiness requires its original unsealed bridge acquisition.');
        }
        this.routeLease = await desktopBridge.seal(this.startedDesktopTopology(restricted.broker, network.id), options.signal);
        this.assertOpen(options.signal);
      }
      const relayPlacement: Extract<EgressHelperPlacement, { role: 'egress_relay' }> = { role: 'egress_relay', computeId: compute.id, configuration: {
        protocol: EGRESS_PROTOCOL, role: 'relay', leaseTimeoutMs: egress.control.leaseTimeoutMs,
      } };
      await this.startHelper(restricted.socketVolumeId, relayPlacement, options.signal);
      this.installEgressHealth(policy, storage.id, restricted.socketVolumeId, network.id, restricted.broker.id, restricted.placement, relayPlacement);
      await this.checkEgress?.(options.signal);
      this.assertOpen(options.signal);
      this.scheduleHealth();
    }
    await this.publish({ ...this.current, phase: 'running' });
    this.assertOpen(options.signal);
    return Object.freeze({
      effective: Object.freeze({ backendIdentity, isolation: 'container' as const, resources: policy.resources,
        temporaryStorage: policy.temporaryStorage, network: policy.network,
        files: policy.files,
        nonRoot: true as const, readOnlyRoot: true as const, workspaceDiskQuota: Object.freeze({ kind: 'not_requested' as const }) }),
      files: this.filesystem?.files,
      workspace: parseSandboxGuestPath('/workspace/work'),
      openSpill: (operation?: OperationOptions) => createSandboxSpillStore({ directory: this.config.spillDirectory, signal: operation?.signal }),
      importTree: (entries: AsyncIterable<SandboxInputTreeEntry>, operation: SandboxDriverTransferOptions) => this.importTree(entries, operation),
      reserveProcess: (spec: SandboxProcessSpec) => {
        this.assertOpen();
        if (this.process) throw new SandboxStateError('Docker admits only one process reservation.');
        this.process = new DockerProcessOwner(this.api, this.config, compute.id, spec, policy, async (signal) => {
          this.assertOpen(signal);
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
    return importWorkspace(this.api, compute.id, entries, this.config.user, options, this.hasResource('filesystem'));
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

  private async startDesktopObserver(signal?: AbortSignal): Promise<ResourceInspection> {
    const identity = desktopObserverIdentity(this.config);
    const observer = await this.createResource('route_observer', signal, async (resource) => {
      const created = await this.api.json('POST', `${DOCKER_API}/containers/create?name=${encodeURIComponent(resource.name)}&platform=linux%2Farm64`,
        containerCreatedSchema, { body: desktopObserverContainerBody(this.config, this.current) });
      return { id: created.Id, warning: Boolean(created.Warnings?.length) };
    }, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker did not inspect the acquired Desktop observer.');
      verifyDesktopObserverContainer(inspection.container, this.config, false);
    });
    this.assertOpen(signal);
    const attachment = await this.api.upgrade(`${DOCKER_API}/containers/${observer.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined, signal);
    const control = createDesktopVmObserverClient({ attachment, configuration: desktopObserverConfiguration(identity),
      onFailure: (error) => this.infrastructureFailed(error) });
    this.desktopObserver = control;
    try {
      this.assertOpen(signal);
      await this.assertAuthority(signal);
      await this.api.request('POST', `${DOCKER_API}/containers/${observer.id}/start`, { signal });
      await control.ready;
      this.assertOpen(signal);
      const running = await this.requirePresent('route_observer', signal);
      if (!running.container) throw new SandboxStateError('Desktop observer disappeared before readiness.');
      verifyDesktopObserverContainer(running.container, this.config, true);
      return running;
    } catch (cause) {
      try { await control.close(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Desktop observer startup and control cleanup failed.'); }
      throw cause;
    }
  }

  private async startHelper(socketVolumeId: string, placement: EgressHelperPlacement, signal?: AbortSignal): Promise<ResourceInspection> {
    const egress = this.config.egress;
    if (!egress) throw new SandboxStateError('Helper startup requires admitted egress configuration.');
    const platform = `linux/${dockerProfile(this.config.profile).helperImageArchitecture}`;
    const helper = await this.createResource(placement.role, signal, async (resource) => {
      const created = await this.api.json('POST', `${DOCKER_API}/containers/create?name=${encodeURIComponent(resource.name)}&platform=${encodeURIComponent(platform)}`,
        containerCreatedSchema, { body: helperContainerBody(this.config, this.current, socketVolumeId, placement) });
      return { id: created.Id, warning: Boolean(created.Warnings?.length) };
    }, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker did not inspect its acquired egress helper.');
      verifyHelperContainer(inspection.container, this.config, socketVolumeId, placement, false);
    });
    this.assertOpen(signal);
    const attachment = await this.api.upgrade(`${DOCKER_API}/containers/${helper.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined, signal);
    const control = createEgressHelperController({ attachment, role: placement.configuration.role,
      heartbeatMs: egress.control.heartbeatMs, leaseTimeoutMs: egress.control.leaseTimeoutMs,
      onFailure: (error) => this.infrastructureFailed(error) });
    this.helperControls.set(placement.role, control);
    try {
      this.assertOpen(signal);
      await this.assertAuthority(signal);
      await this.api.request('POST', `${DOCKER_API}/containers/${helper.id}/start`, { signal });
      await control.ready;
      this.assertOpen(signal);
      const running = await this.requirePresent(placement.role, signal);
      if (!running.container) throw new SandboxStateError('Docker helper disappeared before readiness.');
      verifyHelperContainer(running.container, this.config, socketVolumeId, placement, true);
      return running;
    } catch (cause) {
      // A stop can race the attach handoff after its initial controls census.
      // Join this newly received handle before allowing startup to settle.
      try { await control.close(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Egress helper startup and control cleanup failed.'); }
      throw cause;
    }
  }

  private async startFilesystem(storageId: string, access: FilesystemAccess, signal?: AbortSignal): Promise<DockerFilesystem> {
    const filesystem = this.config.filesystem;
    if (!filesystem) throw new SandboxStateError('Filesystem startup requires its explicit prepared image.');
    const platform = `linux/${dockerProfile(this.config.profile).helperImageArchitecture}`;
    const helper = await this.createResource('filesystem', signal, async (resource) => {
      const created = await this.api.json('POST', `${DOCKER_API}/containers/create?name=${encodeURIComponent(resource.name)}&platform=${encodeURIComponent(platform)}`,
        containerCreatedSchema, { body: filesystemContainerBody(this.config, this.current, storageId, access) });
      return { id: created.Id, warning: Boolean(created.Warnings?.length) };
    }, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker did not inspect the acquired filesystem helper.');
      verifyFilesystemContainer(inspection.container, this.config, storageId, access, false);
    });
    this.assertOpen(signal);
    const attachment = await this.api.upgrade(`${DOCKER_API}/containers/${helper.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined, signal);
    const channel = new FilesystemChannel(attachment, filesystem, (error) => this.infrastructureFailed(error));
    this.filesystemChannel = channel;
    const verify = async (signal?: AbortSignal) => {
      this.assertOpen(signal);
      await this.assertAuthority(signal);
      const current = await this.requirePresent('filesystem', signal);
      if (!current.container) throw new SandboxStateError('Filesystem helper disappeared before admission.');
      verifyFilesystemContainer(current.container, this.config, storageId, access, true);
      this.assertOpen(signal);
    };
    try {
      this.assertOpen(signal);
      await this.assertAuthority(signal);
      await this.api.request('POST', `${DOCKER_API}/containers/${helper.id}/start`, { signal });
      await channel.ready;
      await verify(signal);
      return new DockerFilesystem(channel, access, verify);
    } catch (cause) {
      try { await channel.close(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Filesystem startup and control cleanup failed.'); }
      throw cause;
    }
  }

  private installEgressHealth(policy: SandboxPolicy, storageId: string, socketVolumeId: string, networkId: string,
    brokerId: string, broker: Extract<EgressHelperPlacement, { role: 'egress_broker' }>,
    relay: Extract<EgressHelperPlacement, { role: 'egress_relay' }>): void {
    const lease = this.routeLease;
    if (!lease) throw new SandboxStateError('Restricted readiness requires its original route lease.');
    const check = async (signal?: AbortSignal) => {
      this.assertOpen(signal);
      await lease.assertCurrent(signal);
      await this.assertAuthority(signal);
      if (this.config.profile === 'linux-x64') await verifyEgressDeployment(this.api, this.config, lease.census, signal);
      else {
        const observer = await this.requirePresent('route_observer', signal);
        if (!observer.container) throw new SandboxStateError('Restricted Desktop observer is absent.');
        verifyDesktopObserverContainer(observer.container, this.config, true);
      }
      const compute = await this.requirePresent('compute', signal);
      if (!compute.container) throw new SandboxStateError('Restricted workload is absent.');
      verifyContainer(compute.container, this.config, policy, 'compute', storageId, networkId, true, this.hasResource('filesystem'));
      for (const placement of [broker, relay]) {
        const helper = await this.requirePresent(placement.role, signal);
        if (!helper.container) throw new SandboxStateError('Restricted helper is absent.');
        verifyHelperContainer(helper.container, this.config, socketVolumeId, placement, true);
      }
      await this.requirePresent('egress_socket', signal);
      await this.requirePresent('network', signal);
      await verifyNetworkMembership(this.api, networkId, [brokerId], signal);
      this.assertOpen(signal);
    };
    this.checkEgress = (signal) => {
      const actual = this.healthActual.then(() => check(signal)).catch((cause: unknown) => {
        if (!this.closed && !signal?.aborted) this.infrastructureFailed(cause instanceof SandboxOperationError ? cause
          : new SandboxOperationError('driver_failure', 'Restricted sandbox authority or infrastructure failed.', { cause }));
        throw cause;
      });
      this.healthActual = actual.catch(() => {});
      return actual;
    };
  }

  private scheduleHealth(): void {
    const check = this.checkEgress;
    const egress = this.config.egress;
    if (this.closed || !check || !egress) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined;
      void check(this.healthController.signal).catch(() => {}).then(() => this.scheduleHealth());
    }, egress.routeAuthority.pollIntervalMs);
    this.healthTimer.unref();
  }

  private infrastructureFailed(error: SandboxOperationError): void {
    if (this.closed) return;
    this.closed = true;
    this.process?.closeAdmission();
    this.filesystemChannel?.closeAdmission();
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
    return exportWorkspace(this.api, accessor.id, selection, consume, options, this.hasResource('filesystem'));
  }

  private async createResource(role: ResourceRole, signal: AbortSignal | undefined,
    create: (resource: SandboxRecoveryResource) => Promise<{ id: string; warning?: boolean }>, validate?: (inspection: ResourceInspection) => void): Promise<ResourceInspection> {
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

  stop(): Promise<void> {
    this.closed = true;
    this.process?.closeAdmission();
    this.filesystemChannel?.closeAdmission();
    this.stopActual ??= this.cleanupCompute().catch((error: unknown) => { this.stopActual = undefined; throw error; });
    return this.stopActual;
  }

  private async cleanupCompute(): Promise<void> {
    this.cleanupPhase('stopping');
    clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    this.healthController.abort(new SandboxOperationError('cancelled', 'Sandbox infrastructure is stopping.'));
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
    await this.healthActual;
    if (failures.length) throw new AggregateError(failures, 'Sandbox infrastructure cleanup retains unresolved ownership.');
    this.cleanupPhase('stopped');
    await this.checkpointTail;
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
    await this.assertAuthority();
    const inspection = await this.resolveResource(role);
    if (!inspection) { this.absent.add(role); return; }
    const id = encodeURIComponent(inspection.id);
    const kind = resourceKind(role);
    const path = kind === 'container' ? `${DOCKER_API}/containers/${id}?force=true&v=false`
      : kind === 'volume' ? `${DOCKER_API}/volumes/${id}` : `${DOCKER_API}/networks/${id}`;
    await this.api.request('DELETE', path, { statuses: [204, 404] });
    const remaining = await this.resolveResource(role);
    if (remaining) throw new SandboxStateError('Docker acknowledged removal but the exact resource remains present.');
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
    const writing = this.checkpoint?.(record) ?? Promise.resolve();
    this.checkpointTail = Promise.allSettled([this.checkpointTail, writing]).then(() => {});
    return writing;
  }

  private async assertAuthority(signal?: AbortSignal): Promise<void> {
    if (this.current.authority.kind !== 'verified' || await verifyDaemon(this.api, this.config, signal) !== this.current.authority.backendIdentity) {
      throw new SandboxStateError('Docker resource operations cannot act on a different or unverified daemon.');
    }
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted) throw new SandboxOperationError('cancelled', 'Docker sandbox admission is closed.');
  }
}
