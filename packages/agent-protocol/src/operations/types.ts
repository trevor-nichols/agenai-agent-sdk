// ------------------------------------------------------------------------------------------------
//                types.ts - Typed provider-neutral operation contracts - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentArtifactId,
  AgentError,
  AgentGeneratedResourceId,
  AgentOperationId,
  AgentOperationInvocationId,
  AgentRequestFieldId,
} from '../foundation/index.js';

export const AGENT_OPERATION_KINDS = [
  'session_control',
  'managed_content_invoke',
  'configuration_select',
  'integration_control',
  'collaboration_control',
  'resource_generate',
] as const;
export const AGENT_OPERATION_CONTEXTS = [
  'workspace',
  'session',
  'turn',
  'collaboration',
  'resource',
] as const;
export const AGENT_OPERATION_TIMINGS = [
  'before_session',
  'idle_session',
  'active_turn',
] as const;
export const AGENT_OPERATION_EXECUTION_MODES = [
  'immediate',
  'request_continuation',
  'durable_job',
] as const;
export const AGENT_OPERATION_FIELD_KINDS = [
  'text',
  'boolean',
  'single_select',
  'multi_select',
  'integer',
] as const;
export const AGENT_OPERATION_RESULT_KINDS = [
  'none',
  'canonical_output',
  'artifact',
  'resource',
] as const;
export const AGENT_OPERATION_IDEMPOTENCY_REQUIREMENTS = [
  'required',
  'not_required',
] as const;

export const AGENT_OPERATION_TITLE_MAX_LENGTH = 200;
export const AGENT_OPERATION_DESCRIPTION_MAX_LENGTH = 2_000;
export const AGENT_OPERATION_TEXT_VALUE_MAX_LENGTH = 4_000;
export const AGENT_OPERATION_FIELDS_MAX_LENGTH = 16;
export const AGENT_OPERATION_OPTIONS_MAX_LENGTH = 100;
export const AGENT_OPERATION_CATALOG_MAX_LENGTH = 100;
export const AGENT_OPERATION_RESULT_REFERENCES_MAX_LENGTH = 100;
export const AGENT_OPERATION_OUTPUT_TEXT_MAX_LENGTH = 4_000;

export type AgentOperationKind = (typeof AGENT_OPERATION_KINDS)[number];
export type AgentOperationContext = (typeof AGENT_OPERATION_CONTEXTS)[number];
export type AgentOperationTiming = (typeof AGENT_OPERATION_TIMINGS)[number];
export type AgentOperationExecutionMode =
  (typeof AGENT_OPERATION_EXECUTION_MODES)[number];
export type AgentOperationFieldKind =
  (typeof AGENT_OPERATION_FIELD_KINDS)[number];
export type AgentOperationResultKind =
  (typeof AGENT_OPERATION_RESULT_KINDS)[number];
export type AgentOperationIdempotencyRequirement =
  (typeof AGENT_OPERATION_IDEMPOTENCY_REQUIREMENTS)[number];

export interface AgentOperationSelectOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

interface AgentOperationFieldBase {
  readonly fieldId: AgentRequestFieldId;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  readonly sensitivity: 'ordinary' | 'sensitive';
}

export interface AgentOperationTextField extends AgentOperationFieldBase {
  readonly fieldKind: 'text';
  readonly multiline: boolean;
  readonly maxLength: number;
}

export interface AgentOperationBooleanField extends AgentOperationFieldBase {
  readonly fieldKind: 'boolean';
}

export interface AgentOperationSingleSelectField extends AgentOperationFieldBase {
  readonly fieldKind: 'single_select';
  readonly options: readonly AgentOperationSelectOption[];
}

export interface AgentOperationMultiSelectField extends AgentOperationFieldBase {
  readonly fieldKind: 'multi_select';
  readonly options: readonly AgentOperationSelectOption[];
  readonly maxSelections: number;
}

export interface AgentOperationIntegerField extends AgentOperationFieldBase {
  readonly fieldKind: 'integer';
  readonly minimum: number;
  readonly maximum: number;
}

export type AgentOperationField =
  | AgentOperationTextField
  | AgentOperationBooleanField
  | AgentOperationSingleSelectField
  | AgentOperationMultiSelectField
  | AgentOperationIntegerField;

export interface AgentOperationDescriptor {
  readonly operationId: AgentOperationId;
  readonly revision: number;
  readonly kind: AgentOperationKind;
  readonly title: string;
  readonly description?: string;
  readonly context: AgentOperationContext;
  readonly timing: AgentOperationTiming;
  readonly executionMode: AgentOperationExecutionMode;
  readonly fields: readonly AgentOperationField[];
  readonly confirmation: 'none' | 'required';
  readonly idempotency: AgentOperationIdempotencyRequirement;
  readonly resultKind: AgentOperationResultKind;
}

export interface AgentOperationCatalog {
  readonly revision: number;
  readonly operations: readonly AgentOperationDescriptor[];
}

interface AgentOperationValueBase {
  readonly fieldId: AgentRequestFieldId;
}

export type AgentOperationFieldValue =
  | (AgentOperationValueBase & Readonly<{ fieldKind: 'text'; value: string }>)
  | (AgentOperationValueBase & Readonly<{ fieldKind: 'boolean'; value: boolean }>)
  | (AgentOperationValueBase & Readonly<{ fieldKind: 'single_select'; optionId: string }>)
  | (AgentOperationValueBase & Readonly<{ fieldKind: 'multi_select'; optionIds: readonly string[] }>)
  | (AgentOperationValueBase & Readonly<{ fieldKind: 'integer'; value: number }>);

export interface AgentOperationInvocation {
  readonly invocationId: AgentOperationInvocationId;
  readonly operationId: AgentOperationId;
  readonly expectedRevision: number;
  readonly values: readonly AgentOperationFieldValue[];
}

export type AgentOperationResultStatus =
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'waiting_for_request';

export interface AgentOperationResult {
  readonly invocationId: AgentOperationInvocationId;
  readonly status: AgentOperationResultStatus;
  readonly artifactIds?: readonly AgentArtifactId[];
  readonly resourceIds?: readonly AgentGeneratedResourceId[];
  readonly outputText?: string;
  readonly error?: AgentError;
}
