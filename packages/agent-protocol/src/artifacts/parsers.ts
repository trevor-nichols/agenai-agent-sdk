// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain artifact descriptor parsers - Dependencies: artifact schema
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { AgentArtifactDescriptorSchema } from '../zod/artifacts.js';
import type { AgentArtifactDescriptor } from './types.js';

export function parseAgentArtifactDescriptor(
  input: unknown,
): AgentArtifactDescriptor {
  return parseWithSchema(AgentArtifactDescriptorSchema, input);
}

export function safeParseAgentArtifactDescriptor(
  input: unknown,
): AgentProtocolParseResult<AgentArtifactDescriptor> {
  return safeParseWithSchema(AgentArtifactDescriptorSchema, input);
}
