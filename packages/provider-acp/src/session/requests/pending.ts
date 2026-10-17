import { AcpRequestError, type AcpJsonObject, type AcpJsonValue, type AcpReverseRequestContext } from '@agen-ai/acp-transport';
import type { AgentRequest, AgentRequestId } from '@agen-ai/agent-protocol';

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
  readonly host?: (observeCallback: (work: Promise<void>) => void) => Promise<AcpJsonValue>;
  hostWork: Promise<void> | undefined;
  readonly response: ReturnType<typeof deferred<AcpJsonValue>>;
  readonly signal: AbortSignal;
  readonly transportSettled: Promise<void>;
  entry: QueueEntry<unknown> | undefined;
  mapped: MappedSessionRequest | undefined;
  answered: boolean;
  publishedRequestId: AgentRequestId | undefined;
  unavailable: boolean;
  readonly onAbort: () => void;
}

export function canceledRequestReply(kind: PendingSessionRequest['kind']): AcpJsonValue {
  return kind === 'permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' };
}

/** All native reverse requests share one bounded lifetime while canonical requests are offered one at a time. */
export class PendingSessionRequests {
  private readonly pending = new Set<PendingSessionRequest>();
  private readonly retained = new Set<PendingSessionRequest>();
  private retainedBytes = 0;

  constructor(private readonly input: {
    readonly maxPendingRequests: number;
    readonly maxRequestMaterialBytes: number;
    readonly admit: (request: PendingSessionRequest, bytes: number) => QueueEntry<unknown>;
    readonly fail: (error: Error) => void;
    readonly unavailable: (request: PendingSessionRequest, requestId: AgentRequestId) => void;
    readonly settled: (request: PendingSessionRequest) => void;
    readonly admitted?: (request: PendingSessionRequest) => void;
  }) {}

  get size(): number { return this.pending.size; }

  admit(context: AcpReverseRequestContext, kind: PendingSessionRequest['kind'], params: AcpJsonObject, form?: PreparedAcpForm, host?: PendingSessionRequest['host']): Promise<AcpJsonValue> {
    if (this.retained.size >= this.input.maxPendingRequests) {
      const error = new AcpProviderSessionError('acp_request_queue_full', 'The ACP pending request budget is exhausted.');
      this.input.fail(error);
      throw error;
    }
    const response = deferred<AcpJsonValue>();
    const bytes = nativeBytes(params) * 2 + (form ? nativeBytes(form) : 0);
    if (this.retainedBytes + bytes > this.input.maxRequestMaterialBytes) {
      const error = new AcpProviderSessionError('acp_session_queue_full', 'The ACP retained request material budget is exhausted.');
      this.input.fail(error);
      throw error;
    }
    const request: PendingSessionRequest = {
      kind, params, ...(form === undefined ? {} : { form }), ...(host === undefined ? {} : { host }), response, signal: context.signal,
      transportSettled: context.settled,
      entry: undefined, mapped: undefined, answered: false, publishedRequestId: undefined, unavailable: false, hostWork: undefined,
      onAbort: () => {
        const cause: unknown = context.signal.reason;
        if (cause instanceof AcpRequestError && cause.reasonCode === 'acp_reverse_request_canceled' && cause.requestId === context.id) {
          this.withdraw(request, cause);
          return;
        }
        this.input.fail(cause instanceof Error ? cause : new AcpProviderSessionError('acp_request_revoked', 'The native callback producer stopped.'));
      },
    };
    try {
      request.entry = this.input.admit(request, bytes);
      this.pending.add(request);
      this.retained.add(request);
      this.retainedBytes += bytes;
      void context.settled.then(async () => {
        await request.hostWork;
        context.signal.removeEventListener('abort', request.onAbort);
        this.retained.delete(request);
        this.retainedBytes -= bytes;
        request.entry?.release();
        this.input.settled(request);
      });
      context.signal.addEventListener('abort', request.onAbort, { once: true });
      this.input.admitted?.(request);
      if (context.signal.aborted) request.onAbort();
      return response.promise;
    } catch (error) {
      this.input.fail(error instanceof Error ? error : new Error('ACP pending request admission failed.'));
      throw error;
    }
  }

  canAnswer(request: PendingSessionRequest): boolean {
    return this.pending.has(request) && !request.answered && !request.unavailable && !request.signal.aborted;
  }

  withdraw(request: PendingSessionRequest, error: Error): void {
    if (request.unavailable) return;
    request.unavailable = true;
    if (request.publishedRequestId !== undefined && request.publishedRequestId === request.mapped?.request.requestId) {
      this.input.unavailable(request, request.publishedRequestId);
    }
    if (!request.answered) this.reject(request, error);
  }

  invokeHost(request: PendingSessionRequest): Promise<AcpJsonValue> {
    if (!request.host) throw new TypeError('The native request has no host callback.');
    const joined = deferred<void>();
    request.hostWork = joined.promise;
    let callback: Promise<void> = Promise.resolve();
    let work: Promise<AcpJsonValue>;
    try { work = request.host((actual) => { callback = actual; }); }
    catch (cause) { work = Promise.reject(cause); }
    void work.then(() => callback, () => callback).then(joined.resolve, () => joined.resolve());
    return work;
  }

  async join(): Promise<void> {
    while (this.retained.size > 0) await Promise.all([...this.retained].map(async (request) => {
      await request.transportSettled;
      await request.hostWork;
    }));
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
    this.pending.delete(request);
    return true;
  }

  cancelAll(): void {
    for (const request of [...this.pending]) this.cancel(request);
  }

  private cancel(request: PendingSessionRequest): void {
    if (this.release(request)) request.response.resolve(canceledRequestReply(request.kind));
  }
}
