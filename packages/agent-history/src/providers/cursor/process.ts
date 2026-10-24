import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { AgentHistoryMutationDriverContext } from '../../contracts/index.js';
import { HistoryJsonWorkerOwner } from '../process/json-worker.js';
import type { CursorHistoryResourcePolicy } from './contracts.js';
import { parseCursorWorkerRequest, parseCursorWorkerResponse, type CursorWorkerRequest, type CursorWorkerResponse } from './worker/protocol.js';

export class CursorWorkerOwner {
  private constructor(private readonly owner: HistoryJsonWorkerOwner) {}

  static async create(resources: CursorHistoryResourcePolicy): Promise<CursorWorkerOwner> {
    return new CursorWorkerOwner(await HistoryJsonWorkerOwner.create(resources,
      new URL('./worker/main.js', import.meta.url), 'agenai-cursor-history-'));
  }

  async run(raw: CursorWorkerRequest, signal: AbortSignal): Promise<CursorWorkerResponse> {
    signal.throwIfAborted();
    const request = parseCursorWorkerRequest(raw);
    return parseCursorWorkerResponse(await this.owner.run(JSON.stringify(request), signal));
  }

  async mutate(raw: CursorWorkerRequest, context: AgentHistoryMutationDriverContext): Promise<CursorWorkerResponse> {
    const request = parseCursorWorkerRequest(raw);
    const value = await this.owner.mutate(JSON.stringify(request), context.signal, {
      dispatch: context.markDispatched,
      receipt: (frame, dispatched) => {
        const response = parseCursorWorkerResponse(frame);
        if (response.kind === 'error') throw new AgentHistoryError(response.code, response.message);
        if (response.kind !== 'mutation' || (!dispatched && response.result.status !== 'not_applied')) {
          throw new AgentHistoryError('native_failure', 'Invalid Cursor mutation receipt.');
        }
        context.recordReceipt(response.result);
      },
    });
    return parseCursorWorkerResponse(value);
  }

  dispose(): Promise<void> { return this.owner.dispose(); }
}
