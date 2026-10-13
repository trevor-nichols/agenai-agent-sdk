import { z } from 'zod/v4';
import type { AcpRegistryLimits } from './contracts.js';
import { registrySourceSchema } from './source.js';

export const ACP_REGISTRY_TARGETS = ['darwin-aarch64', 'darwin-x86_64', 'linux-aarch64', 'linux-x86_64', 'windows-aarch64', 'windows-x86_64'] as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identity = z.string().max(512).regex(/^acp-registry:[a-z][a-z0-9._-]{0,127}:sha256:[a-f0-9]{64}\/[a-z][a-z0-9-]*$/u);
const agentId = z.string().max(128).regex(/^[a-z][a-z0-9-]*$/u);
const version = z.string().max(128).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-preview\.[0-9]+)?$/u);

export function acpRegistrySchemas(limits: AcpRegistryLimits) {
  const text = z.string();
  const metadata = {
    id: agentId, name: text.min(1), version, description: text.min(1), repository: text.optional(),
    website: text.optional(), authors: z.array(text).max(128).optional(), license: text.optional(),
    icon: text.optional(), bundled: z.boolean().optional(),
  };
  const launch = {
    args: z.array(text).max(limits.maxArgs).optional(),
    env: z.record(z.string().regex(/^(?!__proto__$|prototype$|constructor$)[a-zA-Z_][a-zA-Z0-9_]*$/u), text)
      .refine((value) => Object.keys(value).length <= limits.maxEnvEntries, 'Registry environment exceeds its entry limit.').optional(),
  };
  const binary = z.strictObject({ archive: text.min(1), cmd: text.min(1), sha256: text.regex(/^[a-fA-F0-9]{64}$/u).optional(), ...launch });
  const packageDistribution = z.strictObject({ package: text.min(1), ...launch });
  const distribution = z.strictObject({
    binary: z.partialRecord(z.enum(ACP_REGISTRY_TARGETS), binary).refine((value) => Object.keys(value).length > 0, 'Binary distributions cannot be empty.').optional(),
    npx: packageDistribution.optional(), uvx: packageDistribution.optional(),
  }).refine((value) => Object.keys(value).length > 0, 'Registry entries require at least one distribution.');
  const rawEntry = z.strictObject({ ...metadata, license_url: text.optional(), distribution });
  const rawSnapshot = z.strictObject({ version: z.literal('1.0.0'), agents: z.array(rawEntry).max(limits.maxEntries), extensions: z.array(z.never()).optional() });
  const normalizedLaunch = { args: launch.args.unwrap(), env: launch.env.unwrap() };
  const normalizedDistribution = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('binary'), target: z.enum(ACP_REGISTRY_TARGETS), archive: text.min(1), executable: text.min(1), sha256: text.regex(/^[a-f0-9]{64}$/u).optional(), ...normalizedLaunch }),
    z.strictObject({ kind: z.literal('npx'), package: text.min(1), ...normalizedLaunch }),
    z.strictObject({ kind: z.literal('uvx'), package: text.min(1), ...normalizedLaunch }),
  ]);
  const normalizedEntry = z.strictObject({ ...metadata, authors: z.array(text).max(128), identity,
    licenseUrl: text.optional(), distributions: z.array(normalizedDistribution).min(1).max(8), digest });
  const normalizedSnapshot = z.strictObject({ format: z.literal('acp-registry-published-v1'), source: registrySourceSchema,
    sourceIdentity: text.max(384), rawDigest: digest, digest, entries: z.array(normalizedEntry).max(limits.maxEntries) });
  return { rawEntry, rawSnapshot, normalizedDistribution, normalizedEntry, normalizedSnapshot };
}
