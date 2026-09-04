// ------------------------------------------------------------------------------------------------
//                types.ts - Managed content inventory contracts - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type { AgentManagedContentId } from '../foundation/index.js';

export const AGENT_MANAGED_CONTENT_KINDS = [
  'skill',
  'rule',
  'prompt',
  'agent_definition',
] as const;
export const AGENT_MANAGED_CONTENT_SOURCES = ['platform', 'team'] as const;
export const AGENT_MANAGED_CONTENT_STATUSES = ['available', 'disabled'] as const;
export const AGENT_MANAGED_CONTENT_NAME_MAX_LENGTH = 200;
export const AGENT_MANAGED_CONTENT_SUMMARY_MAX_LENGTH = 2_000;
export const AGENT_MANAGED_CONTENT_PROMPT_MAX_LENGTH = 16_384;
export const AGENT_MANAGED_CONTENT_CATALOG_MAX_LENGTH = 100;

export type AgentManagedContentKind =
  (typeof AGENT_MANAGED_CONTENT_KINDS)[number];
export type AgentManagedContentSource =
  (typeof AGENT_MANAGED_CONTENT_SOURCES)[number];
export type AgentManagedContentStatus =
  (typeof AGENT_MANAGED_CONTENT_STATUSES)[number];

export interface AgentManagedContentDigest {
  readonly algorithm: 'sha256';
  readonly value: string;
}

export type AgentManagedContentInvocation =
  | Readonly<{
      readonly kind: 'provider_materialization';
    }>
  | Readonly<{
      readonly kind: 'prompt_recipe';
      readonly prompt: string;
      readonly confirmation: 'none' | 'required';
    }>;

export interface AgentManagedContentDescriptor {
  readonly contentId: AgentManagedContentId;
  readonly revision: number;
  readonly kind: AgentManagedContentKind;
  readonly source: AgentManagedContentSource;
  readonly status: AgentManagedContentStatus;
  readonly name: string;
  readonly summary?: string;
  readonly byteSize: number;
  readonly digest: AgentManagedContentDigest;
  readonly invocation: AgentManagedContentInvocation;
}

export interface AgentManagedContentCatalog {
  readonly revision: number;
  readonly entries: readonly AgentManagedContentDescriptor[];
}
