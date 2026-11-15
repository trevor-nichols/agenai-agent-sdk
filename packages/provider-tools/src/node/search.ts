// ------------------------------------------------------------------------------------------------
//                search.ts - Bounded glob and fixed-string search with per-entry read decisions
// ------------------------------------------------------------------------------------------------

import { parseSandboxRelativePath, type SandboxRelativePath } from '@agen-ai/sandbox';
import type { ToolInput } from './definitions.js';
import { pathRefusal, readText, refused, refusedAs, type OperationContext, type OperationOutcome } from './files.js';
import { FIXED_TOOL_LIMITS } from './options.js';
import { parseWorkspacePath, type WorkspacePath } from './restrictions.js';
import { compileSelector, selectorMatches, type MatchBudget } from './selectors.js';

const MAX_DEPTH = 64;
const LINE_CHARACTERS = 400;
/** Selector and pattern matching work for one search call, restriction decisions included. */
const MATCH_STEPS = 32_000_000;

interface Walk {
  readonly files: readonly Readonly<{ path: SandboxRelativePath; byteLength: number }>[];
  readonly withheld: number;
  readonly skipped: number;
  readonly truncated: boolean;
}

/** Breadth-first listing that never follows links; restricted files are withheld rather than escalated. */
async function walk(context: OperationContext, root: WorkspacePath, work: MatchBudget): Promise<Walk | string> {
  const files: { path: SandboxRelativePath; byteLength: number }[] = [];
  const queue: { path: WorkspacePath; depth: number }[] = [{ path: root, depth: 0 }];
  let budget = context.limits.searchEntries;
  let withheld = 0;
  let skipped = 0;
  let truncated = false;
  while (queue.length > 0 && !truncated) {
    const { path, depth } = queue.shift()!;
    const children: { path: SandboxRelativePath; kind: string; byteLength: number }[] = [];
    const listing = await context.client.list(path, async (entry) => {
      children.push({ path: parseSandboxRelativePath(entry.path), kind: entry.kind, byteLength: entry.byteLength });
    }, { signal: context.signal, chunkBytes: 65_536, quotas: { maxEntries: BigInt(budget + 1) } });
    if (listing.kind !== 'completed' && !(listing.kind === 'rejected' && listing.reason === 'quota_exceeded')) {
      if (path === root) return `the search path is not a listable directory (${listing.kind})`;
      skipped += 1;
      continue;
    }
    for (const child of children) {
      if (budget === 0) { truncated = true; break; }
      budget -= 1;
      if (child.kind === 'directory') { if (depth < MAX_DEPTH) queue.push({ path: child.path, depth: depth + 1 }); else skipped += 1; continue; }
      if (child.kind !== 'file') { skipped += 1; continue; }
      const decision = context.restrictions.read(child.path, work);
      if (work.steps < 0) { truncated = true; break; }
      if (decision !== 'allow') withheld += 1;
      else files.push({ path: child.path, byteLength: child.byteLength });
    }
    if (listing.kind === 'rejected') truncated = true;
  }
  return { files, withheld, skipped, truncated };
}

interface ContentCoverage { bytes: number; oversized: number; budgetSkipped: number; unreadable: number }

function annotations(walked: Walk, exhausted: boolean, truncated: boolean, content: ContentCoverage): string[] {
  const output: string[] = [];
  if (walked.withheld) output.push(`[${walked.withheld} restricted file(s) withheld]`);
  if (walked.skipped) output.push(`[${walked.skipped} link, special or unlistable entries not followed]`);
  if (content.oversized) output.push(`[${content.oversized} file(s) exceed the file byte limit]`);
  if (content.budgetSkipped) output.push(`[${content.budgetSkipped} file(s) skipped at the search byte limit]`);
  if (content.unreadable) output.push(`[${content.unreadable} file(s) could not be read as UTF-8 text]`);
  if (exhausted) output.push('[pattern matching stopped at its work bound]');
  if (walked.truncated || truncated) output.push('[results truncated at their bound]');
  return output;
}

