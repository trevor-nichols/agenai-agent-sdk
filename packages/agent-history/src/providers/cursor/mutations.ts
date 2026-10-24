import type { AgentHistoryMutationDescriptor, AgentHistoryMutationResult, AgentHistorySource } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { HistoryWorkerChannel } from '../process/worker-channel.js';
import { parseCursorNative, runDocument, type CursorHistorySdk } from './native.js';
import { scopedCursorAgent } from './session.js';
import type { CursorWorkerRequest } from './worker/protocol.js';

export const CURSOR_ARCHIVE_DESCRIPTOR: AgentHistoryMutationDescriptor = { effects: {
  scope: 'local', descendants: 'none', active: 'requires_quiescent', atomicity: 'non_atomic',
} };
export const CURSOR_DELETE_DESCRIPTOR: AgentHistoryMutationDescriptor = { effects: {
  scope: 'local', descendants: 'none', active: 'native_rejects', atomicity: 'non_atomic',
} };

export async function mutateCursorAgent(sdk: CursorHistorySdk, source: AgentHistorySource,
  operation: Extract<CursorWorkerRequest['operation'], { kind: 'archive' | 'restore' | 'delete' }>,
  channel: HistoryWorkerChannel): Promise<AgentHistoryMutationResult> {
  const ref = operation.input.conversation;
  const agent = await scopedCursorAgent(sdk, source, ref.conversationId);
  if (agent.status === 'running') throw new AgentHistoryError('unsupported_scope', 'The Cursor agent is active; saved-session mutation requires a settled agent.');
  if (agent.activeRunId != null) {
    const raw = await sdk.runDocument(ref.conversationId, agent.activeRunId);
    if (raw !== null) {
      const run = parseCursorNative(runDocument, raw);
      if (run.status === 'queued' || run.status === 'running') throw new AgentHistoryError('unsupported_scope', 'The Cursor agent has a nonterminal active run.');
    }
  }
  await channel.permitMutation();
  try {
    if (operation.kind === 'archive') await sdk.archiveAgent(ref.conversationId);
    else if (operation.kind === 'restore') await sdk.restoreAgent(ref.conversationId);
    else await sdk.deleteAgent(ref.conversationId);
    return { status: 'applied', ref };
  } catch {
    return { status: 'outcome_unknown', ref,
      reason: { code: 'native_failure', message: 'The Cursor mutation was dispatched and may have been partially applied.' } };
  }
}
