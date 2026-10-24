// ------------------------------------------------------------------------------------------------
//                Structural summary for CLI output without conversation text or native references
// ------------------------------------------------------------------------------------------------

import type { HistoryBrowseResult } from './browse.js';

export function summarizeHistory(result: HistoryBrowseResult) {
  return {
    source: {
      kind: result.source.kind,
      scopeKind: result.source.scope.kind,
      resourceOwnership: result.source.resourceOwnership,
      storageEffects: result.source.storageEffects.kind === 'possible'
        ? { kind: result.source.storageEffects.kind, effects: result.source.storageEffects.effects }
        : { kind: result.source.storageEffects.kind },
    },
    capabilities: Object.fromEntries(Object.entries(result.capabilities).map(([name, port]) => [name,
      port.status === 'supported' ? { status: port.status } : { status: port.status, reason: port.reason.code },
    ])),
    catalog: result.catalog.status === 'read' ? {
      status: result.catalog.status,
      traversal: result.catalog.traversal,
      pages: result.catalog.pages.map((page) => ({
        items: page.items.length, consistency: page.consistency, coverage: page.coverage,
      })),
    } : { status: result.catalog.status, reason: result.catalog.reason.code },
    selected: result.selected !== undefined,
    metadataRead: result.metadata !== undefined,
    transcript: result.transcript.status === 'read' ? {
      status: result.transcript.status,
      traversal: result.transcript.traversal,
      pages: result.transcript.pages.map((page) => ({
        recordKinds: page.items.map((record) => record.kind), consistency: page.consistency, coverage: page.coverage,
      })),
    } : { status: result.transcript.status, reason: result.transcript.status === 'unsupported'
      ? result.transcript.reason.code : result.transcript.reason },
    cleanup: 'closed',
  };
}
