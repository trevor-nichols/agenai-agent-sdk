import { z } from 'zod/v4';
import type { AgentHistory, AgentHistoryUnsupportedReason } from '../../contracts/index.js';
import { createAgentHistory } from '../../lifecycle/create.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistorySource } from '../../validation/parse.js';
import { createOpenCodeClient } from './client.js';
import type { CreateOpenCodeHistoryOptions } from './contracts.js';
import { openCodeRequester } from './native.js';
import { parseOpenCodeOptions } from './options.js';
import { listOpenCodeSessions, readOpenCodeSession, searchOpenCodeSessions, summarizeOpenCodeSession } from './session.js';
import { readOpenCodeTranscript } from './transcript.js';
import { openCodeMutations } from './mutations.js';

export async function createOpenCodeHistory(input: CreateOpenCodeHistoryOptions): Promise<AgentHistory> {
  const options = parseOpenCodeOptions(input);
  const source = parseAgentHistorySource({ providerKey: 'opencode', sourceId: options.sourceId, generation: options.generation,
    kind: 'opencode-v2-server', scope: options.scope, resourceOwnership: 'borrowed',
    storageEffects: { kind: 'unknown', reason: 'The supplied server owns native storage, replication and auxiliary request effects; enabled management invokes only the selected native session operation.' } });
  const client = await createOpenCodeClient(options);
  const info = z.object({ version: z.string().min(1).max(128) }).safeParse(await client.info(AbortSignal.timeout(options.limits.deadlineMs)));
  if (!info.success) throw new AgentHistoryError('native_failure', 'OpenCode returned invalid server identity data.');
  if (info.data.version !== options.server.runtimeVersion) throw new AgentHistoryError('unsupported_scope', 'OpenCode history requires a compatible 2.1.2 server.');
  const unsupported = (code: AgentHistoryUnsupportedReason['code'], message: string) => ({ status: 'unsupported' as const,
    reason: { code, message } satisfies AgentHistoryUnsupportedReason });
  return createAgentHistory({ source, limits: options.limits, management: options.management, driver: {
    catalog: { status: 'supported', descriptor: { filters: ['projectPath', 'archived', 'parent'],
      orders: ['native', 'updated_asc', 'updated_desc'], pagination: 'cursor' },
    list: (request, context) => listOpenCodeSessions(openCodeRequester(client, context), source, options, request) },
    lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' },
      get: async (request, context) => summarizeOpenCodeSession(await readOpenCodeSession(openCodeRequester(client, context), options,
        request.conversation.conversationId), source) },
    transcript: { status: 'supported', descriptor: { views: ['main'], pagination: 'cursor' },
      read: (request, context) => readOpenCodeTranscript(openCodeRequester(client, context), options, request) },
    views: unsupported('native_unavailable', 'OpenCode has no qualified named transcript view discovery.'),
    metadataSearch: { status: 'supported', descriptor: { syntax: 'sql_like', caseSensitivity: 'insensitive', scope: 'title', ranking: 'chronological',
      filters: ['projectPath', 'archived', 'parent'], orders: ['native', 'updated_asc', 'updated_desc'] },
      search: (request, context) => searchOpenCodeSessions(openCodeRequester(client, context), source, options, request) },
    contentSearch: unsupported('native_unavailable', 'The qualified OpenCode history surface has no transcript body search.'),
    ...openCodeMutations(client, options),
  } });
}
