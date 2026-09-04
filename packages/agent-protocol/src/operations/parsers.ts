// ------------------------------------------------------------------------------------------------
//                parsers.ts - Plain typed operation parsers - Dependencies: operation schemas
// ------------------------------------------------------------------------------------------------

import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
  type ValidationIssue,
} from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentOperationCatalogSchema,
  AgentOperationDescriptorSchema,
  AgentOperationInvocationSchema,
  AgentOperationResultSchema,
} from '../zod/operations.js';
import type {
  AgentOperationCatalog,
  AgentOperationDescriptor,
  AgentOperationInvocation,
  AgentOperationResult,
} from './types.js';

export function parseAgentOperationDescriptor(
  input: unknown,
): AgentOperationDescriptor {
  return parseWithSchema(AgentOperationDescriptorSchema, input);
}

export function safeParseAgentOperationDescriptor(
  input: unknown,
): AgentProtocolParseResult<AgentOperationDescriptor> {
  return safeParseWithSchema(AgentOperationDescriptorSchema, input);
}

export function parseAgentOperationCatalog(input: unknown): AgentOperationCatalog {
  return parseWithSchema(AgentOperationCatalogSchema, input);
}

export function safeParseAgentOperationCatalog(
  input: unknown,
): AgentProtocolParseResult<AgentOperationCatalog> {
  return safeParseWithSchema(AgentOperationCatalogSchema, input);
}

export function parseAgentOperationInvocation(
  input: unknown,
): AgentOperationInvocation {
  return parseWithSchema(AgentOperationInvocationSchema, input);
}

export function safeParseAgentOperationInvocation(
  input: unknown,
): AgentProtocolParseResult<AgentOperationInvocation> {
  return safeParseWithSchema(AgentOperationInvocationSchema, input);
}

export function parseAgentOperationResult(input: unknown): AgentOperationResult {
  return parseWithSchema(AgentOperationResultSchema, input);
}

export function safeParseAgentOperationResult(
  input: unknown,
): AgentProtocolParseResult<AgentOperationResult> {
  return safeParseWithSchema(AgentOperationResultSchema, input);
}

function issue(
  path: readonly (string | number)[],
  message: string,
): ValidationIssue {
  return { code: 'custom', path, message };
}

export function safeParseAgentOperationInvocationFor(
  descriptorInput: unknown,
  invocationInput: unknown,
): AgentProtocolParseResult<AgentOperationInvocation> {
  const descriptor = safeParseAgentOperationDescriptor(descriptorInput);
  if (!descriptor.success) return descriptor;
  const invocation = safeParseAgentOperationInvocation(invocationInput);
  if (!invocation.success) return invocation;

  const issues: ValidationIssue[] = [];
  if (invocation.data.operationId !== descriptor.data.operationId) {
    issues.push(issue(
      ['operationId'],
      'Invocation operationId must match the selected operation.',
    ));
  }
  if (invocation.data.expectedRevision !== descriptor.data.revision) {
    issues.push(issue(
      ['expectedRevision'],
      'Invocation revision must match the selected operation revision.',
    ));
  }

  const values = new Map(
    invocation.data.values.map((value) => [value.fieldId, value]),
  );
  for (const [valueIndex, value] of invocation.data.values.entries()) {
    const field = descriptor.data.fields.find(
      (candidate) => candidate.fieldId === value.fieldId,
    );
    if (field === undefined) {
      issues.push(issue(
        ['values', valueIndex, 'fieldId'],
        'Invocation fields must be declared by the selected operation.',
      ));
      continue;
    }
    if (field.fieldKind !== value.fieldKind) {
      issues.push(issue(
        ['values', valueIndex, 'fieldKind'],
        'Invocation field kind must match the selected operation field.',
      ));
      continue;
    }
    if (field.fieldKind === 'text' && value.fieldKind === 'text') {
      if (value.value.length > field.maxLength) {
        issues.push(issue(
          ['values', valueIndex, 'value'],
          'Invocation text exceeds the operation field maximum.',
        ));
      }
    } else if (
      field.fieldKind === 'single_select'
      && value.fieldKind === 'single_select'
      && !field.options.some((option) => option.optionId === value.optionId)
    ) {
      issues.push(issue(
        ['values', valueIndex, 'optionId'],
        'Invocation selection must reference an offered option.',
      ));
    } else if (
      field.fieldKind === 'multi_select'
      && value.fieldKind === 'multi_select'
    ) {
      const allowed = new Set(field.options.map((option) => option.optionId));
      if (value.optionIds.some((optionId) => !allowed.has(optionId))) {
        issues.push(issue(
          ['values', valueIndex, 'optionIds'],
          'Invocation selections must reference offered options.',
        ));
      }
      if (value.optionIds.length > field.maxSelections) {
        issues.push(issue(
          ['values', valueIndex, 'optionIds'],
          'Invocation selections exceed the operation field maximum.',
        ));
      }
    } else if (
      field.fieldKind === 'integer'
      && value.fieldKind === 'integer'
      && (value.value < field.minimum || value.value > field.maximum)
    ) {
      issues.push(issue(
        ['values', valueIndex, 'value'],
        'Invocation integer is outside the operation field bounds.',
      ));
    }
  }
  for (const field of descriptor.data.fields) {
    if (field.required && !values.has(field.fieldId)) {
      issues.push(issue(
        ['values'],
        `Required operation field ${field.fieldId} is missing.`,
      ));
    }
  }
  return issues.length === 0
    ? invocation
    : { success: false, issues };
}

