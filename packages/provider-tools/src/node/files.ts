// ------------------------------------------------------------------------------------------------
//                files.ts - Structured read, write, replacement and patch over the descriptor-safe helper
// ------------------------------------------------------------------------------------------------

import type { NodeFilesystemHelperClient } from '@agen-ai/sandbox-docker/node';
import { AgentFileChangeSchema } from '@agen-ai/agent-protocol/zod';
import type { SandboxFileWriteResult, SandboxRelativePath } from '@agen-ai/sandbox';
import type {
  NodeProviderToolApprovalRequest, NodeProviderToolFileChange, NodeProviderToolRefusal, NodeProviderToolStart, NodeProviderToolStatus,
} from './contracts.js';
import type { ToolInput } from './definitions.js';
import type { ParsedToolLimits } from './options.js';
import { batchDecision, parseWorkspacePath, type FileRestrictions, type ParsedWorkspacePath } from './restrictions.js';

export type ApprovalAnswer = 'approved' | 'denied' | 'expired' | 'canceled';

export interface OperationOutcome {
  readonly status: NodeProviderToolStatus;
  readonly text: string;
  readonly refusal?: NodeProviderToolRefusal;
  readonly changes?: readonly NodeProviderToolFileChange[];
  readonly fence?: string;
}

export interface OperationContext {
  readonly client: NodeFilesystemHelperClient;
  readonly restrictions: FileRestrictions;
  readonly workspace: string;
  readonly limits: ParsedToolLimits;
  readonly editApproval: 'automatic' | 'host';
  /** Helper operations are never aborted mid-flight; aborting one would fail the shared helper channel. */
  readonly signal: AbortSignal;
  /** The call's cancellation, checked before any effect begins. */
  readonly cancellation: AbortSignal;
  started(start: NodeProviderToolStart): void;
  approve(request: NodeProviderToolApprovalRequest): Promise<ApprovalAnswer>;
}

type Change = Readonly<{ file_path: string; content: string } | { file_path: string; old_string: string; new_string: string; replace_all?: boolean | undefined }>;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fileOptions = (context: OperationContext, maxBytes?: number) => ({
  signal: context.signal, chunkBytes: 65_536, quotas: maxBytes === undefined ? {} : { maxBytes: BigInt(maxBytes) },
});

export const refused = (text: string, status: NodeProviderToolStatus = 'refused'): OperationOutcome => ({ status, text });
/** A refusal the tools decide themselves; host answers use `notApproved` and carry no category. */
export const refusedAs = (refusal: NodeProviderToolRefusal, text: string, status: NodeProviderToolStatus = 'refused'): OperationOutcome =>
  ({ status, text, refusal });
export const pathRefusal = (parsed: ParsedWorkspacePath): NodeProviderToolRefusal =>
  !parsed.ok && parsed.reason === 'the path is outside the workspace' ? 'outside_workspace' : 'invalid_input';
export const notApproved = (answer: Exclude<ApprovalAnswer, 'approved'>, action: string): OperationOutcome =>
  refused(`${action} not performed: the host ${answer === 'denied' ? 'denied it' : answer === 'expired' ? 'did not answer in time' : 'canceled it'}.`,
    answer === 'denied' ? 'denied' : answer === 'expired' ? 'expired' : 'canceled');

/** Reads one admitted regular file into memory, or returns the exact non-completed outcome kind. */
export async function readText(context: OperationContext, path: SandboxRelativePath, maxBytes: number): Promise<string | Readonly<{ refusal: string; missing?: true }>> {
  const chunks: Uint8Array[] = [];
  const result = await context.client.readFile(path, async ({ chunks: stream }) => { for await (const chunk of stream) chunks.push(chunk); },
    fileOptions(context, maxBytes));
  if (result.kind === 'missing') return { refusal: `${path} does not exist`, missing: true };
  if (result.kind === 'rejected') {
    return { refusal: result.reason === 'quota_exceeded' ? `${path} exceeds ${maxBytes} bytes`
      : `${path} is not an ordinary single-link file beneath the workspace (${result.reason})` };
  }
  if (result.kind !== 'completed') return { refusal: `${path} changed or was interrupted while it was read` };
  try { return decoder.decode(Buffer.concat(chunks)); } catch { return { refusal: `${path} is not UTF-8 text` }; }
}

