// ------------------------------------------------------------------------------------------------
//                contentReferenceText.ts - Canonical skill input text constraints
// ------------------------------------------------------------------------------------------------

import type { AgentContentReferenceTextFormat, AgentContentReferenceTextFormats } from './types.js';

export interface AgentContentReferenceTextIssue {
  readonly target: 'prompt' | 'arguments';
  readonly format: Exclude<AgentContentReferenceTextFormat, 'unrestricted'>;
}

export function isAgentContentReferenceTextAllowed(
  text: string,
  format: AgentContentReferenceTextFormat,
): boolean {
  if (format === 'unrestricted') return true;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return false;
  return format !== 'literal_single_line' || (!/[$@`]/u.test(text) && !text.trimStart().startsWith('/'));
}

export function meetAgentContentReferenceTextFormat(
  left: AgentContentReferenceTextFormat,
  right: AgentContentReferenceTextFormat,
): AgentContentReferenceTextFormat {
  if (left === 'literal_single_line' || right === 'literal_single_line') return 'literal_single_line';
  if (left === 'single_line' || right === 'single_line') return 'single_line';
  return 'unrestricted';
}

export function findAgentContentReferenceTextIssue(input: {
  readonly prompt: string;
  readonly arguments: readonly string[];
  readonly textFormats: AgentContentReferenceTextFormats;
}): AgentContentReferenceTextIssue | null {
  const { prompt, arguments: argumentFormat } = input.textFormats;
  if (prompt !== 'unrestricted' && !isAgentContentReferenceTextAllowed(input.prompt, prompt)) {
    return { target: 'prompt', format: prompt };
  }
  if (argumentFormat !== 'unrestricted'
    && input.arguments.some((value) => !isAgentContentReferenceTextAllowed(value, argumentFormat))) {
    return { target: 'arguments', format: argumentFormat };
  }
  return null;
}
