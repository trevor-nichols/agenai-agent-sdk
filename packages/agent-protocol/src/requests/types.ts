// ------------------------------------------------------------------------------------------------
//                types.ts - Approval and elicitation semantics - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentApprovalOptionId,
  AgentArtifactId,
  AgentIsoDateTime,
  AgentItemId,
  AgentRequestFieldId,
  AgentRequestId,
} from '../foundation/index.js';

// ------------------------------------------------------------------------------------------------
//                Request Contracts
// ------------------------------------------------------------------------------------------------

export const AGENT_APPROVAL_PERSISTENCES = [
  'once',
  'session',
  'workspace',
] as const;
export const AGENT_APPROVAL_SCOPE_KINDS = [
  'exact_action',
  'command_pattern',
  'domain',
  'tool',
  'server',
  'all_edits',
] as const;

export const AGENT_APPROVAL_OPTIONS_MAX_LENGTH = 16;
export const AGENT_APPROVAL_LABEL_MAX_LENGTH = 120;
export const AGENT_APPROVAL_DESCRIPTION_MAX_LENGTH = 1_000;
export const AGENT_ELICITATION_FIELD_KINDS = [
  'text',
  'single_select',
  'multi_select',
  'boolean',
  'confirmation',
] as const;
export const AGENT_ELICITATION_FIELDS_MAX_LENGTH = 16;
export const AGENT_ELICITATION_OPTIONS_MAX_LENGTH = 100;
export const AGENT_ELICITATION_TEXT_VALUE_MAX_LENGTH = 4_000;

export type AgentApprovalPersistence =
  (typeof AGENT_APPROVAL_PERSISTENCES)[number];
export type AgentApprovalScopeKind =
  (typeof AGENT_APPROVAL_SCOPE_KINDS)[number];
export type AgentElicitationFieldKind =
  (typeof AGENT_ELICITATION_FIELD_KINDS)[number];

interface AgentApprovalSubjectBase {
  readonly title: string;
  readonly description?: string;
}

export type AgentApprovalSubject =
  | (AgentApprovalSubjectBase & Readonly<{
      kind: 'plan';
      artifactId: AgentArtifactId;
    }>)
  | (AgentApprovalSubjectBase & Readonly<{
      kind: 'command' | 'file_change' | 'tool' | 'other';
      itemId: AgentItemId;
    }>);

export interface AgentApprovalOption {
  readonly optionId: AgentApprovalOptionId;
  readonly label: string;
  readonly description?: string;
  readonly decision: 'approved' | 'denied';
  readonly persistence: AgentApprovalPersistence;
  readonly scope: Readonly<{ kind: AgentApprovalScopeKind }>;
}

export interface AgentApprovalRequest {
  readonly requestKind: 'approval';
  readonly requestId: AgentRequestId;
  readonly prompt: string;
  readonly subject: AgentApprovalSubject;
  readonly options: readonly AgentApprovalOption[];
  readonly expiresAt?: AgentIsoDateTime;
}

export interface AgentRequestChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface AgentElicitationFieldBase {
  readonly fieldId: AgentRequestFieldId;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  readonly sensitivity: 'ordinary' | 'sensitive';
}

export interface AgentTextElicitationField extends AgentElicitationFieldBase {
  readonly kind: 'text';
  readonly multiline: boolean;
  readonly maxLength: number;
}

export interface AgentSingleSelectElicitationField
  extends AgentElicitationFieldBase {
  readonly kind: 'single_select';
  readonly options: readonly AgentRequestChoice[];
  readonly allowOther: boolean;
}

export interface AgentMultiSelectElicitationField
  extends AgentElicitationFieldBase {
  readonly kind: 'multi_select';
  readonly options: readonly AgentRequestChoice[];
  readonly allowOther: boolean;
  readonly maxSelections: number;
}

export interface AgentBooleanElicitationField extends AgentElicitationFieldBase {
  readonly kind: 'boolean';
}

export interface AgentConfirmationElicitationField
  extends AgentElicitationFieldBase {
  readonly kind: 'confirmation';
  readonly confirmLabel: string;
}

export type AgentElicitationField =
  | AgentTextElicitationField
  | AgentSingleSelectElicitationField
  | AgentMultiSelectElicitationField
  | AgentBooleanElicitationField
  | AgentConfirmationElicitationField;

export interface AgentElicitationRequest {
  readonly requestKind: 'elicitation';
  readonly requestId: AgentRequestId;
  readonly prompt: string;
  readonly fields: readonly AgentElicitationField[];
  readonly expiresAt?: AgentIsoDateTime;
}

export type AgentRequest = AgentApprovalRequest | AgentElicitationRequest;

// ------------------------------------------------------------------------------------------------
//                Resolution Contracts
// ------------------------------------------------------------------------------------------------

export type AgentApprovalResolution =
  | Readonly<{
      requestKind: 'approval';
      requestId: AgentRequestId;
      disposition: 'selected';
      optionId: AgentApprovalOptionId;
    }>
  | Readonly<{
      requestKind: 'approval';
      requestId: AgentRequestId;
      disposition: 'canceled';
    }>;

export interface AgentTextElicitationAnswer {
  readonly fieldId: AgentRequestFieldId;
  readonly kind: 'text';
  readonly value: string;
}

export interface AgentSingleSelectElicitationAnswer {
  readonly fieldId: AgentRequestFieldId;
  readonly kind: 'single_select';
  readonly value?: string;
  readonly other?: string;
}

export interface AgentMultiSelectElicitationAnswer {
  readonly fieldId: AgentRequestFieldId;
  readonly kind: 'multi_select';
  readonly values: readonly string[];
  readonly other?: string;
}

export interface AgentBooleanElicitationAnswer {
  readonly fieldId: AgentRequestFieldId;
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface AgentConfirmationElicitationAnswer {
  readonly fieldId: AgentRequestFieldId;
  readonly kind: 'confirmation';
  readonly confirmed: boolean;
}

export type AgentElicitationAnswer =
  | AgentTextElicitationAnswer
  | AgentSingleSelectElicitationAnswer
  | AgentMultiSelectElicitationAnswer
  | AgentBooleanElicitationAnswer
  | AgentConfirmationElicitationAnswer;

export interface AgentAnsweredElicitationResolution {
  readonly requestKind: 'elicitation';
  readonly requestId: AgentRequestId;
  readonly disposition: 'answered';
  readonly answers: readonly AgentElicitationAnswer[];
}

export interface AgentCanceledElicitationResolution {
  readonly requestKind: 'elicitation';
  readonly requestId: AgentRequestId;
  readonly disposition: 'canceled';
}

export type AgentElicitationResolution =
  | AgentAnsweredElicitationResolution
  | AgentCanceledElicitationResolution;

export type AgentRequestResolution =
  | AgentApprovalResolution
  | AgentElicitationResolution;