type Matcher = (file: Walk['files'][number], relative: string, consumed: ContentCoverage) => AsyncIterable<string>;

async function search(context: OperationContext, input: Readonly<{ path?: string | undefined; pattern: string }>, work: MatchBudget,
  match: Matcher): Promise<OperationOutcome> {
  const root = parseWorkspacePath(input.path ?? '.', context.workspace, true);
  if (!root.ok) return refusedAs(pathRefusal(root), `Search refused: ${root.reason}.`);
  context.started({ kind: 'search', path: root.path, pattern: input.pattern });
  if (root.path !== '.' && context.restrictions.read(root.path) === 'deny') return refusedAs('restricted', 'Search refused by the session file restrictions.', 'denied');
  const walked = await walk(context, root.path, work);
  if (typeof walked === 'string') return refused(`Search failed: ${walked}.`, 'failed');
  const lines: string[] = [];
  const consumed: ContentCoverage = { bytes: 0, oversized: 0, budgetSkipped: 0, unreadable: 0 };
  // Reserve every possible annotation before retaining matches, including a truncation notice.
  const budget = FIXED_TOOL_LIMITS.resultBytes - Buffer.byteLength(annotations(walked, true, true,
    { bytes: 0, oversized: walked.files.length, budgetSkipped: walked.files.length, unreadable: walked.files.length }).join('\n')) - 1;
  let bytes = 0;
  let truncated = false;
  files: for (const file of walked.files) {
    if (work.steps < 0) break;
    for await (const line of match(file, root.path === '.' ? file.path : file.path.slice(root.path.length + 1), consumed)) {
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > budget) { truncated = true; break files; }
      bytes += size;
      lines.push(line);
    }
  }
  return { status: 'completed', text: [...(lines.length ? lines : ['No matches.']), ...annotations(walked, work.steps < 0, truncated, consumed)].join('\n') };
}

/** Matches the whole relative path, or only its last segment when the pattern names no directory. */
function pathMatcher(pattern: string, work: MatchBudget): (relative: string) => boolean {
  const selector = compileSelector(pattern);
  const basename = !pattern.includes('/');
  return (relative) => selectorMatches(selector, relative, work) === true
    || (basename && work.steps >= 0 && selectorMatches(selector, relative.split('/').at(-1) ?? '', work) === true);
}

export function globTool(context: OperationContext, input: ToolInput<'glob'>): Promise<OperationOutcome> {
  const work = { steps: MATCH_STEPS };
  const matches = pathMatcher(input.pattern, work);
  return search(context, input, work, async function* (file, relative) { if (matches(relative)) yield file.path; });
}

export function grepTool(context: OperationContext, input: ToolInput<'grep'>): Promise<OperationOutcome> {
  const work = { steps: MATCH_STEPS };
  const only = input.glob === undefined ? undefined : pathMatcher(input.glob, work);
  return search(context, input, work, async function* (file, relative, consumed) {
    if (only && !only(relative)) return;
    if (file.byteLength > context.limits.fileBytes) { consumed.oversized += 1; return; }
    if (consumed.bytes + file.byteLength > FIXED_TOOL_LIMITS.searchBytes) { consumed.budgetSkipped += 1; return; }
    consumed.bytes += file.byteLength;
    const text = await readText(context, file.path, context.limits.fileBytes);
    if (typeof text !== 'string') { consumed.unreadable += 1; return; }
    let start = 0;
    let number = 1;
    while (start <= text.length) {
      const newline = text.indexOf('\n', start);
      const line = text.slice(start, newline === -1 ? text.length : newline);
      if (line.includes(input.pattern)) yield `${file.path}:${number}:${line.slice(0, LINE_CHARACTERS)}`;
      if (newline === -1) break;
      start = newline + 1;
      number += 1;
    }
  });
}
