// ------------------------------------------------------------------------------------------------
//                artifacts.ts - Portable artifact descriptor schema - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_ARTIFACT_BYTE_SIZE_MAX,
  AGENT_ARTIFACT_DISPLAY_NAME_MAX_LENGTH,
  AGENT_ARTIFACT_KINDS,
  type AgentArtifactDescriptor,
} from '../artifacts/types.js';
import { AGENT_PROTOCOL_SUMMARY_MAX_LENGTH } from '../foundation/types.js';
import {
  AgentArtifactIdSchema,
  createAgentCanonicalNonBlankStringSchema,
} from './foundation.js';

export const AgentArtifactDescriptorSchema: z.ZodType<AgentArtifactDescriptor> =
  z
    .object({
      artifactId: AgentArtifactIdSchema,
      kind: z.enum(AGENT_ARTIFACT_KINDS),
      displayName: createAgentCanonicalNonBlankStringSchema(
        AGENT_ARTIFACT_DISPLAY_NAME_MAX_LENGTH,
      ),
      mediaType: z
        .string()
        .min(1)
        .max(160)
        .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/iu)
        .optional(),
      byteSize: z
        .number()
        .int()
        .min(0)
        .max(AGENT_ARTIFACT_BYTE_SIZE_MAX)
        .optional(),
      digest: z
        .object({
          algorithm: z.literal('sha256'),
          value: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict()
        .readonly()
        .optional(),
      summary: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
    })
    .strict()
    .readonly();
