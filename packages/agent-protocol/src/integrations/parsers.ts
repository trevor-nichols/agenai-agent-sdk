// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain safe integration parsers - Dependencies: integration schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentIntegrationCatalogSchema,
  AgentIntegrationDescriptorSchema,
} from '../zod/integrations.js';
import type {
  AgentIntegrationCatalog,
  AgentIntegrationDescriptor,
} from './types.js';

export function parseAgentIntegrationDescriptor(
  input: unknown,
): AgentIntegrationDescriptor {
  return parseWithSchema(AgentIntegrationDescriptorSchema, input);
}

export function safeParseAgentIntegrationDescriptor(
  input: unknown,
): AgentProtocolParseResult<AgentIntegrationDescriptor> {
  return safeParseWithSchema(AgentIntegrationDescriptorSchema, input);
}

export function parseAgentIntegrationCatalog(
  input: unknown,
): AgentIntegrationCatalog {
  return parseWithSchema(AgentIntegrationCatalogSchema, input);
}

export function safeParseAgentIntegrationCatalog(
  input: unknown,
): AgentProtocolParseResult<AgentIntegrationCatalog> {
  return safeParseWithSchema(AgentIntegrationCatalogSchema, input);
}
