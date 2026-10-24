// ------------------------------------------------------------------------------------------------
//                config.ts - Explicit inert local Docker authority - Strict public configuration
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { parseSandboxSpillDirectory } from '@agen-ai/sandbox/node';
import { DOCKER_SANDBOX_PROFILES } from './profiles.js';
import type { DockerSandboxProfile } from './profiles.js';
import type { DockerSandboxDataset } from '../datasets/types.js';
import { datasetsSchema, MAX_DATASET_ATTACHMENTS, normalizeDatasets } from '../datasets/configuration.js';

export interface DockerSandboxBackendOptions {
  readonly profile?: DockerSandboxProfile;
  readonly endpoint: string;
  readonly namespace: string;
  readonly imageDigest: string;
  readonly spillDirectory: string;
  readonly user: Readonly<{ uid: number; gid: number }>;
  readonly datasets?: readonly DockerSandboxDataset[];
}

export interface DockerSandboxConfig extends DockerSandboxBackendOptions {
  readonly profile: DockerSandboxProfile;
  readonly datasets: readonly DockerSandboxDataset[];
}

const userSchema = z.strictObject({ uid: z.number().int().min(1).max(262_143), gid: z.number().int().min(1).max(262_143) });
const configSchema = z.strictObject({
  profile: z.enum(DOCKER_SANDBOX_PROFILES).default('linux-x64'),
  endpoint: z.string().min(9).max(512).regex(/^unix:\/\/\/[a-zA-Z0-9_.\-/]+$/u)
    .refine((value) => !value.slice(7).split('/').some((part) => part === '.' || part === '..') && !value.includes('//', 7), 'Expected a canonical absolute Unix socket endpoint'),
  namespace: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  spillDirectory: z.string(),
  user: userSchema,
  datasets: datasetsSchema.default([]),
});

function plainData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (depth > 1 || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_DATASET_ATTACHMENTS
      || Reflect.ownKeys(value).length !== value.length + 1) {
      throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker datasets require a bounded dense data array' }]);
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry || !('value' in entry) || !entry.enumerable) {
        throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker dataset entries must be enumerable data properties' }]);
      }
      result.push(plainData(entry.value, depth + 1));
    }
    return result;
  }
  if (depth > 2 || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker configuration requires plain data objects' }]);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || key === '__proto__' || property === undefined || !('value' in property) || !property.enumerable) {
      throw new SandboxValidationError([{ code: 'invalid_input', path: [], message: 'Docker configuration cannot contain accessors, symbols or hidden fields' }]);
    }
    result[key] = plainData(property.value, depth + 1);
  }
  return result;
}

export function parseDockerConfig(input: unknown): DockerSandboxConfig {
  const captured = plainData(input);
  const result = configSchema.safeParse(captured);
  if (!result.success) throw new SandboxValidationError(normalizeZodValidationError(configSchema, result.error, captured));
  return Object.freeze({ ...result.data, spillDirectory: parseSandboxSpillDirectory(result.data.spillDirectory),
    user: Object.freeze(result.data.user), datasets: normalizeDatasets(result.data.datasets) });
}

export const DOCKER_BACKEND_ID = 'agenai-docker';
export const DOCKER_API = '/v1.52';
