// ------------------------------------------------------------------------------------------------
//                options.ts - Factory-boundary parsing of owned-tool options and finite limits
// ------------------------------------------------------------------------------------------------

import { normalize } from 'node:path';
import { z } from 'zod/v4';
import { NodeProviderToolsError } from '../errors.js';
import type { NodeProviderToolOptions } from '../types.js';
import { COMMAND_SYSTEM_PATHS } from './namespace.js';

export const TOOL_LIMIT_MAXIMA = Object.freeze({
  commandTimeoutMs: 600_000, outputBytes: 1_048_576, fileBytes: 8_388_608, searchEntries: 20_000, pendingCalls: 64,
});
export const TOOL_LIMIT_DEFAULTS = Object.freeze({
  commandTimeoutMs: 60_000, outputBytes: 65_536, fileBytes: 1_048_576, searchEntries: 2_000, pendingCalls: 8,
});
/** Fixed bounds that callers cannot change. */
export const FIXED_TOOL_LIMITS = Object.freeze({
  commandBytes: 16_384, patchMembers: 16, selectorBytes: 512, selectors: 64, patternBytes: 1_024,
  searchBytes: 4_194_304, resultBytes: 65_536, approvalTimeoutMs: 300_000,
});

export type ParsedToolLimits = Readonly<Record<keyof typeof TOOL_LIMIT_DEFAULTS, number>>;

export interface ParsedToolOptions {
  readonly storeDirectory: string;
  readonly workspaceDirectory: string;
  readonly stateParentDirectory: string;
  readonly bubblewrapPath: string;
  readonly filesystemHelperPath: string;
  readonly restrictions: Readonly<{ denyRead: readonly string[]; askRead: readonly string[]; denyEdit: readonly string[]; askEdit: readonly string[] }>;
  readonly limits: ParsedToolLimits;
}

export const absolutePath = z.string().refine((value) => value.isWellFormed() && Buffer.byteLength(value) <= 4_096 && value.startsWith('/')
  && value !== '/' && normalize(value) === value && !value.endsWith('/') && !/\p{Cc}/u.test(value), 'Canonical absolute path required');

export const privateDirectoryPath = absolutePath.refine((value) =>
  !COMMAND_SYSTEM_PATHS.some((root) => value === root || value.startsWith(`${root}/`)), 'Private directories must be outside command-visible system paths');

const selector = z.string().min(1).refine((value) => value.isWellFormed() && Buffer.byteLength(value) <= FIXED_TOOL_LIMITS.selectorBytes
  && !/[\p{Cc}\\]/u.test(value) && !value.startsWith('/') && !value.startsWith('!')
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Workspace-relative selector required');
const selectors = z.array(selector).max(FIXED_TOOL_LIMITS.selectors).default([]);
const limit = (name: keyof typeof TOOL_LIMIT_MAXIMA) => z.number().int().min(1).max(TOOL_LIMIT_MAXIMA[name]).default(TOOL_LIMIT_DEFAULTS[name]);

const schema = z.strictObject({
  workspace: z.strictObject({ storeDirectory: privateDirectoryPath, workspaceDirectory: absolutePath })
    .refine((value) => value.workspaceDirectory === `${value.storeDirectory}/work`, 'The workspace must be the prepared store work directory'),
  stateParentDirectory: privateDirectoryPath,
  bubblewrapPath: absolutePath,
  filesystemHelperPath: absolutePath,
  restrictions: z.strictObject({ denyRead: selectors, askRead: selectors, denyEdit: selectors, askEdit: selectors }).default({
    denyRead: [], askRead: [], denyEdit: [], askEdit: [],
  }),
  limits: z.strictObject({
    commandTimeoutMs: limit('commandTimeoutMs'), outputBytes: limit('outputBytes'), fileBytes: limit('fileBytes'),
    searchEntries: limit('searchEntries'), pendingCalls: limit('pendingCalls'),
  }).default(TOOL_LIMIT_DEFAULTS),
});

/** Plain own data properties only; accessors, prototypes and unknown keys are refused before parsing. */
export function captureData(input: unknown, context: string): unknown {
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) {
      throw new NodeProviderToolsError('invalid_options', `${context} requires dense plain arrays.`);
    }
    return input.map((value, index) => captureData(value, `${context}[${index}]`));
  }
  if (input === null || typeof input !== 'object') return input;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new NodeProviderToolsError('invalid_options', `${context} requires plain data objects.`);
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !property?.enumerable || !('value' in property)) {
      throw new NodeProviderToolsError('invalid_options', `${context} rejects symbols and accessors.`);
    }
    captured[key] = captureData(property.value, `${context}.${key}`);
  }
  return captured;
}

export function parseToolOptions(input: NodeProviderToolOptions): ParsedToolOptions {
  const parsed = schema.safeParse(captureData(input, 'Provider tool options'));
  if (!parsed.success) throw new NodeProviderToolsError('invalid_options', 'Provider tool options are invalid.', { cause: parsed.error });
  const { workspace, restrictions, limits, ...paths } = parsed.data;
  return Object.freeze({
    ...paths,
    storeDirectory: workspace.storeDirectory,
    workspaceDirectory: workspace.workspaceDirectory,
    restrictions: Object.freeze({
      denyRead: Object.freeze([...restrictions.denyRead]), askRead: Object.freeze([...restrictions.askRead]),
      denyEdit: Object.freeze([...restrictions.denyEdit]), askEdit: Object.freeze([...restrictions.askEdit]),
    }),
    limits: Object.freeze({ ...limits }),
  });
}
