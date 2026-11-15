// ------------------------------------------------------------------------------------------------
//                catalog.ts - Plain descriptors of the seven fixed owned tools
// ------------------------------------------------------------------------------------------------

import { NODE_PROVIDER_TOOL_NAMES, type NodeProviderToolName } from '../types.js';
import { toolInputSchema } from './definitions.js';

const DESCRIPTIONS: Readonly<Record<NodeProviderToolName, string>> = {
  read: 'Read one UTF-8 workspace file. Links and special files are never followed.',
  glob: 'List workspace files whose paths match a glob. Restricted files are withheld and links are not followed.',
  grep: 'Fixed-string search of workspace files. Restricted files are withheld and links are not followed.',
  write: 'Create or replace one ordinary workspace file. Its parent directory must already exist.',
  edit: 'Replace text in one ordinary workspace file.',
  patch: 'Create or update several ordinary workspace files. Files are published one at a time, not atomically.',
  bash: 'Run one command in a networkless sandbox where only the workspace is writable. Every command waits for host approval.',
};

export interface NodeProviderToolDefinition {
  readonly name: NodeProviderToolName;
  readonly description: string;
  /** JSON Schema (draft 2020-12) for the complete strict input object. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

let definitions: readonly NodeProviderToolDefinition[] | undefined;

export function nodeProviderToolDefinitions(): readonly NodeProviderToolDefinition[] {
  definitions ??= deepFreeze(NODE_PROVIDER_TOOL_NAMES.map((name) => ({
    name, description: DESCRIPTIONS[name], inputSchema: toolInputSchema(name),
  })));
  return definitions;
}
