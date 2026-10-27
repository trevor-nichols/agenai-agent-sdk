// ------------------------------------------------------------------------------------------------
//                inspect.ts - Resource inspection and ownership proof - Docker response boundary
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxStateError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord, SandboxRecoveryResource } from '@agen-ai/sandbox';
import { DOCKER_API } from '../policy/config.js';
import type { DockerSandboxConfig } from '../policy/config.js';
import { assertLabels, desktopBridgeName, digest } from '../recovery/identity.js';
import { desktopObserverIdentity, verifyDesktopObserverContainer } from '../policy/desktopObserver.js';
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
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ NetworkID: z.string(),
    EndpointID: z.string().max(64).optional(), MacAddress: z.string().max(32).optional(), IPAddress: z.string().max(64).optional(),
    IPPrefixLen: z.number().int().min(0).max(128).optional(), Gateway: z.string().max(64).optional(),
  })), Ports: z.record(z.string(), z.unknown()).nullable() }),
  State: z.object({ Running: z.boolean(), Status: z.string() }).passthrough(), AppArmorProfile: z.string(),
}).passthrough();
const volumeSchema = z.object({ Name: z.string(), Driver: z.string(), Mountpoint: z.string(), CreatedAt: z.string(), Labels: labelsSchema,
  Options: z.record(z.string(), z.string()).nullable(), Scope: z.string() });
const networkSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u), Name: z.string(), Created: z.string(), Driver: z.string(), Scope: z.string(),
  Internal: z.boolean(), Attachable: z.boolean(), Ingress: z.boolean(), EnableIPv6: z.boolean(), ConfigOnly: z.boolean(),
  IPAM: z.object({}).passthrough(), Options: z.record(z.string(), z.string()), Labels: labelsSchema,
});
const membershipSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u),
  Containers: z.record(z.string().regex(/^[a-f0-9]{64}$/u), z.object({ Name: z.string().max(256) }).passthrough())
    .refine((value) => Object.keys(value).length <= 8, 'Network membership exceeds the finite owned-role census'),
});

export type ContainerInspection = z.infer<typeof containerSchema>;
export interface ResourceInspection { readonly id: string; readonly fingerprint: string; readonly container?: ContainerInspection }

export function resourceKind(role: SandboxRecoveryResource['role']): 'container' | 'volume' | 'network' {
  switch (role) {
    case 'compute': case 'export': case 'egress_broker': case 'egress_relay': case 'filesystem': case 'route_observer': return 'container';
    case 'storage': case 'egress_socket': return 'volume';
    case 'network': return 'network';
    default: { const exhaustive: never = role; return exhaustive; }
  }
}

function resourceImage(config: DockerSandboxConfig, record: SandboxRecoveryRecord, role: SandboxRecoveryResource['role']): string {
  switch (role) {
    case 'compute': case 'export': return record.imageDigest;
    case 'egress_broker': case 'egress_relay':
      if (!config.egress) throw new SandboxStateError('Egress resource ownership requires its exact configured helper image.');
      return config.egress.imageDigest;
    case 'filesystem':
      if (!config.filesystem) throw new SandboxStateError('Filesystem resource ownership requires its exact configured helper image.');
      return config.filesystem.imageDigest;
    case 'route_observer': return desktopObserverIdentity(config).vmObserver.imageDigest;
    case 'storage': case 'egress_socket': case 'network': throw new SandboxStateError('This resource role has no container image.');
    default: { const exhaustive: never = role; return exhaustive; }
  }
}

export function inspectPath(resource: SandboxRecoveryResource, identity: string): string {
  const encoded = encodeURIComponent(identity);
  switch (resourceKind(resource.role)) {
    case 'container': return `${DOCKER_API}/containers/${encoded}/json`;
    case 'volume': return `${DOCKER_API}/volumes/${encoded}`;
    case 'network': return `${DOCKER_API}/networks/${encoded}`;
  }
}

export async function inspectResource(api: DockerApi, config: DockerSandboxConfig, record: SandboxRecoveryRecord, resource: SandboxRecoveryResource,
  reference: string, signal?: AbortSignal): Promise<ResourceInspection | undefined> {
  const response = await api.request('GET', inspectPath(resource, reference), { statuses: [200, 404], signal });
  if (response.statusCode === 404) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(response.body).toString('utf8')); }
  catch { throw new SandboxStateError('Docker resource inspection returned invalid JSON.'); }
  let result: ResourceInspection;
  if (resourceKind(resource.role) === 'container') {
    const value = containerSchema.safeParse(parsed);
    if (!value.success) throw new SandboxStateError('Docker returned an invalid container inspection.');
    const container = value.data;
    assertLabels(container.Config.Labels, record, resource.role);
    const image = resourceImage(config, record, resource.role);
    if (container.Name !== `/${resource.name}` || container.Image !== image || container.Config.Image !== image) {
      throw new SandboxStateError('Docker container name or image differs from reserved ownership.');
    }
    if (resource.role === 'route_observer' && resource.identity.kind === 'creating') {
      try { verifyDesktopObserverContainer(container, config, false); }
      catch (error) {
        if (!(error instanceof SandboxUnsupportedError)) throw error;
        throw new SandboxStateError('Unacknowledged Desktop observer configuration differs from its original reserved authority.');
      }
    }
    result = { id: container.Id, fingerprint: containerFingerprint(container), container };
  } else if (resourceKind(resource.role) === 'volume') {
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
    const ownedDesktopBridge = record.resources.some(({ role }) => role === 'route_observer');
    const options = Object.entries(network.Options);
    if (network.Name !== resource.name || network.Driver !== 'bridge' || network.Scope !== 'local' || network.Internal
      || network.Attachable || network.Ingress || network.ConfigOnly || network.EnableIPv6
      || options.some(([key, value]) => key === 'com.docker.network.bridge.name'
        ? !ownedDesktopBridge || value !== desktopBridgeName(record)
        : key !== 'com.docker.network.enable_ipv4' || value !== 'true')
      || ownedDesktopBridge && network.Options['com.docker.network.bridge.name'] !== desktopBridgeName(record)) {
      throw new SandboxStateError('Docker network does not match the owned outbound bridge profile.');
    }
    result = { id: network.Id, fingerprint: digest(network) };
  }
  if (resource.identity.kind === 'identified' && (resource.identity.id !== result.id || resource.identity.fingerprint !== result.fingerprint)) {
    throw new SandboxStateError('Docker resource no longer matches its exact inspected identity and fingerprint.');
  }
  return result;
}

/** Runtime topology is checked separately from immutable network identity and cleanup fingerprints. */
export async function verifyNetworkMembership(api: DockerApi, networkId: string,
  expectedContainerIds: readonly string[], signal?: AbortSignal): Promise<void> {
  const network = await api.json('GET', `${DOCKER_API}/networks/${encodeURIComponent(networkId)}`, membershipSchema, { signal });
  const actual = Object.keys(network.Containers);
  if (network.Id !== networkId || actual.length !== expectedContainerIds.length
    || expectedContainerIds.some((id) => !Object.hasOwn(network.Containers, id))
    || actual.some((id) => !expectedContainerIds.includes(id))) {
    throw new SandboxStateError('Docker network membership differs from the exact admitted container topology.');
  }
}
