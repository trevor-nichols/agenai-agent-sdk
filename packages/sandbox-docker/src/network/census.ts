// ------------------------------------------------------------------------------------------------
//                census.ts - Closed iproute2 output capture and owned quiescence monitoring
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SandboxOperationError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import { deniedCoverage } from './policy.js';
import type { DockerRouteAuthorityBinding, DockerLinuxRouteCensus } from './routeAuthority.js';

const routeSchema = z.array(z.object({ dst: z.string().optional(), gateway: z.string().optional() })).max(4096);
const interfacesSchema = z.array(z.object({ addr_info: z.array(z.object({ family: z.enum(['inet', 'inet6']), local: z.string(),
  prefixlen: z.number().int().min(0).max(128) })).max(256) })).max(256);

export function parseRouteCensus(ipv4: unknown, ipv6: unknown, interfaces: unknown): readonly string[] {
  const routes = [...routeSchema.parse(ipv4), ...routeSchema.parse(ipv6)];
  const addresses = interfacesSchema.parse(interfaces);
  const exclusions: string[] = [];
  const host = (address: string) => `${address}/${address.includes(':') ? 128 : 32}`;
  for (const route of routes) {
    if (route.dst !== undefined && route.dst !== 'default') exclusions.push(route.dst.includes('/') ? route.dst : host(route.dst));
    if (route.gateway !== undefined) exclusions.push(host(route.gateway));
  }
  for (const device of addresses) for (const address of device.addr_info) exclusions.push(`${address.local}/${address.prefixlen}`);
  return deniedCoverage(exclusions);
}

export interface DockerRouteLease {
  readonly census: DockerLinuxRouteCensus;
  assertCurrent(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export async function captureDockerRouteLease(binding: DockerRouteAuthorityBinding, signal?: AbortSignal): Promise<DockerRouteLease> {
  if (binding.kind !== 'local_linux_same_host') throw new SandboxUnsupportedError('Docker Desktop route observation is not enabled.');
  const census = await binding.observe(signal);
  return Object.freeze({ census, async close() {}, async assertCurrent(operationSignal?: AbortSignal) {
    const next = await binding.observe(operationSignal);
    if (next.hostname !== census.hostname || next.kernel !== census.kernel || JSON.stringify(next.excludedCidrs) !== JSON.stringify(census.excludedCidrs)) {
      throw new SandboxOperationError('driver_failure', 'Observed Linux route authority changed; restricted egress is fenced.');
    }
  } });
}
