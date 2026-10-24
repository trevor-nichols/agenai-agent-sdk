import type { AgentJsonObject, ValidationIssue } from '../foundation/types.js';
import type { AGENT_OUTPUT_SCHEMA_DIALECT, AGENT_OUTPUT_SCHEMA_PROFILE } from './constants.js';

interface AgentOutputSchemaDescription {
  readonly description?: string;
}

export interface AgentOutputObjectSchema extends AgentOutputSchemaDescription {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, AgentOutputSchemaNode>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface AgentOutputSchema extends AgentOutputObjectSchema {
  readonly $schema?: typeof AGENT_OUTPUT_SCHEMA_DIALECT;
}

export interface AgentOutputArraySchema extends AgentOutputSchemaDescription {
  readonly type: 'array';
  readonly items: AgentOutputSchemaNode;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface AgentOutputStringSchema extends AgentOutputSchemaDescription {
  readonly type: 'string';
  readonly enum?: readonly [string, ...string[]];
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface AgentOutputNumberSchema extends AgentOutputSchemaDescription {
  readonly type: 'integer' | 'number';
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface AgentOutputBooleanSchema extends AgentOutputSchemaDescription {
  readonly type: 'boolean';
}

export interface AgentOutputNullSchema extends AgentOutputSchemaDescription {
  readonly type: 'null';
}

export type AgentOutputNonNullSchema =
  | AgentOutputObjectSchema
  | AgentOutputArraySchema
  | AgentOutputStringSchema
  | AgentOutputNumberSchema
  | AgentOutputBooleanSchema;

export interface AgentOutputNullableSchema extends AgentOutputSchemaDescription {
  readonly anyOf: readonly [AgentOutputNonNullSchema, AgentOutputNullSchema];
}

export type AgentOutputSchemaNode =
  | AgentOutputNonNullSchema
  | AgentOutputNullSchema
  | AgentOutputNullableSchema;

export type AgentStructuredOutputCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
    kind: 'supported';
    mechanism: 'native';
    schemaProfile: typeof AGENT_OUTPUT_SCHEMA_PROFILE;
    scope: 'turn' | 'session';
    maxSchemaBytes: number;
    maxOutputBytes: number;
    resume: false;
    branch: false;
  }>;

export type AgentStructuredOutputRequest = Readonly<{
  kind: 'json_schema';
  schema: AgentOutputSchema;
}>;

export type AgentStructuredOutputUnavailableReason =
  | 'refused'
  | 'incomplete'
  | 'missing_output'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'output_limit_exceeded'
  | 'native_retries_exhausted'
  | 'provider_error';

export type AgentStructuredOutputNonJsonResult =
  | Readonly<{ kind: 'not_requested' }>
  | Readonly<{
    kind: 'unavailable';
    reason: 'schema_mismatch';
    issues?: readonly ValidationIssue[];
  }>
  | Readonly<{
    kind: 'unavailable';
    reason: Exclude<AgentStructuredOutputUnavailableReason, 'schema_mismatch'>;
  }>;

export type AgentStructuredOutputResult =
  | AgentStructuredOutputNonJsonResult
  | Readonly<{ kind: 'json'; value: AgentJsonObject }>;
