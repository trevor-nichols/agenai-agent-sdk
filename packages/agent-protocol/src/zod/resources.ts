// ------------------------------------------------------------------------------------------------
//                resources.ts - Generated resource schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { AGENT_ARTIFACT_BYTE_SIZE_MAX } from '../artifacts/types.js';
import {
  AGENT_GENERATED_RESOURCE_DISPLAY_NAME_MAX_LENGTH,
  AGENT_GENERATED_RESOURCE_KINDS,
  AGENT_GENERATED_RESOURCE_STATUSES,
  AGENT_GENERATED_RESOURCE_SUMMARY_MAX_LENGTH,
  type AgentGeneratedResourceDescriptor,
} from '../resources/types.js';
import {
  AgentArtifactIdSchema,
  AgentCollaborationIdSchema,
  AgentErrorSchema,
  AgentGeneratedResourceIdSchema,
  AgentIsoDateTimeSchema,
  AgentOperationInvocationIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  createAgentCanonicalNonBlankStringSchema,
} from './foundation.js';

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const MediaTypeSchema = z.string().min(1).max(200).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u);
const ProducerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: AgentSessionIdSchema }).strict().readonly(),
  z.object({ kind: z.literal('turn'), turnId: AgentTurnIdSchema }).strict().readonly(),
  z.object({ kind: z.literal('operation'), invocationId: AgentOperationInvocationIdSchema }).strict().readonly(),
  z.object({ kind: z.literal('collaboration'), collaborationId: AgentCollaborationIdSchema }).strict().readonly(),
]);

export const AgentGeneratedResourceDescriptorPortableSchema = z.object({
  resourceId: AgentGeneratedResourceIdSchema,
  kind: z.enum(AGENT_GENERATED_RESOURCE_KINDS),
  status: z.enum(AGENT_GENERATED_RESOURCE_STATUSES),
  displayName: createAgentCanonicalNonBlankStringSchema(AGENT_GENERATED_RESOURCE_DISPLAY_NAME_MAX_LENGTH),
  producer: ProducerSchema,
  summary: createAgentCanonicalNonBlankStringSchema(AGENT_GENERATED_RESOURCE_SUMMARY_MAX_LENGTH).optional(),
  mediaType: MediaTypeSchema.optional(),
  byteSize: z.number().int().nonnegative().max(AGENT_ARTIFACT_BYTE_SIZE_MAX).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  widthPixels: PositiveSafeIntegerSchema.optional(),
  heightPixels: PositiveSafeIntegerSchema.optional(),
  pageCount: PositiveSafeIntegerSchema.optional(),
  artifactId: AgentArtifactIdSchema.optional(),
  createdAt: AgentIsoDateTimeSchema,
  expiresAt: AgentIsoDateTimeSchema.optional(),
  error: AgentErrorSchema.optional(),
}).strict().readonly();

export const AgentGeneratedResourceDescriptorSchema: z.ZodType<AgentGeneratedResourceDescriptor> =
  AgentGeneratedResourceDescriptorPortableSchema.superRefine((resource, context) => {
    const available = resource.status === 'available';
    if (available !== (resource.artifactId !== undefined)) {
      context.addIssue({ code: 'custom', path: ['artifactId'], message: 'Exactly available resources must reference a published artifact.' });
    }
    if (available !== (resource.sha256 !== undefined)) {
      context.addIssue({ code: 'custom', path: ['sha256'], message: 'Exactly available resources must include a SHA-256 digest.' });
    }
    if (available && (resource.byteSize === undefined || resource.mediaType === undefined)) {
      context.addIssue({ code: 'custom', path: ['byteSize'], message: 'Available resources must include byte size and media type.' });
    }
    if ((resource.status === 'unavailable') !== (resource.error !== undefined)) {
      context.addIssue({ code: 'custom', path: ['error'], message: 'Exactly unavailable resources must include an error.' });
    }
    if (resource.status === 'expired' && resource.expiresAt === undefined) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expired resources must include their expiry.' });
    }
    if ((resource.widthPixels === undefined) !== (resource.heightPixels === undefined)) {
      context.addIssue({ code: 'custom', path: ['widthPixels'], message: 'Image dimensions must include both width and height.' });
    }
    if (available && resource.kind === 'image' && resource.widthPixels === undefined) {
      context.addIssue({ code: 'custom', path: ['widthPixels'], message: 'Available image resources must include decoded dimensions.' });
    }
    if (resource.kind !== 'image' && resource.widthPixels !== undefined) {
      context.addIssue({ code: 'custom', path: ['widthPixels'], message: 'Only image resources may include pixel dimensions.' });
    }
    if (resource.kind !== 'document' && resource.pageCount !== undefined) {
      context.addIssue({ code: 'custom', path: ['pageCount'], message: 'Only document resources may include a page count.' });
    }
    if (resource.expiresAt !== undefined && Date.parse(resource.expiresAt) <= Date.parse(resource.createdAt)) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Resource expiry must follow creation.' });
    }
  });
