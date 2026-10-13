import type { AcpJsonObject, AcpJsonValue, AcpReverseRequestContext } from '@agen-ai/acp-transport';
import type { AgentRequest } from '@agen-ai/agent-protocol';

import { AcpProviderSessionError } from '../errors.js';
import type { MappedPermission } from '../mapping.js';
import { nativeBytes } from '../native.js';
import { deferred, type QueueEntry } from '../queue.js';
import type { AcpFormFlow, PreparedAcpForm } from './forms.js';

export type MappedSessionRequest =
  | Readonly<{ kind: 'permission'; permission: MappedPermission; request: AgentRequest }>
  | Readonly<{ kind: 'form'; flow: AcpFormFlow; request: AgentRequest }>;

export interface PendingSessionRequest {
  readonly kind: 'permission' | 'form';
  readonly params: AcpJsonObject;
  readonly form?: PreparedAcpForm;
  readonly host?: () => Promise<AcpJsonValue>;
  readonly response: ReturnType<typeof deferred<AcpJsonValue>>;
  readonly signal: AbortSignal;
  entry: QueueEntry<unknown> | undefined;
  mapped: MappedSessionRequest | undefined;
  answered: boolean;
  readonly onAbort: () => void;
}

export function canceledRequestReply(kind: PendingSessionRequest['kind']): AcpJsonValue {
  return kind === 'permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' };
}

/** All native reverse requests share one bounded lifetime while canonical requests are offered one at a time. */
export class PendingSessionRequests {
  private readonly pending = new Set<PendingSessionRequest>();

  constructor(private readonly input: {
    readonly maxPendingRequests: number;
    readonly admit: (request: PendingSessionRequest, bytes: number) => QueueEntry<unknown>;
    readonly fail: (error: Error) => void;
  }) {}

  get size(): number { return this.pending.size; }

  admit(context: AcpReverseRequestContext, kind: PendingSessionRequest['kind'], params: AcpJsonObject, form?: PreparedAcpForm, host?: () => Promise<AcpJsonValue>): Promise<AcpJsonValue> {
    if (this.pending.size >= this.input.maxPendingRequests) {
      const error = new AcpProviderSessionError('acp_request_queue_full', 'The ACP pending request budget is exhausted.');
      this.input.fail(error);
      throw error;
    }
    const response = deferred<AcpJsonValue>();
    const request: PendingSessionRequest = {
      kind, params, ...(form === undefined ? {} : { form }), ...(host === undefined ? {} : { host }), response, signal: context.signal,
      entry: undefined, mapped: undefined, answered: false,
      onAbort: () => {
        this.cancel(request);
        this.input.fail(new AcpProviderSessionError('acp_request_revoked', 'The peer canceled a pending ACP interaction request.'));
      },
    };
    try {
      request.entry = this.input.admit(request, nativeBytes(params) * 2 + (form ? nativeBytes(form) : 0));
      this.pending.add(request);
      context.signal.addEventListener('abort', request.onAbort, { once: true });
      if (context.signal.aborted) request.onAbort();
      return response.promise;
    } catch (error) {
      this.input.fail(error instanceof Error ? error : new Error('ACP pending request admission failed.'));
      throw error;
    }
  }

  canAnswer(request: PendingSessionRequest): boolean {
    return this.pending.has(request) && !request.answered && !request.signal.aborted;
  }

  answer(request: PendingSessionRequest, result: AcpJsonValue): boolean {
    if (!this.canAnswer(request) || !this.release(request)) return false;
    request.response.resolve(result);
    return true;
  }

  reject(request: PendingSessionRequest, error: Error): void {
    if (!this.release(request)) return;
    request.response.reject(error);
  }

  private release(request: PendingSessionRequest): boolean {
    if (!this.pending.has(request) || request.answered) return false;
    request.answered = true;
    request.signal.removeEventListener('abort', request.onAbort);
    this.pending.delete(request);
    request.entry?.release();
    return true;
  }

  cancelAll(): void {
    for (const request of [...this.pending]) this.cancel(request);
  }

  private cancel(request: PendingSessionRequest): void {
    if (this.release(request)) request.response.resolve(canceledRequestReply(request.kind));
  }
}
