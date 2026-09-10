// ------------------------------------------------------------------------------------------------
//                parsers.ts - Native command parsers - Dependencies: schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentCommandCatalogSchema,
  AgentCommandDescriptorSchema,
} from '../zod/commands.js';
import type {
  AgentCommandCatalog,
  AgentCommandDescriptor,
} from './types.js';

export function parseAgentCommandDescriptor(
  input: unknown,
): AgentCommandDescriptor {
  return parseWithSchema(AgentCommandDescriptorSchema, input);
}

export function safeParseAgentCommandDescriptor(
  input: unknown,
): AgentProtocolParseResult<AgentCommandDescriptor> {
  return safeParseWithSchema(AgentCommandDescriptorSchema, input);
}

export function parseAgentCommandCatalog(input: unknown): AgentCommandCatalog {
  return parseWithSchema(AgentCommandCatalogSchema, input);
}

export function safeParseAgentCommandCatalog(
  input: unknown,
): AgentProtocolParseResult<AgentCommandCatalog> {
  return safeParseWithSchema(AgentCommandCatalogSchema, input);
}
