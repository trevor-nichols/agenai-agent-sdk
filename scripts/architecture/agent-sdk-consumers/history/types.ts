import type { AgentHistory, AgentHistoryConversationRef, AgentHistoryRecord } from '@agen-ai/agent-history';

export function narrowHistory(history: AgentHistory, conversation: AgentHistoryConversationRef): void {
  if (history.lookup.status === 'supported') {
    void history.lookup.get({ conversation });
  } else {
    // @ts-expect-error Unsupported ports never expose a callable operation.
    void history.lookup.get({ conversation });
  }
  if (history.rename.status === 'supported') {
    void history.rename.apply({ conversation, title: 'A title', acceptEffects: history.rename.descriptor.effects });
    // @ts-expect-error A mutation requires explicit acceptance of its declared effects.
    void history.rename.apply({ conversation, title: 'A title' });
  }
  // @ts-expect-error Support must be narrowed before calling a history operation.
  void history.transcript.read({ conversation });
}

export function readMessage(record: AgentHistoryRecord): string | undefined {
  if (record.kind !== 'message') return undefined;
  // @ts-expect-error Historical records do not invent a live SDK turn ID.
  void record.turnId;
  return record.content.flatMap((part) => part.kind === 'text' ? [part.text] : []).join('');
}
