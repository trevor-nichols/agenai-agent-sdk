import { z } from 'zod/v4';
import type { AgentHistoryDriver, AgentHistoryMutationDriverContext, AgentHistoryMutationEffects,
  AgentHistoryMutationInput, AgentHistoryMutationResult } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { OpenCodeHistoryClient, OpenCodeSessionUpdateInput } from './contracts.js';
import { openCodeID, openCodeRequester, parseOpenCodeNative } from './native.js';
import type { ResolvedOpenCodeHistoryOptions } from './options.js';
import { readOpenCodeSession } from './session.js';

const activeSessions = z.record(openCodeID, z.object({ type: z.literal('running') }));
function effects(descendants: 'none' | 'descendants'): AgentHistoryMutationEffects {
  return { scope: 'provider_managed', descendants, active: 'requires_quiescent', atomicity: 'unknown' };
}

export function openCodeMutations(client: OpenCodeHistoryClient, options: ResolvedOpenCodeHistoryOptions): Pick<AgentHistoryDriver, 'rename' | 'archive' | 'restore' | 'delete'> {
  const apply = async (input: AgentHistoryMutationInput, context: AgentHistoryMutationDriverContext,
    update?: OpenCodeSessionUpdateInput): Promise<AgentHistoryMutationResult> => {
    const requester = openCodeRequester(client, { signal: context.signal, markDispatched: () => {} });
    const id = input.conversation.conversationId;
    await readOpenCodeSession(requester, options, id);
    const active = parseOpenCodeNative(activeSessions, await requester.active());
    if (active[id] !== undefined) throw new AgentHistoryError('unsupported_scope', 'OpenCode saved-session management requires an observed inactive root session.');
    if (update === undefined) await client.remove(id, context.signal, context.markDispatched);
    else await client.update(update, context.signal, context.markDispatched);
    const receipt: AgentHistoryMutationResult = { status: 'applied', ref: input.conversation };
    context.recordReceipt(receipt);
    return receipt;
  };
  return {
    rename: { status: 'supported', descriptor: { effects: effects('none') },
      apply: (input, context) => apply(input, context, { sessionID: input.conversation.conversationId, title: input.title }) },
    archive: { status: 'supported', descriptor: { effects: effects('none') },
      apply: (input, context) => apply(input, context, { sessionID: input.conversation.conversationId, archived: true }) },
    restore: { status: 'supported', descriptor: { effects: effects('none') },
      apply: (input, context) => apply(input, context, { sessionID: input.conversation.conversationId, archived: false }) },
    delete: { status: 'supported', descriptor: { effects: effects('descendants') },
      apply: (input, context) => apply(input, context) },
  };
}
