import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { SandboxStateError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import { DOCKER_API } from '../../policy/config.js';
import { verifyImageInspectionDaemon } from '../../policy/preflight.js';
import { dockerProfile } from '../../policy/profiles.js';
import type { DockerApi } from '../../resources/api.js';
import type { DockerImageInspectionCleanup, DockerImageInspectionCleanupIdentity, DockerImageInspectionOptions } from './contracts.js';

const PREFIX = 'ai.agen.image-inspection.';
const idSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const containerSchema = z.object({ Id: idSchema, Name: z.string().max(256), Created: z.string().min(1).max(64), Image: z.string(),
  Config: z.object({ Image: z.string(), Labels: z.record(z.string().max(256), z.string().max(4096)) }),
  State: z.object({ Running: z.boolean(), Status: z.string() }), Mounts: z.array(z.unknown()).max(256) });
const createdSchema = z.object({ Id: idSchema, Warnings: z.array(z.string()).nullish() });

type Identity = { readonly kind: 'unentered' } | { readonly kind: 'creating' }
  | { readonly kind: 'identified'; readonly id: string; readonly created?: string } | { readonly kind: 'absent' };

export class ImageInspectionOwner implements DockerImageInspectionCleanup {
  readonly identity: DockerImageInspectionCleanupIdentity;
  private resource: Identity = { kind: 'unentered' };
  private cleanup: Promise<void> | undefined;

  constructor(private readonly api: DockerApi, private readonly options: DockerImageInspectionOptions, daemonId: string) {
    const operation = randomUUID();
    this.identity = Object.freeze({ endpoint: options.endpoint, imageDigest: options.imageDigest, profile: options.profile, daemonId,
      name: `agenai-image-inspection-${operation}`, labels: Object.freeze({
        [`${PREFIX}protocol`]: 'agenai.image-inspection.v1', [`${PREFIX}operation`]: operation,
        [`${PREFIX}daemon`]: daemonId, [`${PREFIX}image`]: options.imageDigest,
      }) });
  }

  async create(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.resource = { kind: 'creating' };
    const platform = `linux/${dockerProfile(this.options.profile).workloadImageArchitecture}`;
    const created = await this.api.json('POST', `${DOCKER_API}/containers/create?name=${this.identity.name}&platform=${encodeURIComponent(platform)}`, createdSchema, { signal,
      body: { Image: this.options.imageDigest, Labels: this.identity.labels, User: '0:0', WorkingDir: '/', Env: [],
        Entrypoint: ['/nonexistent/agenai-image-inspection'], Cmd: [], Tty: false, OpenStdin: false, NetworkDisabled: true,
        HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
          RestartPolicy: { Name: 'no' }, AutoRemove: false, Mounts: [], Memory: 16 * 1024 ** 2, MemorySwap: 16 * 1024 ** 2, PidsLimit: 1 } } });
    this.resource = { kind: 'identified', id: created.Id };
    if (created.Warnings?.length) throw new SandboxUnsupportedError('Docker warned while creating the image inspection container.');
    const actual = await this.inspect(signal);
    if (!actual || actual.Id !== created.Id) throw new SandboxStateError('Docker did not confirm the exact inspection container.');
    if (actual.State.Running || actual.State.Status !== 'created' || actual.Mounts.length !== 0) {
      throw new SandboxStateError('Image inspection requires a never-started container without mounts.');
    }
    return actual.Id;
  }

  async assertDaemon(signal?: AbortSignal): Promise<void> {
    if (await verifyImageInspectionDaemon(this.api, this.options.profile, signal) !== this.identity.daemonId) {
      throw new SandboxStateError('Image inspection cannot act on a replacement Docker daemon.');
    }
  }

  private async inspect(signal?: AbortSignal) {
    const resource = this.resource;
    if (resource.kind === 'unentered' || resource.kind === 'absent') return undefined;
    const reference = resource.kind === 'identified' ? resource.id : this.identity.name;
    const response = await this.api.request('GET', `${DOCKER_API}/containers/${reference}/json`, { statuses: [200, 404], signal });
    if (response.statusCode === 404) {
      if (resource.kind === 'creating') throw new SandboxStateError('An absent inspection name cannot settle an entered unknown create.');
      return undefined;
    }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(response.body).toString('utf8')); }
    catch { throw new SandboxStateError('Docker inspection ownership response is not JSON.'); }
    const actual = containerSchema.parse(raw);
    const labels = actual.Config.Labels;
    if (actual.Name !== `/${this.identity.name}` || actual.Image !== this.identity.imageDigest || actual.Config.Image !== this.identity.imageDigest
      || Object.entries(this.identity.labels).some(([key, value]) => labels[key] !== value)
      || Object.keys(labels).some((key) => key.startsWith(PREFIX) && !Object.hasOwn(this.identity.labels, key))
      || resource.kind === 'identified' && (resource.id !== actual.Id || resource.created !== undefined && resource.created !== actual.Created)) {
      throw new SandboxStateError('Inspection cleanup refuses a resource with different original identity, name, image or owner labels.');
    }
    this.resource = { kind: 'identified', id: actual.Id, created: actual.Created };
    return actual;
  }

  retryCleanup(): Promise<void> {
    this.cleanup ??= this.remove().catch((error: unknown) => { this.cleanup = undefined; throw error; });
    return this.cleanup;
  }

  private async remove(): Promise<void> {
    if (this.resource.kind === 'unentered' || this.resource.kind === 'absent') return;
    await this.assertDaemon();
    const actual = await this.inspect();
    if (!actual) { this.resource = { kind: 'absent' }; return; }
    await this.api.request('DELETE', `${DOCKER_API}/containers/${actual.Id}?force=true&v=false`, { statuses: [204, 404] });
    if (await this.inspect()) throw new SandboxStateError('Docker acknowledged inspection cleanup but the exact original container remains.');
    this.resource = { kind: 'absent' };
  }
}
