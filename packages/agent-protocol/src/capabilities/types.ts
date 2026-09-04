// ------------------------------------------------------------------------------------------------
//                types.ts - Technical provider capabilities - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type { AgentArtifactKind } from '../artifacts/index.js';
import type {
  AgentCollaborationControlAction,
  AgentCollaborationRole,
} from '../collaboration/index.js';
import type { AgentConfigurationFieldKind } from '../configuration/index.js';
import type { AgentProviderKey } from '../foundation/index.js';
import type { AgentIntegrationKind } from '../integrations/index.js';
import type { AgentManagedContentKind } from '../managedContent/index.js';
import type {
  AgentOperationExecutionMode,
  AgentOperationFieldKind,
  AgentOperationKind,
} from '../operations/index.js';
import type { AgentGeneratedResourceKind } from '../resources/index.js';
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
  AgentElicitationFieldKind,
} from '../requests/types.js';

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

export type AgentFileChangeMode = (typeof AGENT_FILE_CHANGE_MODES)[number];
export type AgentAuthenticationFlow =
  (typeof AGENT_AUTHENTICATION_FLOWS)[number];

export type AgentBranchCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'through_turn' }>;

export type AgentElicitationCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      fieldKinds: readonly AgentElicitationFieldKind[];
      maxFields: number;
      sensitiveFields: boolean;
    }>;

export type AgentConfigurationCapability =
  | Readonly<{ kind: 'managed' }>
  | Readonly<{
      kind: 'selectable';
      fieldKinds: readonly AgentConfigurationFieldKind[];
      maxFields: number;
    }>;

export type AgentOperationsCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      operationKinds: readonly AgentOperationKind[];
      fieldKinds: readonly AgentOperationFieldKind[];
      executionModes: readonly AgentOperationExecutionMode[];
      maxOperations: number;
      maxFieldsPerOperation: number;
    }>;

export type AgentManagedContentCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      contentKinds: readonly AgentManagedContentKind[];
      maxEntries: number;
    }>;

export type AgentIntegrationsCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      integrationKinds: readonly AgentIntegrationKind[];
      maxIntegrations: number;
      maxServersPerIntegration: number;
      maxToolsPerServer: number;
      maxResourcesPerServer: number;
    }>;

export type AgentCollaborationCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      roles: readonly AgentCollaborationRole[];
      controlActions: readonly AgentCollaborationControlAction[];
      maxDepth: number;
      maxChildrenPerNode: number;
      maxActiveNodes: number;
    }>;

export type AgentGeneratedResourcesCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      resourceKinds: readonly AgentGeneratedResourceKind[];
      maxResourcesPerTurn: number;
      maxBytesPerResource: number;
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
  readonly protocolVersion: 8;
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
  readonly operations: AgentOperationsCapability;
  readonly managedContent: AgentManagedContentCapability;
  readonly integrations: AgentIntegrationsCapability;
  readonly collaboration: AgentCollaborationCapability;
  readonly generatedResources: AgentGeneratedResourcesCapability;
  readonly authentication: AgentAuthenticationCapability;
  readonly versionReporting: boolean;
}
