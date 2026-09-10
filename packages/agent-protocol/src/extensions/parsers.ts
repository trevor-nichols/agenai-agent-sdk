// ------------------------------------------------------------------------------------------------
//                parsers.ts - Native extension observation parsers - Dependencies: extension schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentExtensionCatalogSchema,
  AgentExtensionDescriptorSchema,
} from '../zod/extensions.js';
import type {
  AgentExtensionCatalog,
  AgentExtensionDescriptor,
} from './types.js';

export function parseAgentExtensionDescriptor(
  input: unknown,
): AgentExtensionDescriptor {
  return parseWithSchema(AgentExtensionDescriptorSchema, input);
}

export function safeParseAgentExtensionDescriptor(
  input: unknown,
): AgentProtocolParseResult<AgentExtensionDescriptor> {
  return safeParseWithSchema(AgentExtensionDescriptorSchema, input);
}

export function parseAgentExtensionCatalog(input: unknown): AgentExtensionCatalog {
  return parseWithSchema(AgentExtensionCatalogSchema, input);
}

export function safeParseAgentExtensionCatalog(
  input: unknown,
): AgentProtocolParseResult<AgentExtensionCatalog> {
  return safeParseWithSchema(AgentExtensionCatalogSchema, input);
}
