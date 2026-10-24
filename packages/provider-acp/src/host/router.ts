import {
  AcpRpcHandlerError,
  type AcpJsonObject,
  type AcpJsonValue,
  type AcpRequestId,
  type AcpRequestOptions,
  type AcpReverseRequestContext,
} from '@agen-ai/acp-transport';
import type { AgentInstanceId, AgentSessionId } from '@agen-ai/agent-protocol';
import type { AcpSessionIngress } from '../connection/contracts.js';
import type { AcpProviderLimits } from '../limits.js';
import type { AcpHostFacilities, AcpHostInteractionScope, AcpHostSessionInput } from './contracts.js';
import { AcpHostInteractions } from './interactions.js';
import { awaitHost, hostDeadline } from './lifecycle.js';
import { AcpHostTerminals } from './terminals.js';
import { hostInteger, hostObject, hostPath, hostText, invalidHostRequest, unsupportedHostRequest } from './validation.js';

export interface AcpBoundSession {
  readonly nativeSessionId: string;
  readonly sessionId: AgentSessionId;
  readonly workingDirectory: string;
}

interface RequestScope {
  readonly scope: AcpHostInteractionScope;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export class AcpHostRouter {
  private readonly interactions: AcpHostInteractions;
  private readonly terminals: AcpHostTerminals;
  private readonly requests = new Map<string, RequestScope>();
  private binding: AcpBoundSession | undefined;
  private readonly pending = new Map<Promise<void>, Promise<void>>();
  private bytes = 0;

  constructor(private readonly input: {
    readonly instanceId: AgentInstanceId;
    readonly host: AcpHostFacilities;
    readonly limits: AcpProviderLimits;
    readonly stopped: AbortSignal;
    readonly humanTimeoutMs?: () => number | undefined;
    readonly ingress: () => AcpSessionIngress | undefined;
  }) {
    this.interactions = new AcpHostInteractions(input);
    this.terminals = new AcpHostTerminals(input.host, input.limits);
  }

  bindSession(binding: AcpBoundSession): void {
    if (this.binding && (binding.nativeSessionId !== this.binding.nativeSessionId
      || binding.sessionId !== this.binding.sessionId || binding.workingDirectory !== this.binding.workingDirectory)) {
      throw invalidHostRequest();
    }
    this.binding = Object.freeze({ ...binding });
  }

  requestScope(scope: AcpHostInteractionScope, signal: AbortSignal, options: AcpRequestOptions = {}) {
    const lifetime = new AbortController();
    let key: string | undefined;
    const abort = () => lifetime.abort(signal.reason ?? new DOMException('Originating request settled.', 'AbortError'));
    const close = () => {
      if (key) this.requests.delete(key);
      signal.removeEventListener('abort', abort);
      abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return {
      options: {
        ...options,
        onRequestDispatch: (context: { readonly requestId: AcpRequestId }) => {
          key = JSON.stringify(context.requestId);
          this.requests.set(key, { scope, signal: lifetime.signal, abort });
          options.onRequestDispatch?.(context);
        },
        onResponseReceived: (response) => { close(); options.onResponseReceived?.(response); },
      } satisfies AcpRequestOptions,
      close: () => { close(); return this.interactions.closeScope(lifetime.signal); },
    };
  }

  admit(context: AcpReverseRequestContext): Promise<AcpJsonValue> {
    const params = hostObject(context.params);
    if (context.method === 'session/request_permission'
      || (context.method === 'elicitation/create' && Object.hasOwn(params, 'sessionId'))) return this.route(context, params);
    const bytes = Buffer.byteLength(JSON.stringify(context.params), 'utf8');
    if (this.pending.size >= this.input.limits.maxPendingRequests
      || this.bytes + bytes > this.input.limits.maxQueuedBytes) {
      throw new AcpRpcHandlerError(-32603, 'The host request capacity was exceeded.');
    }
    this.bytes += bytes;
    const retirement = context.settled.then(() => this.interactions.joinRequest(context.settled)).then(() => {
      this.pending.delete(context.settled); this.bytes -= bytes;
    });
    this.pending.set(context.settled, retirement);
    const result = this.route(context, params);
    return result.then((value) => {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > Math.min(this.input.limits.maxQueuedBytes, 8 * 1_024 * 1_024) - 512) {
        throw invalidHostRequest();
      }
      return value;
    });
  }

  private route(context: AcpReverseRequestContext, params: AcpJsonObject): Promise<AcpJsonValue> {
    if (context.method === 'elicitation/create') {
      const session = Object.hasOwn(params, 'sessionId');
      const request = Object.hasOwn(params, 'requestId');
      if (session === request || (!session && params.toolCallId != null)) throw invalidHostRequest();
      if (request) {
        const scope = this.requests.get(JSON.stringify(params.requestId));
        if (!scope || scope.signal.aborted) throw invalidHostRequest();
        return this.interactions.request(context, scope.scope, scope.signal);
      }
      this.requireSession(params, context.signal);
      const ingress = this.input.ingress();
      if (!ingress) throw invalidHostRequest();
      return ingress.onElicitationRequest(context);
    }
    const session = this.requireSession(params, context.signal);
    if (context.method === 'session/request_permission') {
      const ingress = this.input.ingress();
      if (!ingress) throw invalidHostRequest();
      return ingress.onPermissionRequest(context);
    }
    const timeout = context.method === 'terminal/wait_for_exit'
      ? this.input.limits.terminalWaitTimeoutMs : this.input.limits.hostOperationTimeoutMs;
    const deadline = hostDeadline(session.signal, timeout);
    return this.hostRequest(context.method, params, { ...session, signal: deadline.signal })
      .finally(() => deadline.close());
  }

  private requireSession(params: AcpJsonObject, signal: AbortSignal): AcpHostSessionInput {
    if (!this.binding || params.sessionId !== this.binding.nativeSessionId || this.input.stopped.aborted) throw invalidHostRequest();
    return { instanceId: this.input.instanceId, sessionId: this.binding.sessionId,
      workingDirectory: this.binding.workingDirectory, signal: AbortSignal.any([signal, this.input.stopped]) };
  }

  private async hostRequest(method: string, params: AcpJsonObject, session: AcpHostSessionInput): Promise<AcpJsonValue> {
    if (method.startsWith('terminal/')) return this.terminals.request(method, params, session);
    const path = hostPath(params.path);
    if (method === 'fs/read_text_file') {
      if (!this.input.host.readTextFile) throw unsupportedHostRequest();
      const line = params.line == null ? undefined : hostInteger(params.line, 1, 0xffff_ffff);
      const limit = params.limit == null ? undefined : hostInteger(params.limit, 0, 0xffff_ffff);
      const content = await awaitHost(this.input.host.readTextFile({ ...session, path,
        maxBytes: Math.min(this.input.limits.maxQueuedBytes, 8 * 1_024 * 1_024) - 512,
        ...(line === undefined ? {} : { line }), ...(limit === undefined ? {} : { limit }) }), session.signal);
      hostText(content, this.input.limits.maxQueuedBytes, true);
      if (Buffer.byteLength(content, 'utf8') > this.input.limits.maxQueuedBytes) throw invalidHostRequest();
      return { content };
    }
    if (method === 'fs/write_text_file') {
      if (!this.input.host.writeTextFile) throw unsupportedHostRequest();
      const content = hostText(params.content, this.input.limits.maxQueuedBytes, true);
      await awaitHost(this.input.host.writeTextFile({ ...session, path, content }), session.signal);
      return {};
    }
    throw unsupportedHostRequest();
  }

  complete(value: AcpJsonValue): Promise<void> {
    const id = hostText(hostObject(value).elicitationId, 256);
    return this.interactions.complete(id);
  }

  sessionElicitation(context: AcpReverseRequestContext, observeCallback?: (work: Promise<void>) => void): Promise<AcpJsonValue> {
    const bound = this.requireSession(hostObject(context.params), context.signal);
    return this.interactions.request(context, { kind: 'session', sessionId: bound.sessionId,
      workingDirectory: bound.workingDirectory }, context.signal, observeCallback);
  }

  async close(): Promise<void> {
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    const deadline = hostDeadline(new AbortController().signal, this.input.limits.hostOperationTimeoutMs);
    const join = async () => { while (this.pending.size > 0) await Promise.all(this.pending.values()); };
    try {
      const results = await Promise.allSettled([this.interactions.close(), this.terminals.close(), awaitHost(join(), deadline.signal)]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'ACP host facility cleanup failed.');
    } finally { deadline.close(); }
  }
}
