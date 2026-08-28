// ------------------------------------------------------------------------------------------------
//                types.ts - Portable artifact descriptors - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type { AgentArtifactId } from '../foundation/index.js';

export const AGENT_ARTIFACT_KINDS = [
  'plan',
  'diff',
  'file',
  'log',
  'image',
  'report',
  'other',
] as const;

export const AGENT_ARTIFACT_DISPLAY_NAME_MAX_LENGTH = 200;
export const AGENT_ARTIFACT_BYTE_SIZE_MAX = Number.MAX_SAFE_INTEGER;

export type AgentArtifactKind = (typeof AGENT_ARTIFACT_KINDS)[number];

export interface AgentArtifactDigest {
  readonly algorithm: 'sha256';
  readonly value: string;
}

export interface AgentArtifactDescriptor {
  readonly artifactId: AgentArtifactId;
  readonly kind: AgentArtifactKind;
  readonly displayName: string;
  readonly mediaType?: string;
  readonly byteSize?: number;
  readonly digest?: AgentArtifactDigest;
  readonly summary?: string;
}
