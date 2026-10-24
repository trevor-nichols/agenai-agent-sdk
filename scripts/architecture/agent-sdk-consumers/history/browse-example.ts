import assert from 'node:assert/strict';
import type { AgentHistory, AgentHistoryCoverage } from '@agen-ai/agent-history';
import { browseHistory } from './history-example/browse.js';

type ExpectedBrowse = Readonly<{ catalogCount: number }> & (
  | Readonly<{ transcript: { status: 'unsupported' } }>
  | Readonly<{ transcript: { status: 'read'; records: number; view: AgentHistoryCoverage['view'] } }>
);

export async function proveBrowseExample(history: AgentHistory, selectedId: string, expected: ExpectedBrowse) {
  const catalog = history.catalog;
  assert(catalog.status === 'supported');
  const result = await browseHistory(history, { selectConversation: (summary) => summary.ref.conversationId === selectedId,
    pageSize: 1, maxPages: 32 });
  assert(result.catalog.status === 'read');
  assert.equal(result.catalog.traversal, 'exhausted');
  assert(result.catalog.pages.length > 1);
  const catalogCount = result.catalog.pages.reduce((count, page) => count + page.items.length, 0);
  assert.equal(catalogCount, expected.catalogCount);
  assert.equal(result.selected?.ref.conversationId, selectedId);
  assert.equal(result.metadata?.ref.conversationId, history.lookup.status === 'supported' ? selectedId : undefined);
  for (const operation of ['rename', 'archive', 'restore', 'delete'] as const) {
    assert.equal(result.capabilities[operation].status, 'unsupported');
  }
  const transcript = result.transcript;
  assert.equal(transcript.status, expected.transcript.status);
  let transcriptRecords = 0;
  const coverageViews: AgentHistoryCoverage['view'][] = [];
  if (expected.transcript.status === 'read') {
    assert(transcript.status === 'read');
    assert.equal(transcript.traversal, 'exhausted');
    assert(transcript.pages.length > 1);
    for (const page of transcript.pages) {
      assert.equal(page.coverage.view, expected.transcript.view);
      transcriptRecords += page.items.length;
      if (!coverageViews.includes(page.coverage.view)) coverageViews.push(page.coverage.view);
    }
    assert.equal(transcriptRecords, expected.transcript.records);
  }
  await assert.rejects(catalog.list({ limit: 1 }), { code: 'closed' });
  return { catalogCount, transcriptStatus: transcript.status, transcriptRecords, coverageViews,
    metadataRead: result.metadata !== undefined };
}
