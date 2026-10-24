import type { AgentHistoryMutationDriverContext } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { HistoryJsonWorkerOwner } from '../process/json-worker.js';
import type { ClaudeHistoryResourcePolicy } from './options.js';
import {
  parseClaudeWorkerRequest, parseClaudeWorkerResponse, type ClaudeWorkerRequest, type ClaudeWorkerResponse,
} from './worker/protocol.js';

export class ClaudeWorkerOwner {
  private constructor(private readonly owner: HistoryJsonWorkerOwner) {}

  static async create(resources: ClaudeHistoryResourcePolicy): Promise<ClaudeWorkerOwner> {
    return new ClaudeWorkerOwner(await HistoryJsonWorkerOwner.create(resources,
      new URL('./worker/main.js', import.meta.url), 'agenai-claude-history-'));
  }

  async run(raw: ClaudeWorkerRequest, signal: AbortSignal): Promise<ClaudeWorkerResponse> {
    signal.throwIfAborted();
    const request = parseClaudeWorkerRequest(raw);
    const result = await this.owner.run(JSON.stringify(request), signal, { CLAUDE_CONFIG_DIR: request.configHome });
    try { return parseClaudeWorkerResponse(result); }
    catch { throw new AgentHistoryError('native_failure', 'Claude history worker returned an invalid response.'); }
  }

  async mutate(raw: ClaudeWorkerRequest, context: AgentHistoryMutationDriverContext): Promise<ClaudeWorkerResponse> {
    const request = parseClaudeWorkerRequest(raw);
    const value = await this.owner.mutate(JSON.stringify(request), context.signal, {
      dispatch: context.markDispatched,
      receipt: (frame, dispatched) => {
        const response = parseClaudeWorkerResponse(frame);
        if (response.kind === 'error') throw new AgentHistoryError(response.code, response.message);
        if (response.kind !== 'mutation' || (!dispatched && response.result.status !== 'not_applied')) {
          throw new AgentHistoryError('native_failure', 'Invalid Claude mutation receipt.');
        }
        context.recordReceipt(response.result);
      },
    }, { CLAUDE_CONFIG_DIR: request.configHome });
    return parseClaudeWorkerResponse(value);
  }

  dispose(): Promise<void> { return this.owner.dispose(); }
}
