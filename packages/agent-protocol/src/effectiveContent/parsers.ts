// ------------------------------------------------------------------------------------------------
//                parsers.ts - Effective native content parsers - Dependencies: schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentEffectiveContentCatalogSchema,
  AgentEffectiveContentDescriptorSchema,
} from '../zod/effectiveContent.js';
import type {
  AgentEffectiveContentCatalog,
  AgentEffectiveContentDescriptor,
} from './types.js';

export function parseAgentEffectiveContentDescriptor(
  input: unknown,
): AgentEffectiveContentDescriptor {
  return parseWithSchema(AgentEffectiveContentDescriptorSchema, input);
}

export function safeParseAgentEffectiveContentDescriptor(
  input: unknown,
): AgentProtocolParseResult<AgentEffectiveContentDescriptor> {
  return safeParseWithSchema(AgentEffectiveContentDescriptorSchema, input);
}

export function parseAgentEffectiveContentCatalog(
  input: unknown,
): AgentEffectiveContentCatalog {
  return parseWithSchema(AgentEffectiveContentCatalogSchema, input);
}

export function safeParseAgentEffectiveContentCatalog(
  input: unknown,
): AgentProtocolParseResult<AgentEffectiveContentCatalog> {
  return safeParseWithSchema(AgentEffectiveContentCatalogSchema, input);
}
