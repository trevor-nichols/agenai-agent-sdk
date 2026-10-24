// ------------------------------------------------------------------------------------------------
//                Browse an explicitly constructed history source through public ports
// ------------------------------------------------------------------------------------------------

import type {
  AgentHistory,
  AgentHistoryCatalogPage,
  AgentHistoryConversationSummary,
  AgentHistoryOperationOptions,
  AgentHistoryPage,
  AgentHistoryPort,
  AgentHistoryTranscriptPage,
  AgentHistoryUnsupportedReason,
} from '@agen-ai/agent-history';

type PortObservation<Descriptor> =
  | Readonly<{ status: 'supported'; descriptor: Descriptor }>
  | Readonly<{ status: 'unsupported'; reason: AgentHistoryUnsupportedReason }>;

type DescriptorOf<Port> = Port extends Readonly<{ status: 'supported'; descriptor: infer Descriptor }>
  ? Descriptor : never;

export type HistoryCapabilities = {
  readonly [Name in Exclude<keyof AgentHistory, 'source' | 'close'>]: PortObservation<DescriptorOf<AgentHistory[Name]>>;
};

export interface HistoryTraversal<Page> {
  readonly status: 'read';
  readonly pages: readonly Page[];
  readonly traversal: 'exhausted' | 'page_limit';
}

type UnsupportedOperation = Readonly<{ status: 'unsupported'; reason: AgentHistoryUnsupportedReason }>;

export interface HistoryBrowseResult {
  readonly source: AgentHistory['source'];
  readonly capabilities: HistoryCapabilities;
  readonly catalog: HistoryTraversal<AgentHistoryCatalogPage> | UnsupportedOperation;
  readonly selected?: AgentHistoryConversationSummary;
  readonly metadata?: AgentHistoryConversationSummary;
  readonly transcript: HistoryTraversal<AgentHistoryTranscriptPage> | UnsupportedOperation
    | Readonly<{ status: 'skipped'; reason: 'no_selection' | 'main_view_unavailable' }>;
}

export interface HistoryBrowseOptions {
  readonly selectConversation: (conversation: AgentHistoryConversationSummary) => boolean;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly operationOptions?: AgentHistoryOperationOptions;
}

function observe<Descriptor, Methods>(port: AgentHistoryPort<Descriptor, Methods>): PortObservation<Descriptor> {
  return port.status === 'supported'
    ? { status: 'supported', descriptor: port.descriptor }
    : { status: 'unsupported', reason: port.reason };
}

async function collectPages<Page extends AgentHistoryPage<unknown>>(
  read: (cursor?: string) => Promise<Page>,
  maxPages: number,
): Promise<HistoryTraversal<Page>> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < maxPages; index += 1) {
    const page = await read(cursor);
    pages.push(page);
    cursor = page.nextCursor;
    if (cursor === undefined) return { status: 'read', pages, traversal: 'exhausted' };
  }
  return { status: 'read', pages, traversal: 'page_limit' };
}

/** Takes ownership of closing this source, including when selection or reading fails. */
export async function browseHistory(history: AgentHistory, options: HistoryBrowseOptions): Promise<HistoryBrowseResult> {
  try {
    const pageSize = options.pageSize ?? 1;
    const maxPages = options.maxPages ?? 32;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
      || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new RangeError('History browsing requires pageSize and maxPages integers from 1 to 100.');
    }
    const capabilities: HistoryCapabilities = {
      catalog: observe(history.catalog),
      lookup: observe(history.lookup),
      transcript: observe(history.transcript),
      views: observe(history.views),
      metadataSearch: observe(history.metadataSearch),
      contentSearch: observe(history.contentSearch),
      rename: observe(history.rename),
      archive: observe(history.archive),
      restore: observe(history.restore),
      delete: observe(history.delete),
    };
    const unreadTranscript: HistoryBrowseResult['transcript'] = history.transcript.status === 'unsupported'
      ? { status: 'unsupported', reason: history.transcript.reason }
      : { status: 'skipped', reason: 'no_selection' };
    if (history.catalog.status === 'unsupported') return {
      source: history.source, capabilities,
      catalog: { status: 'unsupported', reason: history.catalog.reason },
      transcript: unreadTranscript,
    };

    const catalogPort = history.catalog;
    const catalog = await collectPages((cursor) => catalogPort.list({
      limit: pageSize,
      ...(cursor === undefined ? {} : { cursor }),
    }, options.operationOptions), maxPages);
    const selected = catalog.pages.flatMap((page) => page.items).find(options.selectConversation);
    if (!selected) return { source: history.source, capabilities, catalog, transcript: unreadTranscript };

    const metadata = history.lookup.status === 'supported'
      ? await history.lookup.get({ conversation: selected.ref }, options.operationOptions) : undefined;
    const transcriptPort = history.transcript;
    const transcript: HistoryBrowseResult['transcript'] = transcriptPort.status === 'unsupported'
      ? { status: 'unsupported', reason: transcriptPort.reason }
      : transcriptPort.descriptor.views.includes('main')
      ? await collectPages((cursor) => transcriptPort.read({
        conversation: selected.ref,
        view: { kind: 'main' },
        limit: pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      }, options.operationOptions), maxPages)
      : { status: 'skipped', reason: 'main_view_unavailable' };

    // Keep every native coverage observation and item. Exhaustion describes only the selected view.
    return {
      source: history.source, capabilities, catalog, selected, transcript,
      ...(metadata === undefined ? {} : { metadata }),
    };
  } finally {
    // A cleanup error retains retryCleanup(); let it reach the caller with that responsibility intact.
    await history.close();
  }
}
