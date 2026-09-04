// ------------------------------------------------------------------------------------------------
//                types.ts - Safe configuration inventory contracts - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

export const AGENT_CONFIGURATION_FIELD_KINDS = [
  'boolean',
  'single_select',
  'bounded_integer',
  'bounded_text',
] as const;
export const AGENT_CONFIGURATION_SCOPES = ['session', 'provider_instance'] as const;
export const AGENT_CONFIGURATION_APPLICATION_TIMINGS = [
  'immediate',
  'next_session',
  'provider_restart',
] as const;
export const AGENT_CONFIGURATION_FIELDS_MAX_LENGTH = 100;
export const AGENT_CONFIGURATION_OPTIONS_MAX_LENGTH = 100;
export const AGENT_CONFIGURATION_LABEL_MAX_LENGTH = 200;
export const AGENT_CONFIGURATION_DESCRIPTION_MAX_LENGTH = 2_000;
export const AGENT_CONFIGURATION_TEXT_VALUE_MAX_LENGTH = 4_000;

export type AgentConfigurationFieldKind =
  (typeof AGENT_CONFIGURATION_FIELD_KINDS)[number];
export type AgentConfigurationScope =
  (typeof AGENT_CONFIGURATION_SCOPES)[number];
export type AgentConfigurationApplicationTiming =
  (typeof AGENT_CONFIGURATION_APPLICATION_TIMINGS)[number];

export interface AgentConfigurationSelectOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

interface AgentConfigurationFieldBase {
  readonly key: string;
  readonly revision: number;
  readonly label: string;
  readonly description?: string;
  readonly scope: AgentConfigurationScope;
  readonly applicationTiming: AgentConfigurationApplicationTiming;
  readonly mutable: boolean;
}

export interface AgentBooleanConfigurationField
  extends AgentConfigurationFieldBase {
  readonly fieldKind: 'boolean';
  readonly currentValue: boolean;
}

export interface AgentSingleSelectConfigurationField
  extends AgentConfigurationFieldBase {
  readonly fieldKind: 'single_select';
  readonly currentValue: string;
  readonly options: readonly AgentConfigurationSelectOption[];
}

export interface AgentBoundedIntegerConfigurationField
  extends AgentConfigurationFieldBase {
  readonly fieldKind: 'bounded_integer';
  readonly currentValue: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface AgentBoundedTextConfigurationField
  extends AgentConfigurationFieldBase {
  readonly fieldKind: 'bounded_text';
  readonly currentValue: string;
  readonly maxLength: number;
  readonly multiline: boolean;
}

export type AgentConfigurationField =
  | AgentBooleanConfigurationField
  | AgentSingleSelectConfigurationField
  | AgentBoundedIntegerConfigurationField
  | AgentBoundedTextConfigurationField;

export interface AgentConfigurationCatalog {
  readonly revision: number;
  readonly fields: readonly AgentConfigurationField[];
}

export type AgentConfigurationValue =
  | Readonly<{ fieldKind: 'boolean'; value: boolean }>
  | Readonly<{ fieldKind: 'single_select'; optionId: string }>
  | Readonly<{ fieldKind: 'bounded_integer'; value: number }>
  | Readonly<{ fieldKind: 'bounded_text'; value: string }>;

export interface AgentConfigurationSelectionInput {
  readonly key: string;
  readonly expectedCatalogRevision: number;
  readonly expectedFieldRevision: number;
  readonly value: AgentConfigurationValue;
}
