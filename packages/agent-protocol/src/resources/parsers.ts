// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain generated resource parsers - Dependencies: resource schema
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { AgentGeneratedResourceDescriptorSchema } from '../zod/resources.js';
import type { AgentGeneratedResourceDescriptor } from './types.js';

export function parseAgentGeneratedResourceDescriptor(
  input: unknown,
): AgentGeneratedResourceDescriptor {
  return parseWithSchema(AgentGeneratedResourceDescriptorSchema, input);
}

export function safeParseAgentGeneratedResourceDescriptor(
  input: unknown,
): AgentProtocolParseResult<AgentGeneratedResourceDescriptor> {
  return safeParseWithSchema(AgentGeneratedResourceDescriptorSchema, input);
}
