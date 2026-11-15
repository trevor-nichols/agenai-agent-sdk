// ------------------------------------------------------------------------------------------------
//                options.ts - Factory option capture: credential route, endpoint and model configuration
// ------------------------------------------------------------------------------------------------

import { normalize } from 'node:path';
import type { NodeProviderToolOptions } from '@agen-ai/provider-tools';
import { z } from 'zod/v4';
import type { NodeClaudeProviderOptions, NodeClaudeUsageLimits } from '../index.js';

export const DEFAULT_API_BASE_URL = 'https://api.anthropic.com';

export interface ParsedClaudeOptions {
  readonly executablePath: string;
  readonly apiKey: string;
  readonly apiBaseUrl: string;
  readonly tools: NodeProviderToolOptions;
  readonly usageLimits: NodeClaudeUsageLimits;
}

export class NodeClaudeProviderOptionsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeClaudeProviderOptionsError';
  }
}

/** Plain own enumerable data only, copied so later caller mutation cannot change bound options. */
function capture(input: unknown, depth = 0): unknown {
  if (depth > 8) throw new NodeClaudeProviderOptionsError('Claude provider options are nested too deeply.');
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) {
      throw new NodeClaudeProviderOptionsError('Claude provider options require dense plain arrays.');
    }
    return Object.freeze(input.map((value) => capture(value, depth + 1)));
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new NodeClaudeProviderOptionsError('Claude provider options require plain objects.');
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !property?.enumerable || !('value' in property)) {
      throw new NodeClaudeProviderOptionsError('Claude provider options reject symbols and accessors.');
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

const MAX_BUDGET_USD = 1_000;

const absolutePath = z.string().max(4_096).refine((value) => value.startsWith('/') && normalize(value) === value && !value.endsWith('/')
  && !/\p{Cc}/u.test(value), 'Canonical absolute path required');

const schema = z.strictObject({
  executablePath: absolutePath,
  credential: z.strictObject({ kind: z.literal('api_key'), value: z.string().min(1).max(1_024).regex(/^[\x21-\x7e]+$/u) }),
  tools: z.record(z.string(), z.unknown()),
  apiBaseUrl: z.string().refine(endpoint, 'HTTPS or loopback HTTP origin without credentials, query or fragment required').optional(),
  usageLimits: z.strictObject({ maxBudgetUsdPerSession: z.number().positive().max(MAX_BUDGET_USD).optional() }).optional(),
});

/** Validates factory-owned fields now; tool containment options are validated during materialization. */
export function parseClaudeOptions(input: NodeClaudeProviderOptions): ParsedClaudeOptions {
  const parsed = schema.safeParse(capture(input));
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.flatMap((issue) => issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => `unknown ${key.slice(0, 64)}`) : [String(issue.path[0] ?? 'options')]))].join(', ');
    throw new NodeClaudeProviderOptionsError(`Claude provider options are invalid: ${fields}.`);
  }
  return Object.freeze({
    executablePath: parsed.data.executablePath,
    apiKey: parsed.data.credential.value,
    apiBaseUrl: (parsed.data.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/u, ''),
    tools: parsed.data.tools as unknown as NodeProviderToolOptions,
    usageLimits: Object.freeze({ ...parsed.data.usageLimits }),
  });
}

const configuration = z.strictObject({ model: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/u) });

/** The neutral driver configuration carries the model only; secrets and containment stay in options. */
export function parseClaudeConfiguration(input: unknown): Readonly<{ model: string }> {
  const parsed = configuration.safeParse(capture(input));
  if (!parsed.success) throw new NodeClaudeProviderOptionsError('Claude driver configuration accepts exactly one model identifier.');
  return Object.freeze({ model: parsed.data.model });
}
