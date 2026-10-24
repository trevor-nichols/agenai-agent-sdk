import type { AgentHistoryMutationDescriptor, AgentHistoryMutationResult, AgentHistorySource } from '../../contracts/index.js';
import type { HistoryWorkerChannel } from '../process/worker-channel.js';
import { claudeProjectOptions, lookupClaudeSession, type ClaudeHistorySdk } from './session.js';
import type { ClaudeWorkerRequest } from './worker/protocol.js';

export const CLAUDE_RENAME_DESCRIPTOR: AgentHistoryMutationDescriptor = { effects: {
  scope: 'local', descendants: 'none', active: 'requires_quiescent', atomicity: 'non_atomic',
} };
export const CLAUDE_DELETE_DESCRIPTOR: AgentHistoryMutationDescriptor = { effects: {
  scope: 'local', descendants: 'subagents', active: 'requires_quiescent', atomicity: 'non_atomic',
} };

export async function mutateClaudeSession(sdk: ClaudeHistorySdk, source: AgentHistorySource,
  operation: Extract<ClaudeWorkerRequest['operation'], { kind: 'rename' | 'delete' }>,
  channel: HistoryWorkerChannel): Promise<AgentHistoryMutationResult> {
  const ref = operation.input.conversation;
  await lookupClaudeSession(sdk, source, ref.conversationId);
  await channel.permitMutation();
  try {
    if (operation.kind === 'rename') await sdk.renameSession(ref.conversationId, operation.input.title, claudeProjectOptions(source));
    else await sdk.deleteSession(ref.conversationId, claudeProjectOptions(source));
    return { status: 'applied', ref };
  } catch {
    return { status: 'outcome_unknown', ref,
      reason: { code: 'native_failure', message: 'The Claude mutation was dispatched and its final native outcome is unknown.' } };
  }
}
