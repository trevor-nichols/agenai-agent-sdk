// ------------------------------------------------------------------------------------------------
//                options.ts - Factory option capture: provider route, credential, endpoint and model
// ------------------------------------------------------------------------------------------------

import { normalize } from 'node:path';
import type { NodeProviderToolOptions } from '@agen-ai/provider-tools';
import { z } from 'zod/v4';
import type { NodeOpenCodeModelProvider, NodeOpenCodeProviderOptions, NodeOpenCodeUsageLimits } from '../index.js';

const DEFAULT_API_BASE_URLS: Readonly<Record<NodeOpenCodeModelProvider, string>> = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
});

export interface ParsedOpenCodeOptions {
  readonly executablePath: string;
  readonly provider: NodeOpenCodeModelProvider;
  readonly apiKey: string;
  /** The API origin without the version path; the native provider receives `${apiBaseUrl}/v1`. */
  readonly apiBaseUrl: string;
  readonly tools: NodeProviderToolOptions;
  readonly usageLimits: NodeOpenCodeUsageLimits;
}

export class NodeOpenCodeProviderOptionsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeOpenCodeProviderOptionsError';
  }
}

/** Plain own enumerable data only, copied so later caller mutation cannot change bound options. */
function capture(input: unknown, depth = 0): unknown {
  if (depth > 8) throw new NodeOpenCodeProviderOptionsError('OpenCode provider options are nested too deeply.');
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) {
      throw new NodeOpenCodeProviderOptionsError('OpenCode provider options require dense plain arrays.');
    }
    return Object.freeze(input.map((value) => capture(value, depth + 1)));
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new NodeOpenCodeProviderOptionsError('OpenCode provider options require plain objects.');
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !property?.enumerable || !('value' in property)) {
      throw new NodeOpenCodeProviderOptionsError('OpenCode provider options reject symbols and accessors.');
    }
    copy[key] = capture(property.value, depth + 1);
  }
  return Object.freeze(copy);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function endpoint(value: string): boolean {
  if (value.length > 2_048 || /[\s\p{Cc}]/u.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash || value.includes('#') || value.includes('?')) return false;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return false;
  return url.href.replace(/\/$/u, '') === value.replace(/\/$/u, '');
}

// OpenCode 2.2.7 never requests more than 256,000 output tokens; a larger bound would not be one.
const MAX_OUTPUT_TOKENS = 256_000;
const MAX_MODEL_STEPS = 1_000;

const absolutePath = z.string().max(4_096).refine((value) => value.startsWith('/') && normalize(value) === value && !value.endsWith('/')
  && !/\p{Cc}/u.test(value), 'Canonical absolute path required');

const schema = z.strictObject({
  executablePath: absolutePath,
  provider: z.enum(['anthropic', 'openai']),
  credential: z.strictObject({ kind: z.literal('api_key'), value: z.string().min(1).max(1_024).regex(/^[\x21-\x7e]+$/u) }),
  tools: z.record(z.string(), z.unknown()),
  apiBaseUrl: z.string().refine(endpoint, 'HTTPS or loopback HTTP origin without credentials, query or fragment required').optional(),
  usageLimits: z.strictObject({
    maxOutputTokensPerRequest: z.number().int().min(1).max(MAX_OUTPUT_TOKENS).optional(),
    maxModelStepsPerTurn: z.number().int().min(1).max(MAX_MODEL_STEPS).optional(),
  }).optional(),
});

/** Validates factory-owned fields now; tool containment options are validated during materialization. */
export function parseOpenCodeOptions(input: NodeOpenCodeProviderOptions): ParsedOpenCodeOptions {
  const parsed = schema.safeParse(capture(input));
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.flatMap((issue) => issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => `unknown ${key.slice(0, 64)}`) : [String(issue.path[0] ?? 'options')]))].join(', ');
    throw new NodeOpenCodeProviderOptionsError(`OpenCode provider options are invalid: ${fields}.`);
  }
  return Object.freeze({
    executablePath: parsed.data.executablePath,
    provider: parsed.data.provider,
    apiKey: parsed.data.credential.value,
    apiBaseUrl: (parsed.data.apiBaseUrl ?? DEFAULT_API_BASE_URLS[parsed.data.provider]).replace(/\/$/u, ''),
    tools: parsed.data.tools as unknown as NodeProviderToolOptions,
    usageLimits: Object.freeze({ ...parsed.data.usageLimits }),
  });
}

const configuration = z.strictObject({ model: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/u) });

/** The neutral driver configuration carries the model only; secrets and containment stay in options. */
export function parseOpenCodeConfiguration(input: unknown): Readonly<{ model: string }> {
  const parsed = configuration.safeParse(capture(input));
  if (!parsed.success) throw new NodeOpenCodeProviderOptionsError('OpenCode driver configuration accepts exactly one model identifier.');
  return Object.freeze({ model: parsed.data.model });
}
