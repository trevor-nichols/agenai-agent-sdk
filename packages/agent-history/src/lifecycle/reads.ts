import type {
  AgentHistoryCatalogDescriptor, AgentHistoryDriver, AgentHistoryListInput, AgentHistoryPorts,
  AgentHistorySearchDescriptor, AgentHistorySource, AgentHistoryLookupInput, AgentHistoryReadInput, AgentHistorySearchInput, AgentHistoryOperationOptions,
} from '../contracts/index.js';
import {
  parseAgentHistoryCatalogDescriptor, parseAgentHistoryCatalogPage,
  parseAgentHistoryConversationSummary, parseAgentHistoryListInput,
  parseAgentHistoryLookupDescriptor, parseAgentHistoryLookupInput,
  parseAgentHistoryReadInput, parseAgentHistorySearchDescriptor,
  parseAgentHistorySearchInput, parseAgentHistorySearchPage,
  parseAgentHistoryTranscriptDescriptor, parseAgentHistoryTranscriptPage,
} from '../validation/parse.js';
import { traversal } from '../pagination/page.js';
import { createCursorCodec } from '../pagination/cursor.js';
import { assertSource, assertSummarySource, method, operationOptions, readResult, unsupported } from './boundary.js';
import { AgentHistoryError } from './errors.js';
import { enforcePageBytes, type AgentHistoryLimits } from './limits.js';
import type { HistoryOwner } from './owner.js';
import { viewPort } from './views.js';

function filters(input: AgentHistoryListInput, descriptor: AgentHistoryCatalogDescriptor | AgentHistorySearchDescriptor, source: AgentHistorySource): void {
  for (const filter of ['projectPath', 'archived', 'parent', 'sourceKinds'] as const) {
    if (input[filter] !== undefined && !descriptor.filters.includes(filter)) {
      throw new AgentHistoryError('unsupported_scope', `This history source does not support the ${filter} filter.`);
    }
  }
  if (!descriptor.orders.includes(input.order ?? 'native')) throw new AgentHistoryError('unsupported_scope', 'This history source does not support the selected order.');
  if (input.parent) assertSource(input.parent, source);
}

function nativeResponse<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new AgentHistoryError('native_failure', 'Native history returned invalid portable records.'); }
}

export function readPorts(source: AgentHistorySource, driver: AgentHistoryDriver, owner: HistoryOwner, limits: AgentHistoryLimits): Pick<AgentHistoryPorts, 'catalog' | 'lookup' | 'transcript' | 'views' | 'metadataSearch' | 'contentSearch'> {
  const codec = createCursorCodec();
  const catalog: AgentHistoryPorts['catalog'] = (() => {
    const port = driver.catalog;
    if (port.status === 'unsupported') return unsupported(port.reason);
    const descriptor = parseAgentHistoryCatalogDescriptor(port.descriptor);
    method(port.list);
    const list = port.list.bind(port);
    return Object.freeze({ status: 'supported' as const, descriptor, list: async (raw: AgentHistoryListInput, options?: AgentHistoryOperationOptions) => {
      const input = parseAgentHistoryListInput(raw);
      filters(input, descriptor, source);
      if (input.cursor !== undefined && descriptor.pagination === 'none') throw new AgentHistoryError('unsupported_scope', 'This catalog has no continuation.');
      const page = traversal(source, 'catalog', { ...input, order: input.order ?? 'native' }, limits, codec);
      return readResult(() => owner.run('read', operationOptions(options), async (context) => {
        const value = await list(page.input, context);
        const result = nativeResponse(() => {
          const parsed = parseAgentHistoryCatalogPage(value);
          for (const summary of parsed.items) assertSummarySource(summary, source);
          return parsed;
        });
        return page.page(result);
      }));
    } });
  })();

  const lookup: AgentHistoryPorts['lookup'] = (() => {
    const port = driver.lookup;
    if (port.status === 'unsupported') return unsupported(port.reason);
    const descriptor = parseAgentHistoryLookupDescriptor(port.descriptor);
    method(port.get);
    const get = port.get.bind(port);
    return Object.freeze({ status: 'supported' as const, descriptor, get: async (raw: AgentHistoryLookupInput, options?: AgentHistoryOperationOptions) => {
      const input = parseAgentHistoryLookupInput(raw);
      assertSource(input.conversation, source);
      return readResult(() => owner.run('read', operationOptions(options), async (context) => {
        const value = await get(input, context);
        const result = nativeResponse(() => {
          const summary = parseAgentHistoryConversationSummary(value);
          assertSummarySource(summary, source);
          if (summary.ref.conversationId !== input.conversation.conversationId) throw new Error('Wrong native conversation');
          return summary;
        });
        enforcePageBytes(result, limits.pageBytes);
        return result;
      }));
    } });
  })();

  const transcript: AgentHistoryPorts['transcript'] = (() => {
    const port = driver.transcript;
    if (port.status === 'unsupported') return unsupported(port.reason);
    const descriptor = parseAgentHistoryTranscriptDescriptor(port.descriptor);
    method(port.read);
    const read = port.read.bind(port);
    return Object.freeze({ status: 'supported' as const, descriptor, read: async (raw: AgentHistoryReadInput, options?: AgentHistoryOperationOptions) => {
      const input = parseAgentHistoryReadInput(raw);
      assertSource(input.conversation, source);
      const view = input.view ?? Object.freeze({ kind: 'main' as const });
      if (!descriptor.views.includes(view.kind)) throw new AgentHistoryError('unsupported_scope', 'This history source does not support the selected transcript view.');
      if (input.cursor !== undefined && descriptor.pagination === 'none') throw new AgentHistoryError('unsupported_scope', 'This transcript has no continuation.');
      const page = traversal(source, 'transcript', { ...input, view }, limits, codec);
      return readResult(() => owner.run('read', operationOptions(options), async (context) => {
        const value = await read(page.input, context);
        return page.page(nativeResponse(() => parseAgentHistoryTranscriptPage(value)));
      }));
    } });
  })();

  function searchPort(operation: 'metadataSearch' | 'contentSearch'): AgentHistoryPorts['metadataSearch'] {
    const port = driver[operation];
    if (port.status === 'unsupported') return unsupported(port.reason);
    const descriptor = parseAgentHistorySearchDescriptor(port.descriptor);
    if ((operation === 'contentSearch') !== (descriptor.scope === 'transcript')) throw new AgentHistoryError('invalid_input', 'History search scope does not match its port.');
    method(port.search);
    const search = port.search.bind(port);
    return Object.freeze({ status: 'supported' as const, descriptor, search: async (raw: AgentHistorySearchInput, options?: AgentHistoryOperationOptions) => {
      const input = parseAgentHistorySearchInput(raw);
      filters(input, descriptor, source);
      const page = traversal(source, operation, { ...input, order: input.order ?? 'native' }, limits, codec);
      return readResult(() => owner.run('read', operationOptions(options), async (context) => {
        const value = await search(page.input, context);
        const result = nativeResponse(() => {
          const parsed = parseAgentHistorySearchPage(value);
          for (const hit of parsed.items) assertSummarySource(hit.conversation, source);
          return parsed;
        });
        return page.page(result);
      }));
    } });
  }
  return { catalog, lookup, transcript, views: viewPort(source, driver.views, transcript, owner, limits, codec), metadataSearch: searchPort('metadataSearch'), contentSearch: searchPort('contentSearch') };
}
