// ------------------------------------------------------------------------------------------------
//                parsers.ts - Safe configuration parsers - Dependencies: configuration schemas
// ------------------------------------------------------------------------------------------------

import {
  AgentProtocolValidationError,
  type AgentProtocolParseResult,
  type ValidationIssue,
} from '../foundation/index.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import {
  AgentConfigurationCatalogSchema,
  AgentConfigurationSelectionInputSchema,
} from '../zod/configuration.js';
import type {
  AgentConfigurationCatalog,
  AgentConfigurationSelectionInput,
} from './types.js';

export function parseAgentConfigurationCatalog(
  input: unknown,
): AgentConfigurationCatalog {
  return parseWithSchema(AgentConfigurationCatalogSchema, input);
}

export function safeParseAgentConfigurationCatalog(
  input: unknown,
): AgentProtocolParseResult<AgentConfigurationCatalog> {
  return safeParseWithSchema(AgentConfigurationCatalogSchema, input);
}

export function parseAgentConfigurationSelectionInput(
  input: unknown,
): AgentConfigurationSelectionInput {
  return parseWithSchema(AgentConfigurationSelectionInputSchema, input);
}

export function safeParseAgentConfigurationSelectionInput(
  input: unknown,
): AgentProtocolParseResult<AgentConfigurationSelectionInput> {
  return safeParseWithSchema(AgentConfigurationSelectionInputSchema, input);
}

function issue(
  path: readonly (string | number)[],
  message: string,
): ValidationIssue {
  return { code: 'custom', path, message };
}

export function safeParseAgentConfigurationSelectionFor(
  catalogInput: unknown,
  selectionInput: unknown,
): AgentProtocolParseResult<AgentConfigurationSelectionInput> {
  const catalog = safeParseAgentConfigurationCatalog(catalogInput);
  if (!catalog.success) return catalog;
  const selection = safeParseAgentConfigurationSelectionInput(selectionInput);
  if (!selection.success) return selection;
  const issues: ValidationIssue[] = [];

  if (selection.data.expectedCatalogRevision !== catalog.data.revision) {
    issues.push(issue(
      ['expectedCatalogRevision'],
      'Configuration selection must target the current catalog revision.',
    ));
  }
  const field = catalog.data.fields.find(
    (candidate) => candidate.key === selection.data.key,
  );
  if (field === undefined) {
    issues.push(issue(
      ['key'],
      'Configuration selection must target an offered field.',
    ));
    return { success: false, issues };
  }
  if (selection.data.expectedFieldRevision !== field.revision) {
    issues.push(issue(
      ['expectedFieldRevision'],
      'Configuration selection must target the current field revision.',
    ));
  }
  if (!field.mutable) {
    issues.push(issue(['key'], 'Configuration field is not mutable.'));
  }
  if (selection.data.value.fieldKind !== field.fieldKind) {
    issues.push(issue(
      ['value', 'fieldKind'],
      'Configuration value kind must match the selected field.',
    ));
    return { success: false, issues };
  }
  const value = selection.data.value;
  if (
    field.fieldKind === 'single_select'
    && value.fieldKind === 'single_select'
    && !field.options.some((option) => option.optionId === value.optionId)
  ) {
    issues.push(issue(
      ['value', 'optionId'],
      'Configuration selection must reference an offered option.',
    ));
  }
  if (
    field.fieldKind === 'bounded_integer'
    && value.fieldKind === 'bounded_integer'
    && (value.value < field.minimum || value.value > field.maximum)
  ) {
    issues.push(issue(
      ['value', 'value'],
      'Configuration integer is outside the field bounds.',
    ));
  }
  if (
    field.fieldKind === 'bounded_text'
    && value.fieldKind === 'bounded_text'
    && value.value.length > field.maxLength
  ) {
    issues.push(issue(
      ['value', 'value'],
      'Configuration text exceeds the field maximum length.',
    ));
  }
  return issues.length === 0
    ? selection
    : { success: false, issues };
}

export function parseAgentConfigurationSelectionFor(
  catalogInput: unknown,
  selectionInput: unknown,
): AgentConfigurationSelectionInput {
  const parsed = safeParseAgentConfigurationSelectionFor(
    catalogInput,
    selectionInput,
  );
  if (parsed.success) return parsed.data;
  throw new AgentProtocolValidationError(parsed.issues);
}
