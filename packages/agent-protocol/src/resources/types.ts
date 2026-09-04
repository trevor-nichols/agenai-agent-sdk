// ------------------------------------------------------------------------------------------------
//                types.ts - Generated resource lifecycle contracts - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentArtifactId,
  AgentCollaborationId,
  AgentError,
  AgentGeneratedResourceId,
  AgentIsoDateTime,
  AgentOperationInvocationId,
  AgentSessionId,
  AgentTurnId,
} from '../foundation/index.js';

export const AGENT_GENERATED_RESOURCE_KINDS = [
  'image',
  'document',
  'archive',
] as const;
export const AGENT_GENERATED_RESOURCE_STATUSES = [
  'pending',
  'available',
  'unavailable',
  'expired',
] as const;
export const AGENT_GENERATED_RESOURCE_DISPLAY_NAME_MAX_LENGTH = 200;
export const AGENT_GENERATED_RESOURCE_SUMMARY_MAX_LENGTH = 2_000;

export type AgentGeneratedResourceKind =
  (typeof AGENT_GENERATED_RESOURCE_KINDS)[number];
export type AgentGeneratedResourceStatus =
  (typeof AGENT_GENERATED_RESOURCE_STATUSES)[number];

export type AgentGeneratedResourceProducer =
  | Readonly<{ kind: 'session'; sessionId: AgentSessionId }>
  | Readonly<{ kind: 'turn'; turnId: AgentTurnId }>
  | Readonly<{
      kind: 'operation';
      invocationId: AgentOperationInvocationId;
    }>
  | Readonly<{
      kind: 'collaboration';
      collaborationId: AgentCollaborationId;
    }>;

export interface AgentGeneratedResourceDescriptor {
  readonly resourceId: AgentGeneratedResourceId;
  readonly kind: AgentGeneratedResourceKind;
  readonly status: AgentGeneratedResourceStatus;
  readonly displayName: string;
  readonly producer: AgentGeneratedResourceProducer;
  readonly summary?: string;
  readonly mediaType?: string;
  readonly byteSize?: number;
  readonly sha256?: string;
  readonly widthPixels?: number;
  readonly heightPixels?: number;
  readonly pageCount?: number;
  readonly artifactId?: AgentArtifactId;
  readonly createdAt: AgentIsoDateTime;
  readonly expiresAt?: AgentIsoDateTime;
  readonly error?: AgentError;
}
