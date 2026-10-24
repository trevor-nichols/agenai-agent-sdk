import type { AgentHistoryDriver, AgentHistoryMutationDriverContext, AgentHistorySource, AgentHistoryUnsupportedReason } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { CLAUDE_DELETE_DESCRIPTOR, CLAUDE_RENAME_DESCRIPTOR } from './mutations.js';
import type { ResolvedClaudeHistoryOptions } from './options.js';
import type { ClaudeWorkerOwner } from './process.js';
import type { ClaudeWorkerRequest } from './worker/protocol.js';

export function claudeDriver(source: AgentHistorySource, options: ResolvedClaudeHistoryOptions, owner: ClaudeWorkerOwner): AgentHistoryDriver {
  const unavailable = (message: string) => ({ status: 'unsupported' as const, reason: { code: 'native_unavailable', message } satisfies AgentHistoryUnsupportedReason });
  const request = async (operation: ClaudeWorkerRequest['operation'], signal: AbortSignal) => {
    const result = await owner.run({ version: 1, source, configHome: options.configHome,
      includeProgrammatic: options.includeProgrammatic, pageBytes: options.limits.pageBytes, operation }, signal);
    if (result.kind === 'error') throw new AgentHistoryError(result.code, result.message);
    return result;
  };
  const mutate = async (operation: ClaudeWorkerRequest['operation'], context: AgentHistoryMutationDriverContext) => {
    const response = await owner.mutate({ version: 1, source, configHome: options.configHome,
      includeProgrammatic: options.includeProgrammatic, pageBytes: options.limits.pageBytes, operation }, context);
    if (response.kind !== 'mutation') throw new AgentHistoryError('native_failure', 'Claude mutation receipt is unavailable.');
    return response.result;
  };
  return {
    catalog: { status: 'supported', descriptor: { filters: [], orders: ['native'], pagination: 'offset' }, list: async (input, context) => {
      const result = await request({ kind: 'catalog', input }, context.signal);
      if (result.kind !== 'catalog') throw new AgentHistoryError('native_failure', 'Claude history catalog result is unavailable.');
      return result.page;
    } },
    lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async (input, context) => {
      const result = await request({ kind: 'lookup', input }, context.signal);
      if (result.kind !== 'lookup') throw new AgentHistoryError('native_failure', 'Claude history lookup result is unavailable.');
      return result.summary;
    } },
    transcript: { status: 'supported', descriptor: { views: ['main'], pagination: 'offset' }, read: async (input, context) => {
      const result = await request({ kind: 'transcript', input }, context.signal);
      if (result.kind !== 'transcript') throw new AgentHistoryError('native_failure', 'Claude history transcript result is unavailable.');
      return result.page;
    } },
    views: unavailable('Claude subagent view discovery is not admitted by this reader.'),
    metadataSearch: unavailable('The qualified Claude helper has no metadata search operation.'),
    contentSearch: unavailable('The qualified Claude helper has no transcript content search operation.'),
    rename: { status: 'supported', descriptor: CLAUDE_RENAME_DESCRIPTOR, apply: (input, context) => mutate({ kind: 'rename', input }, context) },
    archive: unavailable('The qualified Claude helper has no archive operation.'),
    restore: unavailable('The qualified Claude helper has no restore operation.'),
    delete: { status: 'supported', descriptor: CLAUDE_DELETE_DESCRIPTOR, apply: (input, context) => mutate({ kind: 'delete', input }, context) },
    dispose: () => owner.dispose(),
  };
}
