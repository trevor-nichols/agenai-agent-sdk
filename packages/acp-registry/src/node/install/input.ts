import { z } from 'zod/v4';
import { isAbsolute } from 'node:path';
import { plainInput } from '../../selection/input.js';
import { parseAcpInstallPlan } from '../../planning/parse.js';
import { normalizeRegistryUrl } from '../../catalog/source.js';
import type { AcpInstallationLimits, InstallAcpAgentInput } from './contracts.js';
import { AcpInstallationError } from './errors.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const absolute = z.string().min(1).max(8_192).refine((path) => isAbsolute(path) && !/[\p{Cc}\p{Cf}]/u.test(path));
const url = z.string().max(8_192).refine((value) => {
  try { return normalizeRegistryUrl(value, []) === value; } catch { return false; }
});

export function captureInstallInput(input: InstallAcpAgentInput, limits: AcpInstallationLimits) {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new AcpInstallationError('invalid_input', 'Install input requires a plain object.');
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !['plan', 'expectedPlanDigest', 'toolchains', 'localArtifacts', 'packageArtifacts', 'signal'].includes(key)) throw new AcpInstallationError('invalid_input', 'Unknown install input property.');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new AcpInstallationError('invalid_input', 'Install options require data properties.');
    if (descriptor.value !== undefined) captured[key] = descriptor.value;
  }
  const signal = captured.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new AcpInstallationError('invalid_input', 'Install cancellation requires an AbortSignal.');
  delete captured.signal;
  const schema = z.strictObject({ plan: z.unknown(), expectedPlanDigest: digest,
    toolchains: z.array(z.strictObject({ kind: z.enum(['node', 'npm', 'python', 'uv']), path: absolute })).max(4).default([]),
    localArtifacts: z.array(z.strictObject({ path: absolute, url: url.optional(), sha256: digest.optional() })
      .refine((value) => value.url !== undefined || value.sha256 !== undefined)).max(limits.maxEntries).default([]),
    packageArtifacts: z.array(z.strictObject({ name: z.string().min(1).max(256), version: z.string().min(1).max(128), url,
      filename: z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u), sha256: digest })).max(limits.maxEntries).default([]) });
  const parsed = schema.safeParse(plainInput(captured));
  if (!parsed.success) throw new AcpInstallationError('invalid_input', 'Installation input is malformed.');
  const value = parsed.data;
  const plan = parseAcpInstallPlan(value.plan, value.expectedPlanDigest);
  if (new Set(value.toolchains.map((tool) => tool.kind)).size !== value.toolchains.length
    || value.toolchains.length !== plan.toolchains.length || value.toolchains.some((tool) => !plan.toolchains.some((expected) => expected.kind === tool.kind))) {
    throw new AcpInstallationError('toolchain_mismatch', 'Supply exactly the toolchain kinds selected by the installation plan.');
  }
  return { ...value, plan, signal };
}
