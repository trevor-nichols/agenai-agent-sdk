// ------------------------------------------------------------------------------------------------
//                types.ts - Technical provider capabilities - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type { AgentArtifactKind } from '../artifacts/index.js';
import type { AgentProviderKey } from '../foundation/index.js';
import type {
  AgentContextCompactionTrigger,
  AgentContextCumulativeUsageField,
  AgentContextMeasurementScope,
  AgentImageInputMediaType,
  AgentImageInputSourceKind,
  AgentTurnInteractionMode,
} from '../turns/types.js';
import type {
  AgentApprovalPersistence,
  AgentApprovalScopeKind,
} from '../requests/types.js';

export const AGENT_ELICITATION_MODES = [
  'unsupported',
  'text',
  'structured',
] as const;
export const AGENT_FILE_CHANGE_MODES = [
  'none',
  'final_diff',
  'structured',
] as const;
export const AGENT_AUTHENTICATION_FLOWS = [
  'device_code',
  'browser',
  'terminal',
] as const;

export type AgentElicitationMode = (typeof AGENT_ELICITATION_MODES)[number];
export type AgentFileChangeMode = (typeof AGENT_FILE_CHANGE_MODES)[number];
export type AgentAuthenticationFlow =
  (typeof AGENT_AUTHENTICATION_FLOWS)[number];

export type AgentBranchCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'through_turn' }>;

export type AgentElicitationCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'text' }>
  | Readonly<{ kind: 'structured' }>;

export interface AgentConfigurationFieldCapability {
  readonly key: string;
  readonly optionIds: readonly string[];
}

export type AgentConfigurationCapability =
  | Readonly<{ kind: 'managed' }>
  | Readonly<{
      kind: 'selectable';
      fields: readonly AgentConfigurationFieldCapability[];
    }>;

export type AgentAuthenticationCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      flows: readonly AgentAuthenticationFlow[];
    }>;

export interface AgentApprovalCapabilityMode {
  readonly persistence: AgentApprovalPersistence;
  readonly scopeKinds: readonly AgentApprovalScopeKind[];
}

export type AgentApprovalCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      modes: readonly AgentApprovalCapabilityMode[];
    }>;

export type AgentContextUsageCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      measurementScopes: readonly AgentContextMeasurementScope[];
      cumulativeFields: readonly AgentContextCumulativeUsageField[];
    }>;

export type AgentContextCompactionCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      triggers: readonly AgentContextCompactionTrigger[];
      sameSessionContinuation: boolean;
    }>;

export type AgentImageInputCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      sourceKinds: readonly AgentImageInputSourceKind[];
      mediaTypes: readonly AgentImageInputMediaType[];
      maxImages: number;
      maxBytesPerImage: number;
      maxTotalBytes: number;
      maxWidthPixels: number;
      maxHeightPixels: number;
      maxPixelsPerImage: number;
      supportsImageOnly: boolean;
    }>;

export interface AgentOperationInputCapability {
  readonly text: true;
  readonly images: AgentImageInputCapability;
}

export type AgentTurnSteeringCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      input: AgentOperationInputCapability;
    }>;

export interface AgentCapabilities {
  readonly protocolVersion: 7;
  readonly providerKey: AgentProviderKey;
  readonly sessions: Readonly<{
    create: true;
    resume: boolean;
    branch: AgentBranchCapability;
  }>;
  readonly turns: Readonly<{
    interactionModes: readonly AgentTurnInteractionMode[];
    interrupt: boolean;
    steer: AgentTurnSteeringCapability;
  }>;
  readonly requests: Readonly<{
    approval: AgentApprovalCapability;
    elicitation: AgentElicitationCapability;
  }>;
  readonly context: Readonly<{
    usage: AgentContextUsageCapability;
    compaction: AgentContextCompactionCapability;
  }>;
  readonly input: AgentOperationInputCapability;
  readonly output: Readonly<{
    streaming: boolean;
    plans: boolean;
    fileChanges: AgentFileChangeMode;
    artifactKinds: readonly AgentArtifactKind[];
  }>;
  readonly configuration: AgentConfigurationCapability;
  readonly interactionExtensions: Readonly<{
    slashCommands: boolean;
    mcp: boolean;
    subagents: boolean;
    imageGeneration: boolean;
  }>;
  readonly authentication: AgentAuthenticationCapability;
  readonly versionReporting: boolean;
}
