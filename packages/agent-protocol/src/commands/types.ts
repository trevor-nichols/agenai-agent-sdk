// ------------------------------------------------------------------------------------------------
//                types.ts - Native command advertisement contracts - Dependencies: foundation, environment facts
// ------------------------------------------------------------------------------------------------

import type {
  AgentCommandId,
  AgentIsoDateTime,
  AgentOperationId,
} from '../foundation/index.js';
import type {
  AgentAvailabilityFact,
  AgentEnvironmentSource,
} from '../environment/facts.js';

export const AGENT_COMMAND_NAME_MAX_LENGTH = 200;
export const AGENT_COMMAND_SUMMARY_MAX_LENGTH = 2_000;
export const AGENT_COMMAND_CATALOG_MAX_LENGTH = 1_024;
export const AGENT_COMMAND_CATALOG_BYTES_LIMIT = 512 * 1024;

export interface AgentCommandOperationReference {
  readonly operationId: AgentOperationId;
  readonly revision: number;
  readonly catalogRevision: number;
}

export interface AgentCommandDescriptor {
  readonly commandId: AgentCommandId;
  readonly revision: number;
  readonly name: string;
  readonly summary?: string;
  readonly source: AgentEnvironmentSource;
  readonly availability: AgentAvailabilityFact;
  readonly operation?: AgentCommandOperationReference;
}

export interface AgentCommandCatalog {
  readonly revision: number;
  readonly observedAt: AgentIsoDateTime;
  readonly commands: readonly AgentCommandDescriptor[];
}
