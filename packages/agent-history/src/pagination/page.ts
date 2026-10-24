import type { AgentHistoryPage, AgentHistorySourceIdentity } from '../contracts/index.js';
import { AgentHistoryError } from '../lifecycle/errors.js';
import { enforcePageBytes, type AgentHistoryLimits } from '../lifecycle/limits.js';
import { queryDigest, type HistoryCursorCodec } from './cursor.js';

export function traversal<Input extends { readonly cursor?: string; readonly limit?: number }>(
  source: AgentHistorySourceIdentity,
  operation: 'catalog' | 'transcript' | 'views' | 'metadataSearch' | 'contentSearch',
  input: Input,
  limits: AgentHistoryLimits,
  codec: HistoryCursorCodec,
) {
  const { cursor, ...query } = input;
  const limit = input.limit ?? limits.pageSize;
  if (limit > limits.pageSize) throw new AgentHistoryError('limit_exhausted', 'Requested history page exceeds this source limit.');
  const scope = { source: { providerKey: source.providerKey, sourceId: source.sourceId, generation: source.generation }, operation, query: queryDigest({ ...query, limit }) };
  const nativeCursor = cursor === undefined ? undefined : codec.decode(scope, cursor);
  return {
    input: Object.freeze({ ...input, limit, cursor: nativeCursor }),
    page<Item>(page: AgentHistoryPage<Item>): AgentHistoryPage<Item> {
      if (page.items.length > limit) throw new AgentHistoryError('limit_exhausted', 'Native history returned more records than requested.');
      if (nativeCursor !== undefined && page.nextCursor === nativeCursor) {
        throw new AgentHistoryError('native_failure', 'Native history did not advance its continuation.');
      }
      const nextCursor = page.nextCursor === undefined ? undefined : codec.encode(scope, page.nextCursor);
      const result = Object.freeze({ ...page, ...(nextCursor === undefined ? {} : { nextCursor }) });
      enforcePageBytes(result, limits.pageBytes);
      return result;
    },
  };
}

export function nativePageFits(value: unknown, pageBytes: number, nextCursor?: string): boolean {
  const cursorGrowth = nextCursor === undefined ? 0 : Math.ceil(Buffer.byteLength(JSON.stringify(nextCursor)) / 3);
  return Buffer.byteLength(JSON.stringify(value)) + 2048 + cursorGrowth <= pageBytes;
}
