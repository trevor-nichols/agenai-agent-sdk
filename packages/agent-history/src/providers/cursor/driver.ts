import type { AgentHistoryDriver, AgentHistoryMutationDriverContext, AgentHistorySource, AgentHistoryUnsupportedReason } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { CURSOR_ARCHIVE_DESCRIPTOR, CURSOR_DELETE_DESCRIPTOR } from './mutations.js';
import type { ResolvedCursorHistoryOptions } from './options.js';
import type { CursorWorkerOwner } from './process.js';
import type { CursorWorkerRequest } from './worker/protocol.js';

export function cursorDriver(source: AgentHistorySource, options: ResolvedCursorHistoryOptions, owner: CursorWorkerOwner): AgentHistoryDriver {
  const unavailable = (message: string) => ({ status: 'unsupported' as const,
    reason: { code: 'native_unavailable', message } satisfies AgentHistoryUnsupportedReason });
  const request = async (operation: CursorWorkerRequest['operation'], signal: AbortSignal) => {
    const result = await owner.run({ version: 1, source, store: options.store, pageBytes: options.limits.pageBytes, operation }, signal);
    if (result.kind === 'error') throw new AgentHistoryError(result.code, result.message);
    return result;
  };
  const mutate = async (operation: CursorWorkerRequest['operation'], context: AgentHistoryMutationDriverContext) => {
    const response = await owner.mutate({ version: 1, source, store: options.store, pageBytes: options.limits.pageBytes, operation }, context);
    if (response.kind !== 'mutation') throw new AgentHistoryError('native_failure', 'Cursor mutation receipt is unavailable.');
    return response.result;
  };
  return {
    catalog: { status: 'supported', descriptor: { filters: ['projectPath'], orders: ['native'], pagination: 'cursor' }, list: async (input, context) => {
      const result = await request({ kind: 'catalog', input }, context.signal);
      if (result.kind !== 'catalog') throw new AgentHistoryError('native_failure', 'Cursor catalog result is unavailable.');
      return result.page;
    } },
    lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async (input, context) => {
      const result = await request({ kind: 'lookup', input }, context.signal);
      if (result.kind !== 'lookup') throw new AgentHistoryError('native_failure', 'Cursor lookup result is unavailable.');
      return result.summary;
    } },
    views: { status: 'supported', descriptor: { kinds: ['run'], pagination: 'cursor' }, list: async (input, context) => {
      const result = await request({ kind: 'views', input }, context.signal);
      if (result.kind !== 'views') throw new AgentHistoryError('native_failure', 'Cursor run view catalog is unavailable.');
      return result.page;
    } },
    transcript: { status: 'supported', descriptor: { views: ['main', 'run'], pagination: 'offset' }, read: async (input, context) => {
      const result = await request({ kind: 'transcript', input }, context.signal);
      if (result.kind !== 'transcript') throw new AgentHistoryError('native_failure', 'Cursor transcript result is unavailable.');
      return result.page;
    } },
    metadataSearch: unavailable('The qualified Cursor local SDK has no title or metadata search operation.'),
    contentSearch: unavailable('The qualified Cursor local SDK has no transcript content search operation.'),
    rename: unavailable('The qualified Cursor Agent API has no saved-agent rename operation.'),
    archive: { status: 'supported', descriptor: CURSOR_ARCHIVE_DESCRIPTOR, apply: (input, context) => mutate({ kind: 'archive', input }, context) },
    restore: { status: 'supported', descriptor: CURSOR_ARCHIVE_DESCRIPTOR, apply: (input, context) => mutate({ kind: 'restore', input }, context) },
    delete: { status: 'supported', descriptor: CURSOR_DELETE_DESCRIPTOR, apply: (input, context) => mutate({ kind: 'delete', input }, context) },
    dispose: () => owner.dispose(),
  };
}