export function parseAgentOperationInvocationFor(
  descriptorInput: unknown,
  invocationInput: unknown,
): AgentOperationInvocation {
  const parsed = safeParseAgentOperationInvocationFor(
    descriptorInput,
    invocationInput,
  );
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}

export function safeParseAgentOperationResultFor(
  descriptorInput: unknown,
  invocationInput: unknown,
  resultInput: unknown,
): AgentProtocolParseResult<AgentOperationResult> {
  const descriptor = safeParseAgentOperationDescriptor(descriptorInput);
  if (!descriptor.success) return descriptor;
  const invocation = safeParseAgentOperationInvocationFor(
    descriptor.data,
    invocationInput,
  );
  if (!invocation.success) return invocation;
  const result = safeParseAgentOperationResult(resultInput);
  if (!result.success) return result;
  const issues: ValidationIssue[] = [];
  if (result.data.invocationId !== invocation.data.invocationId) {
    issues.push(issue(
          ['invocationId'],
          'Operation result invocationId must match the invocation.',
    ));
  }
  if (result.data.status === 'completed') {
    const hasArtifacts = (result.data.artifactIds?.length ?? 0) > 0;
    const hasResources = (result.data.resourceIds?.length ?? 0) > 0;
    const hasOutputText = result.data.outputText !== undefined;
    const matchesResultKind =
      (descriptor.data.resultKind === 'none' && !hasArtifacts && !hasResources && !hasOutputText)
      || (descriptor.data.resultKind === 'canonical_output' && hasOutputText && !hasArtifacts && !hasResources)
      || (descriptor.data.resultKind === 'artifact' && hasArtifacts && !hasResources && !hasOutputText)
      || (descriptor.data.resultKind === 'resource' && hasResources && !hasArtifacts && !hasOutputText);
    if (!matchesResultKind) {
      issues.push(issue(
        [],
        'Completed operation result values must match the descriptor result kind.',
      ));
    }
  }
  return issues.length === 0 ? result : { success: false, issues };
}

export function parseAgentOperationResultFor(
  descriptorInput: unknown,
  invocationInput: unknown,
  resultInput: unknown,
): AgentOperationResult {
  const parsed = safeParseAgentOperationResultFor(
    descriptorInput,
    invocationInput,
    resultInput,
  );
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}
