// ------------------------------------------------------------------------------------------------
//                definitions.ts - Strict inputs of the seven fixed owned tools - Dependencies: zod/v4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import type { NodeProviderToolName } from '../types.js';

const path = z.string().min(1).max(4_096).describe('Path relative to the workspace root; an absolute path must be inside the workspace.');
const replacement = {
  file_path: path,
  old_string: z.string().min(1).describe('Exact text to replace.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one.'),
};

/** Field names follow the native built-ins they replace, so aliased native calls validate unchanged. */
const INPUTS = {
  read: z.strictObject({ file_path: path }),
  glob: z.strictObject({ pattern: z.string().min(1).max(1_024).describe('Glob: `**` spans directories, `*` and `?` match within one name.'), path: path.optional() }),
  grep: z.strictObject({ pattern: z.string().min(1).max(1_024).describe('Fixed string to find; not a regular expression.'), path: path.optional(),
    glob: z.string().min(1).max(1_024).optional().describe('Only search files whose workspace path matches this glob.') }),
  write: z.strictObject({ file_path: path, content: z.string().describe('Complete UTF-8 file content.') }),
  edit: z.strictObject(replacement),
  patch: z.strictObject({ changes: z.array(z.union([
    z.strictObject({ file_path: path, content: z.string().describe('Complete UTF-8 file content.') }),
    z.strictObject(replacement),
  ])).min(1).max(16).describe('One to sixteen file changes, checked together and published in order.') }),
  bash: z.strictObject({ command: z.string().min(1).describe('Complete shell command; the host approves this exact text before it runs.'),
    timeout: z.number().int().min(1).optional().describe('Timeout in milliseconds, capped by the session limit.') }),
} as const satisfies Record<NodeProviderToolName, z.ZodType>;

export type ToolInput<Name extends NodeProviderToolName> = z.output<(typeof INPUTS)[Name]>;
export type ToolCall = { [Name in NodeProviderToolName]: Readonly<{ tool: Name; input: ToolInput<Name> }> }[NodeProviderToolName];

/** JSON Schema (draft 2020-12) for one complete strict tool input. */
export function toolInputSchema(name: NodeProviderToolName): Record<string, unknown> {
  return z.toJSONSchema(INPUTS[name]) as Record<string, unknown>;
}

/** Unknown tools and inputs with unknown or invalid fields are refused whole; nothing is ignored. */
export function parseToolCall(tool: string, input: unknown): Readonly<{ ok: true; call: ToolCall } | { ok: false; reason: string }> {
  if (!Object.hasOwn(INPUTS, tool)) return { ok: false, reason: `${tool.slice(0, 64)} is not an owned tool` };
  const parsed = INPUTS[tool as NodeProviderToolName].safeParse(input);
  if (parsed.success) return { ok: true, call: { tool, input: parsed.data } as ToolCall };
  const issue = parsed.error.issues[0];
  return { ok: false, reason: `invalid ${tool} input${issue ? ` (${[...issue.path].join('.') || 'input'}: ${issue.message})` : ''}`.slice(0, 300) };
}
