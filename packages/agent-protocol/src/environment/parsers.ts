// ------------------------------------------------------------------------------------------------
//                parsers.ts - Agent environment observation parsers - Dependencies: environment schemas
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentEnvironmentCapabilitySchema,
  AgentEnvironmentContentResultSchema,
  AgentEnvironmentCommandsResultSchema,
  AgentEnvironmentExtensionsResultSchema,
  AgentEnvironmentIntegrationsResultSchema,
  AgentEnvironmentInvalidationSchema,
  AgentEnvironmentSnapshotSchema,
} from '../zod/environment.js';
import type {
  AgentEnvironmentCapability,
  AgentEnvironmentContentResult,
  AgentEnvironmentCommandsResult,
  AgentEnvironmentExtensionsResult,
  AgentEnvironmentIntegrationsResult,
  AgentEnvironmentInvalidation,
  AgentEnvironmentSnapshot,
} from './types.js';

export function parseAgentEnvironmentCapability(
  input: unknown,
): AgentEnvironmentCapability {
  return parseWithSchema(AgentEnvironmentCapabilitySchema, input);
}

export function safeParseAgentEnvironmentCapability(
  input: unknown,
): AgentProtocolParseResult<AgentEnvironmentCapability> {
  return safeParseWithSchema(AgentEnvironmentCapabilitySchema, input);
}

export function parseAgentEnvironmentContentResult(
  input: unknown,
): AgentEnvironmentContentResult {
  return parseWithSchema(AgentEnvironmentContentResultSchema, input);
}

export function safeParseAgentEnvironmentContentResult(
  input: unknown,
): AgentProtocolParseResult<AgentEnvironmentContentResult> {
  return safeParseWithSchema(AgentEnvironmentContentResultSchema, input);
}

export function parseAgentEnvironmentCommandsResult(
  input: unknown,
): AgentEnvironmentCommandsResult {
  return parseWithSchema(AgentEnvironmentCommandsResultSchema, input);
}

export function safeParseAgentEnvironmentCommandsResult(
  input: unknown,
): AgentProtocolParseResult<AgentEnvironmentCommandsResult> {
  return safeParseWithSchema(AgentEnvironmentCommandsResultSchema, input);
}

export function parseAgentEnvironmentExtensionsResult(
  input: unknown,
): AgentEnvironmentExtensionsResult {
  return parseWithSchema(AgentEnvironmentExtensionsResultSchema, input);
}

export function safeParseAgentEnvironmentExtensionsResult(
  input: unknown,
): AgentProtocolParseResult<AgentEnvironmentExtensionsResult> {
  return safeParseWithSchema(AgentEnvironmentExtensionsResultSchema, input);
}

export function parseAgentEnvironmentIntegrationsResult(
  input: unknown,
): AgentEnvironmentIntegrationsResult {
  return parseWithSchema(AgentEnvironmentIntegrationsResultSchema, input);
}

export function safeParseAgentEnvironmentIntegrationsResult(
  input: unknown,
): AgentProtocolParseResult<AgentEnvironmentIntegrationsResult> {
  return safeParseWithSchema(AgentEnvironmentIntegrationsResultSchema, input);
}

export function parseAgentEnvironmentInvalidation(
  input: unknown,
): AgentEnvironmentInvalidation {
  return parseWithSchema(AgentEnvironmentInvalidationSchema, input);
}

export function safeParseAgentEnvironmentInvalidation(
  input: unknown,
): AgentProtocolParseResult<AgentEnvironmentInvalidation> {
  return safeParseWithSchema(AgentEnvironmentInvalidationSchema, input);
}

export function parseAgentEnvironmentSnapshot(
  input: unknown,
): AgentEnvironmentSnapshot {
  return parseWithSchema(AgentEnvironmentSnapshotSchema, input);
}

export function safeParseAgentEnvironmentSnapshot(
  input: unknown,
): AgentProtocolParseResult<AgentEnvironmentSnapshot> {
  return safeParseWithSchema(AgentEnvironmentSnapshotSchema, input);
}
