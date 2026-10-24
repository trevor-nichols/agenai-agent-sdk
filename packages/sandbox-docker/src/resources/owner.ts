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
import { assertDockerController, assertDockerPolicy, verifyDaemon, verifyDatasetImages, verifyImage } from '../policy/preflight.js';
import { dockerProfile } from '../policy/profiles.js';
import { containerBody, verifyContainer } from '../policy/container.js';
import { newRecoveryRecord, resourceLabels } from '../recovery/identity.js';
import type { ResourceRole } from '../recovery/identity.js';
import { importWorkspace } from '../workspace/imports.js';
import { exportWorkspace } from '../workspace/exports.js';
import { DockerApi } from './api.js';
import { DockerProcessOwner } from '../process/owner.js';
import { MAX_DATASET_ATTACHMENTS } from '../datasets/configuration.js';
import { hasUnexpectedImageMountWarnings } from '../datasets/warnings.js';
import { inspectResource } from './inspect.js';
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
    this.assertOpen(options.signal);
    await this.publish({ ...this.current, phase: 'starting', authority: { kind: 'verified', backendIdentity } });
    const storage = await this.createResource('storage', options.signal, async (resource) => {
      const result = await this.api.json('POST', `${DOCKER_API}/volumes/create`, volumeCreatedSchema,
        { body: { Name: resource.name, Driver: 'local', Labels: resourceLabels(this.current, 'storage') } });
      return { id: result.Name };
    });
    const network = policy.network.kind === 'outbound' ? await this.createResource('network', options.signal, async (resource) => {
      const result = await this.api.json('POST', `${DOCKER_API}/networks/create`, networkCreatedSchema, { body: {
        Name: resource.name, Driver: 'bridge', Internal: false, Attachable: false, Ingress: false,
        EnableIPv6: false, CheckDuplicate: true, Labels: resourceLabels(this.current, 'network'),
      } });
      return { id: result.Id, warning: Boolean(result.Warning) };
    }) : undefined;
    const platform = `linux/${dockerProfile(this.config.profile).imageArchitecture}`;
    const createContainer = (role: 'compute' | 'export') => this.createResource(role, options.signal, async (resource) => {
      const result = await this.api.json('POST', `${DOCKER_API}/containers/create?name=${encodeURIComponent(resource.name)}&platform=${encodeURIComponent(platform)}`,
        containerCreatedSchema, { body: containerBody(this.config, this.current, policy, role, storage.id, network?.id) });
      return { id: result.Id,
        warning: hasUnexpectedImageMountWarnings(result.Warnings ?? [], role === 'compute' ? this.config.datasets.length : 0) };
    }, (inspection) => {
      if (!inspection.container) throw new SandboxStateError('Docker did not inspect the created container.');
      verifyContainer(inspection.container, this.config, policy, role, storage.id, network?.id, false);
    });
    const compute = await createContainer('compute');
    await createContainer('export');
    this.assertOpen(options.signal);
    await this.assertAuthority(options.signal);
    await importWorkspace(this.api, compute.id, (async function* () {})(), this.config.user, {
      signal: options.signal ?? new AbortController().signal, buffers: policy.transfers, quotas: {},
    });
    this.assertOpen(options.signal);
    await this.assertAuthority(options.signal);
    await this.api.request('POST', `${DOCKER_API}/containers/${compute.id}/start`, { signal: options.signal });
    this.assertOpen(options.signal);
    const running = await inspectResource(this.api, this.current, this.resource('compute'), compute.id, options.signal);
    if (!running?.container) throw new SandboxStateError('Docker workload disappeared during startup.');
    verifyContainer(running.container, this.config, policy, 'compute', storage.id, network?.id, true);
    await this.publish({ ...this.current, phase: 'running' });
    this.assertOpen(options.signal);
    return Object.freeze({
      effective: Object.freeze({ backendIdentity, isolation: 'container' as const, resources: policy.resources,
        temporaryStorage: policy.temporaryStorage, network: policy.network,
        nonRoot: true as const, readOnlyRoot: true as const, workspaceDiskQuota: Object.freeze({ kind: 'not_requested' as const }) }),
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
    this.assertOpen(options.signal);
    return importWorkspace(this.api, compute.id, entries, this.config.user, options);
  }

  private async exportTree(selection: SandboxInputTreeSelection, consume: SandboxExportConsumer, options: SandboxDriverTransferOptions,
    policy: SandboxPolicy, storageId: string, networkId: string | undefined) {
    await this.assertAuthority(options.signal);
    if (await this.resolveResource('compute', options.signal)) throw new SandboxStateError('Workspace export requires exact compute absence.');
    await this.requirePresent('storage', options.signal);
    const accessor = await this.requirePresent('export', options.signal);
    if (!accessor.container) throw new SandboxStateError('Workspace export requires the exact archive accessor.');
    verifyContainer(accessor.container, this.config, policy, 'export', storageId, networkId, false);
    return exportWorkspace(this.api, accessor.id, selection, consume, options);
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
    const inspection = await inspectResource(this.api, this.current, resource, id);
    if (!inspection || inspection.id !== id) throw new SandboxStateError('Docker did not confirm the exact created resource ID.');
    validate?.(inspection);
    await this.updateIdentity(role, { kind: 'identified', id, fingerprint: inspection.fingerprint });
    this.assertOpen(signal);
    return inspection;
  }

  stop(): Promise<void> {
    this.closed = true;
    this.process?.closeAdmission();
    this.stopActual ??= this.cleanupCompute().catch((error: unknown) => { this.stopActual = undefined; throw error; });
    return this.stopActual;
  }

  private async cleanupCompute(): Promise<void> {
    this.cleanupPhase('stopping');
    const entered = this.createEffects.get('compute');
    // Persistence may be blocked after compute becomes live. Initiate removal before joining it.
    if (entered || !this.request) {
      try { await this.deleteResource('compute'); }
      catch (error) { if (!entered) throw error; }
      await entered?.catch(() => {});
      if (!this.absent.has('compute')) await this.deleteResource('compute');
    }
    await this.process?.computeStopped();
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
    for (const role of ['export', 'storage', 'network'] satisfies ResourceRole[]) {
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
    const inspection = await inspectResource(this.api, this.current, resource, reference, signal);
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
    const path = role === 'compute' || role === 'export' ? `${DOCKER_API}/containers/${id}?force=true&v=false`
      : role === 'storage' ? `${DOCKER_API}/volumes/${id}` : `${DOCKER_API}/networks/${id}`;
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
