import type { AgentHistoryMutationDriverContext, AgentHistoryMutationInput, AgentHistoryRenameInput,
  AgentHistoryMutationEffects, AgentHistoryMutationResult, AgentHistorySource } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { GrokHistoryAccess, GrokManagementAccess } from './contracts.js';
import { GrokMutationReceiptSchema, GrokRenameParamsSchema, parseGrokNative } from './native.js';
import { grokRequest } from './request.js';
import { assertGrokRef, grokProject, grokState } from './session.js';

export const GROK_LOCAL_EFFECTS: AgentHistoryMutationEffects = Object.freeze({ scope: 'local', descendants: 'none',
  active: 'requires_quiescent', atomicity: 'unknown' });

export async function mutateGrokSession(operation: 'rename' | 'delete', access: GrokHistoryAccess, management: GrokManagementAccess,
  source: AgentHistorySource, input: AgentHistoryMutationInput | AgentHistoryRenameInput, context: AgentHistoryMutationDriverContext,
  timeoutMs: number): Promise<AgentHistoryMutationResult> {
  assertGrokRef(input.conversation);
  const params = { sessionId: input.conversation.conversationId, cwd: grokProject(source), kind: 'build' as const };
  const rename = operation === 'rename' && 'title' in input ? GrokRenameParamsSchema.safeParse({ ...params, title: input.title }) : undefined;
  if (operation === 'rename' && !rename?.success) throw new AgentHistoryError('invalid_input', 'Grok rename requires clean canonical text of at most 100 Unicode scalars and 464 UTF-8 bytes.');
  // Scope and existence are checked in a separate read-only process before any writable mount can exist.
  try { await access.run((connection) => grokState(connection, source, params.sessionId, context.signal, timeoutMs), context.signal); }
  catch (error) { if (!(operation === 'delete' && error instanceof AgentHistoryError && error.code === 'not_found')) throw error; }
  return management.mutate(async (connection) => {
    context.markDispatched();
    const response = await grokRequest(() => operation === 'rename' && rename?.success
      ? connection.sessionRename(rename.data, { signal: context.signal, timeoutMs })
      : connection.sessionDelete(params, { signal: context.signal, timeoutMs }), context.signal);
    parseGrokNative(GrokMutationReceiptSchema, response);
    const result = { status: 'applied' as const, ref: input.conversation };
    context.recordReceipt(result);
    return result;
  }, context.signal);
}
