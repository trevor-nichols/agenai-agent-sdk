// ------------------------------------------------------------------------------------------------
//                infrastructure.ts - Original helper controls, readiness and restricted-egress health
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxPolicy, SandboxRecoveryRecord, SandboxRecoveryResource } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../policy/config.js';
import { DOCKER_API } from '../policy/config.js';
import { dockerProfile } from '../policy/profiles.js';
import { verifyEgressDeployment } from '../policy/preflight.js';
import { verifyContainer } from '../policy/container.js';
import { helperContainerBody, verifyHelperContainer } from '../policy/helperContainer.js';
import type { EgressHelperPlacement } from '../policy/helperContainer.js';
import { filesystemContainerBody, verifyFilesystemContainer } from '../policy/filesystem.js';
import type { FilesystemAccess } from '../policy/filesystem.js';
import { desktopObserverConfiguration, desktopObserverContainerBody, desktopObserverIdentity,
  verifyDesktopObserverContainer } from '../policy/desktopObserver.js';
import { FilesystemChannel } from '../workspace/live/channel.js';
import { DockerFilesystem } from '../workspace/live/files.js';
import { createDesktopVmObserverClient } from '../network/desktop/client.js';
import type { DesktopVmObserverClient } from '../network/desktop/client.js';
import { createEgressHelperController } from '../network/controller.js';
import type { EgressHelperController } from '../network/controller.js';
import type { DockerRouteLease } from '../network/census.js';
import type { DesktopCoordinatorControlledRole, DesktopCoordinatorMember, DesktopCoordinatorStartedRole } from '../network/desktop/coordinator/member.js';
import type { ResourceRole } from '../recovery/identity.js';
import type { DockerApi } from './api.js';
import { containerCreatedSchema } from './responses.js';
import { verifyNetworkMembership } from './inspect.js';
import type { ResourceInspection } from './inspect.js';

interface InfrastructureResources {
  readonly api: DockerApi;
  readonly config: DockerSandboxConfig;
  record(): SandboxRecoveryRecord;
  member(): DesktopCoordinatorMember | undefined;
  routeLease(): DockerRouteLease | undefined;
  closed(): boolean;
  assertOpen(signal?: AbortSignal): void;
  assertAuthority(signal?: AbortSignal): Promise<void>;
  requirePresent(role: ResourceRole, signal?: AbortSignal): Promise<ResourceInspection>;
  hasResource(role: ResourceRole): boolean;
  createResource(role: ResourceRole, signal: AbortSignal | undefined,
    create: (resource: SandboxRecoveryResource) => Promise<{ id: string; warning?: boolean }>,
    validate?: (inspection: ResourceInspection) => void): Promise<ResourceInspection>;
  startContainer(role: DesktopCoordinatorStartedRole, signal: AbortSignal | undefined,
    ready: Promise<void> | undefined, validate: (inspection: ResourceInspection) => void,
    beginReadiness?: () => void): Promise<ResourceInspection>;
  failed(error: SandboxOperationError): void;
  controlFailed(role: DesktopCoordinatorControlledRole, error: SandboxOperationError): void;
}

export class DockerInfrastructure {
  readonly helperControls = new Map<'egress_broker' | 'egress_relay', EgressHelperController>();
  filesystemChannel: FilesystemChannel | undefined;
  desktopObserver: DesktopVmObserverClient | undefined;
  private readonly healthController = new AbortController();
  private healthTimer: ReturnType<typeof setTimeout> | undefined;
  private healthActual: Promise<void> = Promise.resolve();
  private checkEgressActual: ((signal?: AbortSignal) => Promise<void>) | undefined;

  constructor(private readonly resources: InfrastructureResources) {}

  get checkEgress() { return this.checkEgressActual; }
  get healthSettled(): Promise<void> { return this.healthActual; }

  stopRenewal(): void {
    this.stopHealth();
    for (const control of this.helperControls.values()) control.stopRenewal();
    this.desktopObserver?.stopRenewal();
    this.filesystemChannel?.stopRenewal();
  }

