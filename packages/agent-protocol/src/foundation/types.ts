// ------------------------------------------------------------------------------------------------
//                types.ts - Protocol primitives, opaque IDs, and bounds - Dependencies: validation
// ------------------------------------------------------------------------------------------------

export type {
  AgentProtocolParseFailure,
  AgentProtocolParseResult,
  AgentProtocolParseSuccess,
  ValidationIssue,
  ValidationPathSegment,
} from './validation.js';
export { AgentProtocolValidationError } from './validation.js';

// ------------------------------------------------------------------------------------------------
//                Protocol Version and Limits
// ------------------------------------------------------------------------------------------------

export const AGENT_PROTOCOL_VERSION = 6 as const;
export const AGENT_PROTOCOL_ID_MAX_LENGTH = 256;
export const AGENT_PROTOCOL_PROVIDER_REFERENCE_MAX_LENGTH = 512;
export const AGENT_PROTOCOL_PROVIDER_KEY_MAX_LENGTH = 100;
export const AGENT_PROTOCOL_CODE_MAX_LENGTH = 120;
export const AGENT_PROTOCOL_TEXT_MAX_LENGTH = 4_000;
export const AGENT_PROTOCOL_SUMMARY_MAX_LENGTH = 2_000;
export const AGENT_PROTOCOL_COLLECTION_MAX_LENGTH = 100;
export const AGENT_PROTOCOL_JSON_KEY_MAX_LENGTH = 128;
export const AGENT_PROTOCOL_JSON_DEPTH_LIMIT = 16;
export const AGENT_PROTOCOL_JSON_BYTES_LIMIT = 32_768;
export const AGENT_PROTOCOL_EVENT_BYTES_LIMIT = 32_768;
export const AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT = 1_064_960;

// ------------------------------------------------------------------------------------------------
//                Opaque Correlation IDs
// ------------------------------------------------------------------------------------------------

declare const agentProtocolIdBrand: unique symbol;

type AgentProtocolId<Kind extends string> = string & {
  readonly [agentProtocolIdBrand]: Kind;
};

export type AgentInstanceId = AgentProtocolId<'AgentInstanceId'>;
export type AgentSessionId = AgentProtocolId<'AgentSessionId'>;
export type AgentTurnId = AgentProtocolId<'AgentTurnId'>;
export type AgentItemId = AgentProtocolId<'AgentItemId'>;
export type AgentRequestId = AgentProtocolId<'AgentRequestId'>;
export type AgentRequestFieldId = AgentProtocolId<'AgentRequestFieldId'>;
export type AgentArtifactId = AgentProtocolId<'AgentArtifactId'>;
export type AgentConfigurationRevisionId =
  AgentProtocolId<'AgentConfigurationRevisionId'>;
export type AgentProviderConversationId =
  AgentProtocolId<'AgentProviderConversationId'>;
export type AgentProviderHistoryAnchor =
  AgentProtocolId<'AgentProviderHistoryAnchor'>;
export type AgentProviderTurnRef = AgentProtocolId<'AgentProviderTurnRef'>;
export type AgentProviderItemRef = AgentProtocolId<'AgentProviderItemRef'>;
export type AgentProviderRequestRef =
  AgentProtocolId<'AgentProviderRequestRef'>;

export type AgentProviderKey = string & {
  readonly [agentProtocolIdBrand]: 'AgentProviderKey';
};

export type AgentIsoDateTime = string & {
  readonly [agentProtocolIdBrand]: 'AgentIsoDateTime';
};

// ------------------------------------------------------------------------------------------------
//                JSON and Provider Correlation
// ------------------------------------------------------------------------------------------------

export type AgentJsonPrimitive = string | number | boolean | null;

export type AgentJsonValue =
  | AgentJsonPrimitive
  | readonly AgentJsonValue[]
  | { readonly [key: string]: AgentJsonValue };

export interface AgentProviderRefs {
  readonly conversationId?: AgentProviderConversationId;
  readonly historyAnchor?: AgentProviderHistoryAnchor;
  readonly turnId?: AgentProviderTurnRef;
  readonly itemId?: AgentProviderItemRef;
  readonly requestId?: AgentProviderRequestRef;
}

// ------------------------------------------------------------------------------------------------
//                Portable Error Semantics
// ------------------------------------------------------------------------------------------------

export interface AgentErrorContext {
  readonly operation?: string;
  readonly component?: string;
  readonly status?: string;
}

export interface AgentError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly context?: AgentErrorContext;
}

// ------------------------------------------------------------------------------------------------
//                JSON Byte Accounting
// ------------------------------------------------------------------------------------------------

const textEncoder = new TextEncoder();

export function agentProtocolSerializedJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Agent protocol value is not JSON serializable.');
  }
  return textEncoder.encode(serialized).byteLength;
}
