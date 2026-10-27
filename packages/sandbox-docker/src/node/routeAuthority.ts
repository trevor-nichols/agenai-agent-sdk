// ------------------------------------------------------------------------------------------------
//                routeAuthority.ts - Explicit inert Linux route observer construction
// ------------------------------------------------------------------------------------------------

import { hostname, release } from 'node:os';
import { z } from 'zod/v4';
import { SandboxUnsupportedError, SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { registerDockerLinuxRouteAuthority } from '../network/routeAuthority.js';
import type { DockerLinuxRouteAuthority, DockerLinuxRouteAuthorityIdentity } from '../network/routeAuthority.js';
import { parseRouteCensus } from '../network/census.js';
import { readIpJson } from './command.js';

const optionsSchema = z.strictObject({
  kind: z.literal('local_linux_same_host'), stability: z.literal('caller_owned_quiescence'),
  ipExecutable: z.strictObject({ path: z.string().min(2).max(4096).regex(/^\/(?:[^/\u0000-\u0020]+\/)*[^/\u0000-\u0020]+$/u)
    .refine((value) => !value.split('/').some((part) => part === '.' || part === '..'), 'Canonical absolute observer path required'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
  pollIntervalMs: z.number().int().min(25).max(2_147_483_647),
  commandTimeoutMs: z.number().int().min(1).max(2_147_481_147),
  maxOutputBytes: z.number().int().min(1024).max(4 * 1024 ** 2),
});

export type DockerLinuxRouteAuthorityOptions = DockerLinuxRouteAuthorityIdentity;

function data(input: unknown, depth = 0): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (depth > 1 || Array.isArray(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new TypeError('Route observer options require plain data.');
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || key === '__proto__' || !property || !('value' in property) || !property.enumerable) throw new TypeError('Route observer options require enumerable data fields.');
    captured[key] = data(property.value, depth + 1);
  }
  return captured;
}

export function createDockerLinuxRouteAuthority(options: DockerLinuxRouteAuthorityOptions): DockerLinuxRouteAuthority {
  const captured = data(options);
  const parsed = optionsSchema.safeParse(captured);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(optionsSchema, parsed.error, captured));
  const identity = Object.freeze({ ...parsed.data, ipExecutable: Object.freeze(parsed.data.ipExecutable) });
  return registerDockerLinuxRouteAuthority({ identity, async observe(signal) {
    if (process.platform !== 'linux') throw new SandboxUnsupportedError('Restricted host route authority requires a local Linux controller.');
    const ipv4 = await readIpJson(identity, ['-json', '-4', 'route', 'show', 'table', 'all'], signal);
    const ipv6 = await readIpJson(identity, ['-json', '-6', 'route', 'show', 'table', 'all'], signal);
    const interfaces = await readIpJson(identity, ['-json', 'address', 'show'], signal);
    return Object.freeze({ excludedCidrs: parseRouteCensus(ipv4, ipv6, interfaces), hostname: hostname(), kernel: release() });
  } });
}
