import { z } from 'zod/v4';
import type { AgentHistoryDriver, AgentHistoryMutationDriverContext, AgentHistoryMutationEffects,
  AgentHistoryMutationInput, AgentHistoryMutationResult, AgentHistorySource } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { CodexHistoryAccess, CodexHistoryRequest } from './contracts.js';
import { codexId, codexRequester, parseCodexNative } from './native.js';
import { readCodexThread } from './session.js';

type MutationRequest = Extract<CodexHistoryRequest, { method: 'thread/name/set' | 'thread/archive' | 'thread/unarchive' | 'thread/delete' }>;
const emptyReceipt = z.strictObject({});
const restoreReceipt = z.object({ thread: z.object({ id: codexId }) });
function effects(descendants: 'none' | 'descendants'): AgentHistoryMutationEffects {
  return { scope: 'local', descendants, active: 'requires_quiescent', atomicity: 'unknown' };
}

export function codexMutations(source: AgentHistorySource, access: CodexHistoryAccess): Pick<AgentHistoryDriver, 'rename' | 'archive' | 'restore' | 'delete'> {
  const apply = (input: AgentHistoryMutationInput, context: AgentHistoryMutationDriverContext, request: MutationRequest): Promise<AgentHistoryMutationResult> =>
    access.run(async (connection) => {
      const thread = await readCodexThread(codexRequester(connection, { signal: context.signal, markDispatched: () => {} }),
        source, input.conversation.conversationId);
      if (thread.status?.type !== 'notLoaded' && thread.status?.type !== 'idle') {
        throw new AgentHistoryError('unsupported_scope', 'Codex saved-thread management requires observed quiescent native state.');
      }
      const receipt: AgentHistoryMutationResult = { status: 'applied', ref: input.conversation };
      await codexRequester(connection, context).call(request, (value) => {
        if (request.method === 'thread/unarchive') {
          if (parseCodexNative(restoreReceipt, value).thread.id !== input.conversation.conversationId) {
            throw new AgentHistoryError('native_failure', 'Codex returned a restore receipt for another thread.');
          }
        } else parseCodexNative(emptyReceipt, value);
        context.recordReceipt(receipt);
      });
      return receipt;
    }, context.signal);
  return {
    rename: { status: 'supported', descriptor: { effects: effects('none') },
      apply: (input, context) => apply(input, context, { method: 'thread/name/set', params: { threadId: input.conversation.conversationId, name: input.title } }) },
    archive: { status: 'supported', descriptor: { effects: effects('descendants') },
      apply: (input, context) => apply(input, context, { method: 'thread/archive', params: { threadId: input.conversation.conversationId } }) },
    restore: { status: 'supported', descriptor: { effects: effects('none') },
      apply: (input, context) => apply(input, context, { method: 'thread/unarchive', params: { threadId: input.conversation.conversationId } }) },
    delete: { status: 'supported', descriptor: { effects: effects('descendants') },
      apply: (input, context) => apply(input, context, { method: 'thread/delete', params: { threadId: input.conversation.conversationId } }) },
  };
}