  async startDesktopObserver(signal?: AbortSignal): Promise<ResourceInspection> {
    const identity = desktopObserverIdentity(this.resources.config);
    const observer = await this.resources.createResource('route_observer', signal, async (resource) => {
      const created = await this.resources.api.json('POST', `${DOCKER_API}/containers/create?name=${encodeURIComponent(resource.name)}&platform=linux%2Farm64`,
        containerCreatedSchema, { body: desktopObserverContainerBody(this.resources.config, this.resources.record()) });
      return { id: created.Id, warning: Boolean(created.Warnings?.length) };
    }, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker did not inspect the acquired Desktop observer.');
      verifyDesktopObserverContainer(inspection.container, this.resources.config, false);
    });
    this.resources.assertOpen(signal);
    const attachment = await this.resources.api.upgrade(`${DOCKER_API}/containers/${observer.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined, signal);
    const control = createDesktopVmObserverClient({ attachment, configuration: desktopObserverConfiguration(identity),
      onFailure: (error) => this.resources.controlFailed('route_observer', error) });
    this.desktopObserver = control;
    if (this.resources.closed()) control.stopRenewal();
    this.resources.member()?.observer(observer.id, control);
    try {
      this.resources.assertOpen(signal);
      await this.resources.assertAuthority(signal);
      const running = await this.resources.startContainer('route_observer', signal, control.ready, (inspection) => {
        if (!inspection.container) throw new SandboxStateError('Desktop observer disappeared before readiness.');
        verifyDesktopObserverContainer(inspection.container, this.resources.config, true);
      }, () => control.beginReadiness());
      return running;
    } catch (cause) {
      try { await this.closeControl('route_observer', () => control.close()); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Desktop observer startup and control cleanup failed.'); }
      throw cause;
    }
  }

  async startHelper(socketVolumeId: string, placement: EgressHelperPlacement, signal?: AbortSignal): Promise<ResourceInspection> {
    const egress = this.resources.config.egress;
    if (!egress) throw new SandboxStateError('Helper startup requires admitted egress configuration.');
    const platform = `linux/${dockerProfile(this.resources.config.profile).helperImageArchitecture}`;
    const helper = await this.resources.createResource(placement.role, signal, async (resource) => {
      const created = await this.resources.api.json('POST', `${DOCKER_API}/containers/create?name=${encodeURIComponent(resource.name)}&platform=${encodeURIComponent(platform)}`,
        containerCreatedSchema, { body: helperContainerBody(this.resources.config, this.resources.record(), socketVolumeId, placement) });
      return { id: created.Id, warning: Boolean(created.Warnings?.length) };
    }, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker did not inspect its acquired egress helper.');
      verifyHelperContainer(inspection.container, this.resources.config, socketVolumeId, placement, false);
    });
    this.resources.assertOpen(signal);
    const attachment = await this.resources.api.upgrade(`${DOCKER_API}/containers/${helper.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined, signal);
    const control = createEgressHelperController({ attachment, role: placement.configuration.role,
      heartbeatMs: egress.control.heartbeatMs, leaseTimeoutMs: egress.control.leaseTimeoutMs,
      onFailure: (error) => this.resources.controlFailed(placement.role, error) });
    this.helperControls.set(placement.role, control);
    if (this.resources.closed()) control.stopRenewal();
    try {
      this.resources.assertOpen(signal);
      await this.resources.assertAuthority(signal);
      const running = await this.resources.startContainer(placement.role, signal, control.ready, (inspection) => {
        if (!inspection.container) throw new SandboxStateError('Docker helper disappeared before readiness.');
        verifyHelperContainer(inspection.container, this.resources.config, socketVolumeId, placement, true);
      }, () => control.beginReadiness());
      return running;
    } catch (cause) {
      // A stop can race the attach handoff after its initial controls census.
      // Join this newly received handle before allowing startup to settle.
      try { await this.closeControl(placement.role, () => control.close()); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Egress helper startup and control cleanup failed.'); }
      throw cause;
    }
  }

  async startFilesystem(storageId: string, access: FilesystemAccess, signal?: AbortSignal): Promise<DockerFilesystem> {
    const filesystem = this.resources.config.filesystem;
    if (!filesystem) throw new SandboxStateError('Filesystem startup requires its explicit prepared image.');
    const platform = `linux/${dockerProfile(this.resources.config.profile).helperImageArchitecture}`;
    const helper = await this.resources.createResource('filesystem', signal, async (resource) => {
      const created = await this.resources.api.json('POST', `${DOCKER_API}/containers/create?name=${encodeURIComponent(resource.name)}&platform=${encodeURIComponent(platform)}`,
        containerCreatedSchema, { body: filesystemContainerBody(this.resources.config, this.resources.record(), storageId, access) });
      return { id: created.Id, warning: Boolean(created.Warnings?.length) };
    }, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker did not inspect the acquired filesystem helper.');
      verifyFilesystemContainer(inspection.container, this.resources.config, storageId, access, false);
    });
    this.resources.assertOpen(signal);
    const attachment = await this.resources.api.upgrade(`${DOCKER_API}/containers/${helper.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined, signal);
    const channel = new FilesystemChannel(attachment, filesystem, (error) => this.resources.controlFailed('filesystem', error));
    this.filesystemChannel = channel;
    if (this.resources.closed()) channel.stopRenewal();
    const verify = async (signal?: AbortSignal) => {
      this.resources.assertOpen(signal);
      await this.resources.assertAuthority(signal);
      const current = await this.resources.requirePresent('filesystem', signal);
      if (!current.container) throw new SandboxStateError('Filesystem helper disappeared before admission.');
      verifyFilesystemContainer(current.container, this.resources.config, storageId, access, true);
      this.resources.assertOpen(signal);
    };
    try {
      this.resources.assertOpen(signal);
      await this.resources.assertAuthority(signal);
      await this.resources.startContainer('filesystem', signal, channel.ready, (inspection) => {
        if (!inspection.container) throw new SandboxStateError('Filesystem helper disappeared before readiness.');
        verifyFilesystemContainer(inspection.container, this.resources.config, storageId, access, true);
      }, () => channel.beginReadiness());
      await verify(signal);
      return new DockerFilesystem(channel, access, verify);
    } catch (cause) {
      try { await this.closeControl('filesystem', () => channel.close()); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Filesystem startup and control cleanup failed.'); }
      throw cause;
    }
  }

  installEgressHealth(policy: SandboxPolicy, storageId: string, socketVolumeId: string, networkId: string,
    brokerId: string, broker: Extract<EgressHelperPlacement, { role: 'egress_broker' }>,
    relay: Extract<EgressHelperPlacement, { role: 'egress_relay' }>): void {
    const member = this.resources.member();
    const lease = member ? { assertCurrent: (signal?: AbortSignal) => member.assertCurrent(signal) } : this.resources.routeLease();
    if (!lease) throw new SandboxStateError('Restricted readiness requires its original route lease.');
    const check = async (signal?: AbortSignal) => {
      this.resources.assertOpen(signal);
      await lease.assertCurrent(signal);
      await this.resources.assertAuthority(signal);
      if (this.resources.config.profile === 'linux-x64') {
        const routeLease = this.resources.routeLease();
        if (!routeLease) throw new SandboxStateError('Linux restricted readiness lost its original route lease.');
        await verifyEgressDeployment(this.resources.api, this.resources.config, routeLease.census, signal);
      }
      else {
        const observer = await this.resources.requirePresent('route_observer', signal);
        if (!observer.container) throw new SandboxStateError('Restricted Desktop observer is absent.');
        verifyDesktopObserverContainer(observer.container, this.resources.config, true);
      }
      const compute = await this.resources.requirePresent('compute', signal);
      if (!compute.container) throw new SandboxStateError('Restricted workload is absent.');
      verifyContainer(compute.container, this.resources.config, policy, 'compute', storageId, networkId, true, this.resources.hasResource('filesystem'));
      for (const placement of [broker, relay]) {
        const helper = await this.resources.requirePresent(placement.role, signal);
        if (!helper.container) throw new SandboxStateError('Restricted helper is absent.');
        verifyHelperContainer(helper.container, this.resources.config, socketVolumeId, placement, true);
      }
      await this.resources.requirePresent('egress_socket', signal);
      await this.resources.requirePresent('network', signal);
      await verifyNetworkMembership(this.resources.api, networkId, [brokerId], signal);
      this.resources.assertOpen(signal);
    };
    this.checkEgressActual = (signal) => {
      const actual = this.healthActual.then(() => check(signal)).catch((cause: unknown) => {
        if (!this.resources.closed() && !signal?.aborted) this.resources.failed(cause instanceof SandboxOperationError ? cause
          : new SandboxOperationError('driver_failure', 'Restricted sandbox authority or infrastructure failed.', { cause }));
        throw cause;
      });
      this.healthActual = actual.catch(() => {});
      return actual;
    };
  }

  scheduleHealth(): void {
    const check = this.checkEgressActual;
    const egress = this.resources.config.egress;
    if (this.resources.closed() || !check || !egress) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined;
      void check(this.healthController.signal).catch(() => {}).then(() => this.scheduleHealth());
    }, egress.routeAuthority.pollIntervalMs);
    this.healthTimer.unref();
  }

  closeControl(role: DesktopCoordinatorControlledRole, close: () => Promise<unknown>): Promise<void> {
    const member = this.resources.member();
    return member ? member.controlClose(role, close) : close().then(() => {});
  }

  closeFilesAdmission(): void {
    if (this.resources.member()) this.filesystemChannel?.closeRequests();
    else this.filesystemChannel?.closeAdmission();
  }

  stopHealth(): void {
    clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    this.healthController.abort(new SandboxOperationError('cancelled', 'Sandbox infrastructure is stopping.'));
  }
}
