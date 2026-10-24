import type { AgentHistoryDriverPorts, AgentHistoryOperationOptions, AgentHistoryPorts, AgentHistorySource, AgentHistoryViewListInput, AgentHistoryViewPage } from '../contracts/index.js';
import type { HistoryCursorCodec } from '../pagination/cursor.js';
import { traversal } from '../pagination/page.js';
import { parseAgentHistoryViewDescriptor, parseAgentHistoryViewListInput, parseAgentHistoryViewPage } from '../validation/parse.js';
import { assertSource, method, operationOptions, readResult, unsupported } from './boundary.js';
import { AgentHistoryError } from './errors.js';
import type { AgentHistoryLimits } from './limits.js';
import type { HistoryOwner } from './owner.js';

export function viewPort(source: AgentHistorySource, port: AgentHistoryDriverPorts['views'], transcript: AgentHistoryPorts['transcript'],
  owner: HistoryOwner, limits: AgentHistoryLimits, codec: HistoryCursorCodec): AgentHistoryPorts['views'] {
  if (port.status === 'unsupported') return unsupported(port.reason);
  const descriptor = parseAgentHistoryViewDescriptor(port.descriptor);
  if (transcript.status !== 'supported' || descriptor.kinds.some((kind) => !transcript.descriptor.views.includes(kind))) {
    throw new AgentHistoryError('invalid_input', 'Named view discovery requires the corresponding transcript reader.');
  }
  method(port.list);
  const list = port.list.bind(port);
  return Object.freeze({ status: 'supported' as const, descriptor,
    list: async (raw: AgentHistoryViewListInput, options?: AgentHistoryOperationOptions) => {
      const input = parseAgentHistoryViewListInput(raw);
      assertSource(input.conversation, source);
      if (!descriptor.kinds.includes(input.kind)) throw new AgentHistoryError('unsupported_scope', 'This source cannot discover the selected transcript view kind.');
      if (input.cursor !== undefined && descriptor.pagination === 'none') throw new AgentHistoryError('unsupported_scope', 'This view catalog has no continuation.');
      const page = traversal(source, 'views', input, limits, codec);
      return readResult(() => owner.run('read', operationOptions(options), async (context) => {
        const value = await list(page.input, context);
        let parsed: AgentHistoryViewPage;
        try {
          parsed = parseAgentHistoryViewPage(value);
          const ids = new Set<string>();
          for (const item of parsed.items) {
            if (item.view.kind !== input.kind || ids.has(item.view.id)) throw new Error('Invalid native view identity');
            ids.add(item.view.id);
          }
          if (parsed.coverage.view !== 'catalog') throw new Error('Invalid native view coverage');
        } catch { throw new AgentHistoryError('native_failure', 'Native history returned invalid named transcript views.'); }
        return page.page(parsed);
      }));
    },
  });
}
