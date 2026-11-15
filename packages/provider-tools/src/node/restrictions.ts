// ------------------------------------------------------------------------------------------------
//                restrictions.ts - Workspace path grammar, selector matching and immutable decisions
// ------------------------------------------------------------------------------------------------

import { parseSandboxRelativePath } from '@agen-ai/sandbox';
import type { SandboxRelativePath } from '@agen-ai/sandbox';
import { compileSelector, selectorMatches, type CompiledSelector, type MatchBudget } from './selectors.js';

export type FileDecision = 'allow' | 'ask' | 'deny';
export type WorkspacePath = SandboxRelativePath | '.';

/** Repository metadata and provider configuration always ask before a structured edit. */
export const PROTECTED_EDIT_SELECTORS = Object.freeze([
  '**/.git', '**/.git/**', '**/.claude/**', '**/.opencode/**', '**/opencode.json', '**/opencode.jsonc', '**/.mcp.json',
  '**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md', '**/.env', '**/.env.*',
]);

export type ParsedWorkspacePath =
  | Readonly<{ ok: true; path: WorkspacePath }>
  | Readonly<{ ok: false; reason: 'a file path is required' | 'the path is outside the workspace' | 'the path is not a canonical workspace path' }>;

/**
 * A model path is workspace-relative, or absolute lexically beneath the workspace. `..` is refused
 * rather than resolved; links are never followed by the helper that later opens the path.
 */
export function parseWorkspacePath(input: string, workspace: string, root = false): ParsedWorkspacePath {
  let text = input;
  if (text.startsWith('/')) {
    if (text === workspace || text === `${workspace}/`) text = '.';
    else if (text.startsWith(`${workspace}/`)) text = text.slice(workspace.length + 1);
    else return { ok: false, reason: 'the path is outside the workspace' };
  }
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return root ? { ok: true, path: '.' } : { ok: false, reason: 'a file path is required' };
  try { return { ok: true, path: parseSandboxRelativePath(parts.join('/')) }; } catch {
    return { ok: false, reason: 'the path is not a canonical workspace path' };
  }
}

/** The work one decision may spend when the caller does not share a larger budget. */
const DECISION_STEPS = 1_000_000;

export interface FileRestrictions {
  /** A decision whose selectors cannot be evaluated within the budget is `deny`. */
  read(path: SandboxRelativePath, budget?: MatchBudget): FileDecision;
  edit(path: SandboxRelativePath, budget?: MatchBudget): FileDecision;
}

export function createFileRestrictions(input: Readonly<{ denyRead: readonly string[]; askRead: readonly string[];
  denyEdit: readonly string[]; askEdit: readonly string[] }>): FileRestrictions {
  const compile = (selectors: readonly string[]) => Object.freeze(selectors.map(compileSelector));
  const denyRead = compile(input.denyRead);
  const askRead = compile(input.askRead);
  const denyEdit = compile([...input.denyRead, ...input.denyEdit]);
  const askEdit = compile([...input.askRead, ...input.askEdit, ...PROTECTED_EDIT_SELECTORS]);
  const decide = (path: string, budget: MatchBudget, deny: readonly CompiledSelector[], ask: readonly CompiledSelector[]): FileDecision => {
    const matches = (rules: readonly CompiledSelector[]) => rules.some((rule) => selectorMatches(rule, path, budget) ?? true);
    if (matches(deny)) return 'deny';
    const asked = matches(ask);
    return budget.steps < 0 ? 'deny' : asked ? 'ask' : 'allow';
  };
  return Object.freeze({
    read: (path: SandboxRelativePath, budget: MatchBudget = { steps: DECISION_STEPS }) => decide(path, budget, denyRead, askRead),
    edit: (path: SandboxRelativePath, budget: MatchBudget = { steps: DECISION_STEPS }) => decide(path, budget, denyEdit, askEdit),
  });
}

/** A batch is automatic only if every member is; one denial refuses the whole batch before effects. */
export function batchDecision(decisions: readonly FileDecision[]): FileDecision {
  if (decisions.includes('deny')) return 'deny';
  return decisions.includes('ask') ? 'ask' : 'allow';
}
