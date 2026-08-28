// ------------------------------------------------------------------------------------------------
//                types.ts - Approval and elicitation semantics - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentArtifactId,
  AgentIsoDateTime,
  AgentRequestFieldId,
  AgentRequestId,
} from '../foundation/index.js';

// ------------------------------------------------------------------------------------------------
//                Request Contracts
// ------------------------------------------------------------------------------------------------

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
      artifactId?: never;
    }>);

export interface AgentApprovalRequest {
  readonly requestKind: 'approval';
  readonly requestId: AgentRequestId;
  readonly prompt: string;
  readonly subject: AgentApprovalSubject;
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
}

export interface AgentTextElicitationField extends AgentElicitationFieldBase {
  readonly kind: 'text';
  readonly multiline?: boolean;
}

export interface AgentChoiceElicitationField extends AgentElicitationFieldBase {
  readonly kind: 'choice';
  readonly options: readonly AgentRequestChoice[];
  readonly multiple: boolean;
  readonly allowOther: boolean;
}

export interface AgentBooleanElicitationField extends AgentElicitationFieldBase {
  readonly kind: 'boolean';
}

export type AgentElicitationField =
  | AgentTextElicitationField
  | AgentChoiceElicitationField
  | AgentBooleanElicitationField;

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

export interface AgentApprovalResolution {
  readonly requestKind: 'approval';
  readonly requestId: AgentRequestId;
  readonly decision: 'approved' | 'denied' | 'canceled';
}

export interface AgentTextElicitationAnswer {
  readonly fieldId: AgentRequestFieldId;
  readonly kind: 'text';
  readonly value: string;
}

export interface AgentChoiceElicitationAnswer {
  readonly fieldId: AgentRequestFieldId;
  readonly kind: 'choice';
  readonly values: readonly string[];
  readonly other?: string;
}

export interface AgentBooleanElicitationAnswer {
  readonly fieldId: AgentRequestFieldId;
  readonly kind: 'boolean';
  readonly value: boolean;
}

export type AgentElicitationAnswer =
  | AgentTextElicitationAnswer
  | AgentChoiceElicitationAnswer
  | AgentBooleanElicitationAnswer;

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
