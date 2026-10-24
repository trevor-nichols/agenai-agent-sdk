import type { AgentHistory, AgentHistoryDriver, AgentHistoryUnsupportedReason } from '../../contracts/index.js';
import { createAgentHistory } from '../../lifecycle/create.js';
import { parseAgentHistorySource } from '../../validation/parse.js';
import type { CreateAcpHistoryOptions } from './contracts.js';
import { parseAcpHistoryOptions } from './options.js';
import { listAcpHistorySessions } from './session.js';

export function createAcpHistory(input: CreateAcpHistoryOptions): AgentHistory {
  const options = parseAcpHistoryOptions(input);
  const source = parseAgentHistorySource({ providerKey: options.providerKey, sourceId: options.sourceId, generation: options.generation,
    kind: 'acp-standard-discovery', scope: options.scope, resourceOwnership: 'borrowed',
    storageEffects: { kind: 'unknown', reason: 'The connected ACP agent owns native storage and session/list effects are provider-defined.' },
  });
  const unavailable = (message: string) => ({ status: 'unsupported' as const,
    reason: { code: 'native_unavailable', message } satisfies AgentHistoryUnsupportedReason });
  const driver: AgentHistoryDriver = {
    catalog: options.listSupported ? {
      status: 'supported', descriptor: { filters: ['projectPath'], orders: ['native'], pagination: 'cursor' },
      list: (value, context) => listAcpHistorySessions(options.connection, source, value, options.limits.pageBytes,
        options.limits.maximumDeadlineMs, context.signal),
    } : unavailable('The initialized ACP peer did not advertise session listing.'),
    lookup: unavailable('Standard ACP has no independent saved-session lookup operation.'),
    transcript: unavailable('Standard ACP has no independent saved-transcript read operation.'),
    views: unavailable('Standard ACP has no named saved-transcript view discovery operation.'),
    metadataSearch: unavailable('Standard ACP has no independent saved-session metadata search operation.'),
    contentSearch: unavailable('Standard ACP has no saved-transcript content search operation.'),
    rename: unavailable('Standard ACP has no saved-session rename operation.'),
    archive: unavailable('Standard ACP has no saved-session archive operation.'),
    restore: unavailable('Standard ACP has no saved-session restore operation.'),
    delete: { status: 'unsupported', reason: { code: 'unqualified', message: 'Optional ACP deletion requires a separately qualified native effects mapping.' } },
  };
  return createAgentHistory({ source, driver, limits: options.limits });
}
