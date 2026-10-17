import type { ValidationIssue } from '@agen-ai/validation';

import type {
  AgentElicitationAnswer,
  AgentElicitationField,
  AgentMultiSelectElicitationAnswer,
  AgentMultiSelectElicitationField,
  AgentSingleSelectElicitationAnswer,
  AgentSingleSelectElicitationField,
} from './types.js';

function issue(path: readonly (string | number)[], message: string): ValidationIssue {
  return { code: 'custom', path, message };
}

function singleSelectAnswerIssues(
  field: AgentSingleSelectElicitationField,
  answer: AgentSingleSelectElicitationAnswer,
  answerIndex: number,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedValues = new Set(field.options.map((option) => option.value));
  if (answer.value !== undefined && !allowedValues.has(answer.value)) {
    issues.push(issue(
      ['answers', answerIndex, 'value'],
      'Single-select answers must reference an option declared by the request.',
    ));
  }
  if (answer.other !== undefined && !field.allowOther) {
    issues.push(issue(
      ['answers', answerIndex, 'other'],
      'This request field does not accept a custom choice.',
    ));
  }
  return issues;
}

function multiSelectAnswerIssues(
  field: AgentMultiSelectElicitationField,
  answer: AgentMultiSelectElicitationAnswer,
  answerIndex: number,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedValues = new Set(field.options.map((option) => option.value));
  if (answer.values.some((value) => !allowedValues.has(value))) {
    issues.push(issue(
      ['answers', answerIndex, 'values'],
      'Multi-select answers must reference options declared by the request.',
    ));
  }
  if (answer.other !== undefined && !field.allowOther) {
    issues.push(issue(
      ['answers', answerIndex, 'other'],
      'This request field does not accept a custom choice.',
    ));
  }
  const selectionCount = answer.values.length + (answer.other === undefined ? 0 : 1);
  if (field.required && selectionCount === 0) {
    issues.push(issue(
      ['answers', answerIndex],
      'A required multi-select answer needs a declared option or a custom choice.',
    ));
  }
  if (selectionCount > field.maxSelections) {
    issues.push(issue(
      ['answers', answerIndex],
      'This request field exceeds its maximum selection count.',
    ));
  }
  return issues;
}

function answerIssues(
  field: AgentElicitationField,
  answer: AgentElicitationAnswer,
  answerIndex: number,
): readonly ValidationIssue[] {
  if (field.kind !== answer.kind) {
    return [issue(
      ['answers', answerIndex, 'kind'],
      'Answer kind must match the corresponding request field.',
    )];
  }
  if (field.kind === 'text' && answer.kind === 'text') {
    return answer.value.length <= field.maxLength
      ? []
      : [issue(
          ['answers', answerIndex, 'value'],
          'Text answer exceeds the field maximum length.',
        )];
  }
  if (field.kind === 'single_select' && answer.kind === 'single_select') {
    return singleSelectAnswerIssues(field, answer, answerIndex);
  }
  if (field.kind === 'multi_select' && answer.kind === 'multi_select') {
    return multiSelectAnswerIssues(field, answer, answerIndex);
  }
  return [];
}

export function elicitationResponseIssues(
  fieldsInput: readonly AgentElicitationField[],
  answers: readonly AgentElicitationAnswer[],
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fields = new Map(fieldsInput.map((field) => [field.fieldId, field]));
  const answered = new Set<string>();
  answers.forEach((answer, answerIndex) => {
    if (answered.has(answer.fieldId)) {
      issues.push(issue(
        ['answers', answerIndex, 'fieldId'],
        'Each request field may be answered once.',
      ));
      return;
    }
    answered.add(answer.fieldId);
    const field = fields.get(answer.fieldId);
    if (!field) {
      issues.push(issue(
        ['answers', answerIndex, 'fieldId'],
        'Answer fieldId must reference a field declared by the request.',
      ));
      return;
    }
    issues.push(...answerIssues(field, answer, answerIndex));
  });

  for (const field of fieldsInput) {
    if (field.required && !answered.has(field.fieldId)) {
      issues.push(issue(
        ['answers'],
        `Required request field ${field.fieldId} is missing an answer.`,
      ));
    }
  }
  return issues;
}
