// ------------------------------------------------------------------------------------------------
//                engine.ts - Complete bounded selected-Engine network and endpoint census
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { SandboxOperationError } from '@agen-ai/sandbox';
import type { DockerApi } from '../../../resources/api.js';
import { DOCKER_API } from '../../../policy/config.js';
import { deniedCoverage } from '../../policy.js';
import { parseNumericAddress } from '../../address.js';
import { freezeObservation } from './data.js';

const id = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedText = z.string().max(256);
const stringMap = z.record(z.string().max(256), z.string().max(4096)).refine((value) => Object.keys(value).length <= 256);
const ipamSchema = z.strictObject({ Subnet: z.string().max(128).optional(), Gateway: z.string().max(128).optional(),
  IPRange: z.string().max(128).optional(), AuxiliaryAddresses: stringMap.optional() });
const endpointSchema = z.object({ Name: boundedText, EndpointID: z.union([id, z.literal('')]), MacAddress: z.string().regex(/^(?:(?:[a-f0-9]{2}:){5}[a-f0-9]{2})?$/u),
  IPv4Address: z.string().max(64), IPv6Address: z.string().max(128) }).strict();
const allocationCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const subnetStatusSchema = z.object({ IPsInUse: allocationCount, DynamicIPsAvailable: allocationCount }).passthrough();
const ipamStatusSchema = z.object({ Subnets: z.record(z.string().max(128), subnetStatusSchema)
  .refine((value) => Object.keys(value).length <= 128).optional() }).passthrough();
const networkStatusSchema = z.object({ IPAM: ipamStatusSchema.optional() }).passthrough();
const networkSchema = z.object({ Id: id, Name: boundedText.min(1), Created: boundedText, Driver: boundedText.min(1), Scope: boundedText,
  Internal: z.boolean(), Attachable: z.boolean(), Ingress: z.boolean(), EnableIPv6: z.boolean(), ConfigOnly: z.boolean(),
  IPAM: z.strictObject({ Driver: boundedText, Options: stringMap.nullable(), Config: z.array(ipamSchema).max(128).nullable() }),
  Options: stringMap, Labels: stringMap, Containers: z.record(id, endpointSchema), Status: networkStatusSchema.optional(),
}).passthrough();
export type DesktopEngineNetwork = z.infer<typeof networkSchema>;
export interface DesktopEngineNetworkCensus {
  readonly id: string; readonly hostname: string; readonly kernel: string;
  readonly networks: readonly DesktopEngineNetwork[]; readonly excludedCidrs: readonly string[];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
}

export function observationFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export async function readDesktopEngineNetworks(api: DockerApi, signal?: AbortSignal): Promise<DesktopEngineNetworkCensus> {
  const info = await api.json('GET', '/info', z.object({ ID: z.string().min(1).max(256), Name: boundedText.min(1), KernelVersion: boundedText.min(1) }), { signal });
  const list = async () => {
    const result = await api.json('GET', `${DOCKER_API}/networks`, z.array(z.object({ Id: id })).min(1).max(128), { signal });
    const ids = result.map((network) => network.Id).sort();
    if (new Set(ids).size !== ids.length) throw new SandboxOperationError('driver_failure', 'Docker network census contains duplicate identities.');
    return ids;
  };
  const ids = await list();
  const networks: DesktopEngineNetwork[] = [];
  const exclusions: string[] = [];
  const host = (address: string) => {
    const parsed = parseNumericAddress(address);
    if (parsed === undefined) throw new SandboxOperationError('driver_failure', 'Docker IPAM contains an invalid numeric address.');
    return `${address}/${parsed.family === 4 ? 32 : 128}`;
  };
  for (const networkId of ids) {
    const network = await api.json('GET', `${DOCKER_API}/networks/${networkId}`, networkSchema, { signal });
    if (network.Id !== networkId || Object.keys(network.Containers).length > 4096) throw new SandboxOperationError('driver_failure', 'Docker network inspection identity or membership is invalid.');
    const unallocated = (network.Driver === 'host' && network.Name === 'host' || network.Driver === 'null' && network.Name === 'none')
      && network.Scope === 'local' && network.IPAM.Config === null;
    if (!unallocated && (network.IPAM.Config === null || network.IPAM.Config.length === 0)) throw new SandboxOperationError('driver_failure', 'Docker network IPAM coverage is unavailable.');
    for (const endpoint of Object.values(network.Containers)) {
      if (unallocated ? endpoint.MacAddress !== '' || endpoint.IPv4Address !== '' || endpoint.IPv6Address !== ''
        : endpoint.EndpointID.length !== 64 || endpoint.MacAddress === '') {
        throw new SandboxOperationError('driver_failure', 'Docker network endpoint representation differs from its driver.');
      }
    }
    for (const allocation of network.IPAM.Config ?? []) {
      if (!allocation.Subnet) throw new SandboxOperationError('driver_failure', 'Allocated Docker network is missing its subnet coverage.');
      exclusions.push(allocation.Subnet);
      if (allocation.IPRange) exclusions.push(allocation.IPRange);
      if (allocation.Gateway) exclusions.push(host(allocation.Gateway));
      for (const address of Object.values(allocation.AuxiliaryAddresses ?? {})) exclusions.push(host(address));
      if (exclusions.length > 4096) throw new SandboxOperationError('output_limit', 'Docker network coverage exceeds its finite bound.');
    }
    networks.push(network);
  }
  if (JSON.stringify(await list()) !== JSON.stringify(ids)) throw new SandboxOperationError('driver_failure', 'Docker network identities changed during the complete census.');
  const result = { id: info.ID, hostname: info.Name, kernel: info.KernelVersion, networks, excludedCidrs: deniedCoverage(exclusions) };
  freezeObservation(result);
  return result;
}
