// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain managed content parsers - Dependencies: managed-content schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentManagedContentCatalogSchema,
  AgentManagedContentDescriptorSchema,
} from '../zod/managedContent.js';
import type {
  AgentManagedContentCatalog,
  AgentManagedContentDescriptor,
} from './types.js';

export function parseAgentManagedContentDescriptor(
  input: unknown,
): AgentManagedContentDescriptor {
  return parseWithSchema(AgentManagedContentDescriptorSchema, input);
}

export function safeParseAgentManagedContentDescriptor(
  input: unknown,
): AgentProtocolParseResult<AgentManagedContentDescriptor> {
  return safeParseWithSchema(AgentManagedContentDescriptorSchema, input);
}

export function parseAgentManagedContentCatalog(
  input: unknown,
): AgentManagedContentCatalog {
  return parseWithSchema(AgentManagedContentCatalogSchema, input);
}

export function safeParseAgentManagedContentCatalog(
  input: unknown,
): AgentProtocolParseResult<AgentManagedContentCatalog> {
  return safeParseWithSchema(AgentManagedContentCatalogSchema, input);
}
