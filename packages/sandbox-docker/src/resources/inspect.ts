// ------------------------------------------------------------------------------------------------
//                inspect.ts - Resource inspection and ownership proof - Docker response boundary
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord, SandboxRecoveryResource } from '@agen-ai/sandbox';
import { DOCKER_API } from '../policy/config.js';
import { assertLabels, digest } from '../recovery/identity.js';
import type { DockerApi } from './api.js';
import { containerFingerprint } from './fingerprint.js';

const labelsSchema = z.record(z.string(), z.string());
const mountSchema = z.object({ Type: z.string(), Name: z.string().optional(), Source: z.string(), Destination: z.string(), RW: z.boolean(), Propagation: z.string().optional() }).passthrough();
export const containerSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/u), Name: z.string(), Image: z.string(),
  Config: z.object({ Labels: labelsSchema, Image: z.string(), User: z.string(), WorkingDir: z.string(),
    Entrypoint: z.array(z.string()).nullable(), Cmd: z.array(z.string()).nullable(), Env: z.array(z.string()).nullable(),
    Tty: z.boolean(), OpenStdin: z.boolean(), Volumes: z.record(z.string(), z.unknown()).nullish() }).passthrough(),
  HostConfig: z.object({}).passthrough(), Mounts: z.array(mountSchema),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ NetworkID: z.string() })), Ports: z.record(z.string(), z.unknown()).nullable() }),
  State: z.object({ Running: z.boolean(), Status: z.string() }).passthrough(), AppArmorProfile: z.string(),
}).passthrough();
const volumeSchema = z.object({ Name: z.string(), Driver: z.string(), Mountpoint: z.string(), CreatedAt: z.string(), Labels: labelsSchema,
  Options: z.record(z.string(), z.string()).nullable(), Scope: z.string() });
const networkSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u), Name: z.string(), Created: z.string(), Driver: z.string(), Scope: z.string(),
  Internal: z.boolean(), Attachable: z.boolean(), Ingress: z.boolean(), EnableIPv6: z.boolean(), ConfigOnly: z.boolean(),
  IPAM: z.object({}).passthrough(), Options: z.record(z.string(), z.string()), Labels: labelsSchema,
});

export type ContainerInspection = z.infer<typeof containerSchema>;
export interface ResourceInspection { readonly id: string; readonly fingerprint: string; readonly container?: ContainerInspection }

export function inspectPath(resource: SandboxRecoveryResource, identity: string): string {
  const encoded = encodeURIComponent(identity);
  if (resource.role === 'compute' || resource.role === 'export') return `${DOCKER_API}/containers/${encoded}/json`;
  if (resource.role === 'storage') return `${DOCKER_API}/volumes/${encoded}`;
  return `${DOCKER_API}/networks/${encoded}`;
}

export async function inspectResource(api: DockerApi, record: SandboxRecoveryRecord, resource: SandboxRecoveryResource,
  reference: string, signal?: AbortSignal): Promise<ResourceInspection | undefined> {
  const response = await api.request('GET', inspectPath(resource, reference), { statuses: [200, 404], signal });
  if (response.statusCode === 404) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(response.body).toString('utf8')); }
  catch { throw new SandboxStateError('Docker resource inspection returned invalid JSON.'); }
  let result: ResourceInspection;
  if (resource.role === 'compute' || resource.role === 'export') {
    const value = containerSchema.safeParse(parsed);
    if (!value.success) throw new SandboxStateError('Docker returned an invalid container inspection.');
    const container = value.data;
    assertLabels(container.Config.Labels, record, resource.role);
    if (container.Name !== `/${resource.name}` || container.Image !== record.imageDigest || container.Config.Image !== record.imageDigest) {
      throw new SandboxStateError('Docker container name or image differs from reserved ownership.');
    }
    result = { id: container.Id, fingerprint: containerFingerprint(container), container };
  } else if (resource.role === 'storage') {
    const value = volumeSchema.safeParse(parsed);
    if (!value.success) throw new SandboxStateError('Docker returned an invalid volume inspection.');
    const volume = value.data;
    assertLabels(volume.Labels, record, resource.role);
    if (volume.Name !== resource.name || volume.Driver !== 'local' || volume.Scope !== 'local'
      || Object.keys(volume.Options ?? {}).length !== 0) throw new SandboxStateError('Docker volume does not match the owned local volume profile.');
    result = { id: volume.Name, fingerprint: digest(value.data) };
  } else {
    const value = networkSchema.safeParse(parsed);
    if (!value.success) throw new SandboxStateError('Docker returned an invalid network inspection.');
    const network = value.data;
    assertLabels(network.Labels, record, resource.role);
    if (network.Name !== resource.name || network.Driver !== 'bridge' || network.Scope !== 'local' || network.Internal
      || network.Attachable || network.Ingress || network.ConfigOnly || network.EnableIPv6
      || Object.keys(network.Options).length !== 0) throw new SandboxStateError('Docker network does not match the owned outbound bridge profile.');
    result = { id: network.Id, fingerprint: digest(network) };
  }
  if (resource.identity.kind === 'identified' && (resource.identity.id !== result.id || resource.identity.fingerprint !== result.fingerprint)) {
    throw new SandboxStateError('Docker resource no longer matches its exact inspected identity and fingerprint.');
  }
  return result;
}