export async function readFileTool(context: OperationContext, input: ToolInput<'read'>): Promise<OperationOutcome> {
  const parsed = parseWorkspacePath(input.file_path, context.workspace);
  if (!parsed.ok || parsed.path === '.') return refusedAs(pathRefusal(parsed), `Read refused: ${parsed.ok ? 'a file path is required' : parsed.reason}.`);
  const target = parsed.path;
  context.started({ kind: 'read', path: target });
  const decision = context.restrictions.read(target);
  if (decision === 'deny') return refusedAs('restricted', 'Read refused by the session file restrictions.', 'denied');
  if (decision === 'ask') {
    const answer = await context.approve({ kind: 'read', path: target });
    if (answer !== 'approved') return notApproved(answer, 'Read');
  }
  const text = await readText(context, target, context.limits.fileBytes);
  return typeof text === 'string' ? { status: 'completed', text } : refused(`Read failed: ${text.refusal}.`, 'failed');
}

const oversized = (path: string, maxBytes: number) => `${path}: the new content exceeds ${maxBytes} bytes`;

function replace(text: string, change: Extract<Change, { old_string: string }>, path: string, maxBytes: number): string | Readonly<{ refusal: string }> {
  let count = 0;
  for (let index = text.indexOf(change.old_string); index !== -1; index = text.indexOf(change.old_string, index + change.old_string.length)) count += 1;
  if (count === 0) return { refusal: `${path}: old_string was not found` };
  if (count > 1 && change.replace_all !== true) return { refusal: `${path}: old_string occurs ${count} times; set replace_all or add context` };
  let bytes = 0;
  let trailing = '';
  const fits = (part: string) => {
    let segment = trailing + part;
    trailing = '';
    // A replacement boundary can split or join a surrogate pair. Count the trailing high surrogate only once its successor is known.
    const last = segment.charCodeAt(segment.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) { trailing = segment.slice(-1); segment = segment.slice(0, -1); }
    bytes += Buffer.byteLength(segment);
    return bytes <= maxBytes;
  };
  let start = 0;
  for (let index = text.indexOf(change.old_string); index !== -1; index = text.indexOf(change.old_string, start)) {
    if (!fits(text.slice(start, index)) || !fits(change.new_string)) return { refusal: oversized(path, maxBytes) };
    start = index + change.old_string.length;
  }
  if (!fits(text.slice(start)) || bytes + Buffer.byteLength(trailing) > maxBytes) return { refusal: oversized(path, maxBytes) };
  return text.replaceAll(change.old_string, () => change.new_string);
}

interface Prepared { readonly path: SandboxRelativePath; readonly mode: 'create' | 'replace'; readonly bytes: Uint8Array }

/** Checks every member before any publication, so a precondition failure leaves no partial effect. */
async function prepare(context: OperationContext, paths: readonly SandboxRelativePath[], changes: readonly Change[]): Promise<readonly Prepared[] | string> {
  const prepared: Prepared[] = [];
  for (const [index, path] of paths.entries()) {
    const change = changes[index] as Change;
    const existing = await readText(context, path, context.limits.fileBytes);
    const missing = typeof existing !== 'string' && existing.missing === true;
    if (typeof existing !== 'string' && !missing) return existing.refusal;
    let text: string;
    if ('content' in change) {
      if (Buffer.byteLength(change.content) > context.limits.fileBytes) return oversized(path, context.limits.fileBytes);
      text = change.content;
    }
    else {
      if (typeof existing !== 'string') return `${path}: cannot replace text in a missing file`;
      const next = replace(existing, change, path, context.limits.fileBytes);
      if (typeof next !== 'string') return next.refusal;
      text = next;
    }
    const bytes = new TextEncoder().encode(text);
    prepared.push({ path, mode: missing ? 'create' : 'replace', bytes });
  }
  return prepared;
}

function receiptText(path: string, receipt: SandboxFileWriteResult): string {
  if (receipt.kind === 'missing') return `${path}: not applied (its parent directory does not exist)`;
  if (receipt.kind === 'rejected') return `${path}: not applied (${receipt.reason})`;
  if (receipt.kind === 'cancelled') return `${path}: not applied (cancelled)`;
  return `${path}: publication is uncertain`;
}

/**
 * Publishes sequentially. A changed, uncertain or unknown publication keeps its known effect, stops
 * the remaining members and fences the session. Nothing is rolled back or replayed.
 */
async function publish(context: OperationContext, prepared: readonly Prepared[]): Promise<OperationOutcome> {
  const changes: NodeProviderToolFileChange[] = [];
  const lines: string[] = [];
  let fence: string | undefined;
  let attempted = 0;
  for (const item of prepared) {
    attempted += 1;
    let receipt: SandboxFileWriteResult;
    try {
      receipt = await context.client.writeFile(item.path, (async function* () { yield item.bytes; })(), { ...fileOptions(context), mode: item.mode });
    } catch {
      lines.push(`${item.path}: publication failed with the filesystem helper unavailable`);
      fence = 'publication_unknown';
      break;
    }
    const change = item.mode === 'create' ? 'created' as const : 'modified' as const;
    if (receipt.effect === 'published') {
      changes.push({ path: item.path, change });
      lines.push(`${item.path}: ${change}${receipt.kind === 'completed' ? '' : ` (${receipt.kind} publication)`}`);
      if (receipt.kind === 'completed') continue;
      fence = receipt.kind === 'changed' ? 'publication_changed' : 'publication_uncertain';
    } else {
      lines.push(receiptText(item.path, receipt));
      if (receipt.effect === 'unknown') fence = 'publication_unknown';
    }
    break;
  }
  const remaining = prepared.length - attempted;
  if (remaining > 0) lines.push(`${remaining} later change(s) were not attempted`);
  if (fence) lines.push('The session is fenced: no further tool effects will run.');
  const status = changes.length === prepared.length && !fence ? 'completed' : 'failed';
  return { status, text: lines.join('\n'), changes, ...(fence ? { fence } : {}) };
}

export async function editFiles(context: OperationContext, changes: readonly Change[]): Promise<OperationOutcome> {
  const paths: SandboxRelativePath[] = [];
  for (const change of changes) {
    const parsed = parseWorkspacePath(change.file_path, context.workspace);
    if (!parsed.ok || parsed.path === '.') {
      return refusedAs(pathRefusal(parsed), `Edit refused: ${parsed.ok ? 'a file path is required' : parsed.reason} (${change.file_path.slice(0, 200)}).`);
    }
    if (!AgentFileChangeSchema.safeParse({ path: parsed.path, changeKind: 'unknown' }).success) {
      return refusedAs('invalid_input', 'Edit refused: the workspace-relative path cannot be represented in an Agent Protocol file change.');
    }
    paths.push(parsed.path);
  }
  if (new Set(paths).size !== paths.length) return refusedAs('invalid_input', 'Edit refused: a batch may change each file once.');
  context.started({ kind: 'edit', paths });
  const decision = batchDecision(paths.map((path) => context.restrictions.edit(path)));
  if (decision === 'deny') return refusedAs('restricted', `Edit refused by the session file restrictions: ${paths.join(', ')}.`, 'denied');
  // Read and prepare after approval so a save during the wait is included and denied reads reveal nothing.
  if (decision === 'ask' || context.editApproval === 'host') {
    const answer = await context.approve({ kind: 'edit', paths, reason: decision === 'ask' ? 'restricted' : 'host_policy' });
    if (answer !== 'approved') return notApproved(answer, 'Edit');
  }
  if (context.cancellation.aborted) return notApproved('canceled', 'Edit');
  const prepared = await prepare(context, paths, changes);
  if (typeof prepared === 'string') return refused(`Edit not applied: ${prepared}.`, 'failed');
  if (context.cancellation.aborted) return notApproved('canceled', 'Edit');
  return publish(context, prepared);
}

export const writeTool = (context: OperationContext, input: ToolInput<'write'>) => editFiles(context, [input]);
export const editTool = (context: OperationContext, input: ToolInput<'edit'>) => editFiles(context, [input]);
export const patchTool = (context: OperationContext, input: ToolInput<'patch'>) => editFiles(context, input.changes);
