import { Readable, Writable } from 'node:stream';
import {
  createAcpClient,
  createAcpStandardSessionOperations,
  type AcpClient,
  type AcpJsonValue,
  type AcpRequestOptions,
  type AcpUnknownExtensionPolicy,
} from '@agen-ai/acp-transport';
import { throwIfAgentOperationAborted } from '@agen-ai/agent-runtime';
import type { AcpConnectionFactoryContext, AcpConnectionLease } from '../contracts.js';
import type { AcpProviderLimits } from '../limits.js';
import type { AcpConnectionAcquisition, AcpInitializedConnection, AcpSessionIngress } from './contracts.js';
import { AcpProviderConnectionError } from './errors.js';
import { acquireAcpLease, releaseOwnedLease } from './acquire.js';
import { readNegotiatedAgent } from './negotiation.js';
import type { AcpAuthenticationMethods, AcpHostFacilities, AcpHostInteractionScope } from '../host/contracts.js';
import { AcpHostRouter, type AcpBoundSession } from '../host/router.js';
import { SessionInteractionBroker } from '../sessionInteractions/broker.js';
import { createSessionInteractionExtensionRegistry } from '../sessionInteractions/extensions.js';
import { GROK_FOLDER_TRUST_CAPABILITY_META, GROK_FOLDER_TRUST_METHOD } from '../sessionInteractions/grokFolderTrust.js';
import type { AcpSessionInteractionSelection } from '../sessionInteractions/contracts.js';
import { awaitHost } from '../host/lifecycle.js';
import type { AcpPermissionMappingSelection } from '../permissions/contracts.js';
import { GROK_PLAN_REVIEW_METHOD, GROK_QUEUE_METHOD, GROK_SESSION_NOTIFICATION_METHOD } from '../sessionInteractions/grokPlanReview.js';

export async function initializeAcpConnection(input: {
  readonly source: AcpConnectionAcquisition;
  readonly unknownExtensionPolicy: AcpUnknownExtensionPolicy;
  readonly context: AcpConnectionFactoryContext;
  readonly limits: AcpProviderLimits;
  readonly usedStreams: WeakSet<object>;
  readonly host?: AcpHostFacilities;
  readonly authentication?: AcpAuthenticationMethods;
  readonly configuration?: 'managed' | 'selectable';
  readonly sessionInteractions?: AcpSessionInteractionSelection;
  readonly permissionMapping?: AcpPermissionMappingSelection;
}): Promise<AcpInitializedConnection> {
  throwIfAgentOperationAborted(input.context.signal);
  const initialization = new AbortController();
  const onInitializationAbort = () => initialization.abort(input.context.signal?.reason instanceof Error
    ? input.context.signal.reason
    : new DOMException('ACP initialization was aborted.', 'AbortError'));
  input.context.signal?.addEventListener('abort', onInitializationAbort, { once: true });
  const timeout = setTimeout(() => initialization.abort(new AcpProviderConnectionError(
    'acp_provider_initialization_timeout', 'ACP connection acquisition or initialization exceeded its deadline.',
  )), input.limits.initializationTimeoutMs);
  let lease: AcpConnectionLease;
  const execution = input.source.kind === 'reserved' ? input.source.owner : undefined;
  try {
    const context = { ...input.context, signal: initialization.signal };
    lease = input.source.kind === 'factory'
      ? await acquireAcpLease(input.source.create, context)
      : await awaitHost(input.source.owner.start(context), initialization.signal);
    try { validateLease(lease, input.usedStreams); } catch (cause) {
      if (execution) throw cause;
      try { await releaseOwnedLease(lease); } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], 'ACP lease validation and cleanup failed.');
      }
      throw cause;
    }
  } catch (cause) {
    clearTimeout(timeout);
    input.context.signal?.removeEventListener('abort', onInitializationAbort);
    if (execution) {
      try { await execution.cleanup(); }
      catch (cleanupError) { throw execution.retainedError(cause, cleanupError); }
    }
    throw cause;
  }
  const stopped = new AbortController();
  let client: AcpClient | undefined;
  let ingress: AcpSessionIngress | undefined;
  let joinSessionCallbacks: (() => Promise<void>) | undefined;
  let attached = false;
  let closePromise: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  let released = false;
  let sessionInteractions: SessionInteractionBroker | undefined;
  const host = input.host ?? {};
  const router = new AcpHostRouter({ instanceId: input.context.instanceId, host, limits: input.limits,
    stopped: stopped.signal, ingress: () => ingress,
    ...(input.sessionInteractions ? { humanTimeoutMs: () => sessionInteractions?.humanTimeoutMs() } : {}),
  });
  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (!releasePromise) releasePromise = Promise.resolve()
      .then(() => releaseOwnedLease(lease))
      .then(() => { released = true; })
      .catch((error) => { releasePromise = undefined; throw error; });
    return releasePromise;
  };
  const stop = (reason: Error) => {
    if (!stopped.signal.aborted) stopped.abort(reason);
  };
  const closeActual = (): Promise<void> => {
    if (!closePromise) {
      closePromise = Promise.resolve().then(async () => {
        try {
          // Start transport disposal and actual producer release before joining callbacks.
          const stopping = [router.close(), ...(client ? [client.dispose()] : []), release()];
          const cleanup = await Promise.allSettled([...stopping,
            ...(joinSessionCallbacks ? [joinSessionCallbacks()] : []), ...(sessionInteractions ? [sessionInteractions.join()] : [])]);
          const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'ACP connection cleanup failed.');
        } finally {
          lease.stdout.off('end', onPeerEnd);
          lease.stdout.off('close', onPeerEnd);
          lease.stdout.off('error', onPeerError);
          lease.stdin.off('error', onPeerError);
          lease.stderr?.off('error', onPeerError);
          initialization.signal.removeEventListener('abort', onAbort);
        }
      }).catch((error) => { closePromise = undefined; throw error; });
      sessionInteractions?.stop({ kind: 'session_closed' });
      stop(new AcpProviderConnectionError('acp_provider_connection_closed', 'The ACP connection was closed.'));
    }
    return closePromise;
  };
  execution?.retainCleanup(closeActual);
  const close = (): Promise<void> => execution ? execution.cleanup() : closeActual();
  const fail = (error: Error): void => {
    if (stopped.signal.aborted) return;
    stop(error);
    void close().catch(() => undefined);
  };
  if (input.sessionInteractions) sessionInteractions = new SessionInteractionBroker({
    stopped: stopped.signal, limits: input.limits, onFailure: fail, selection: input.sessionInteractions,
  });
  const onPeerEnd = () => {
    fail(new AcpProviderConnectionError('acp_provider_peer_closed', 'The ACP peer closed its stream.'));
  };
  const onPeerError = (error: Error) => {
    fail(error);
  };
  const onAbort = () => {
    fail(initialization.signal.reason instanceof Error
      ? initialization.signal.reason
      : new DOMException('ACP initialization was aborted.', 'AbortError'));
  };
  lease.stdout.once('end', onPeerEnd);
  lease.stdout.once('close', onPeerEnd);
  lease.stdout.once('error', onPeerError);
  lease.stdin.once('error', onPeerError);
  lease.stderr?.once('error', onPeerError);
  initialization.signal.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAgentOperationAborted(initialization.signal);
    client = createAcpClient({
      stdout: lease.stdout,
      stdin: lease.stdin,
      ...(lease.stderr ? { stderr: lease.stderr } : {}),
      schemaProfile: 'schema-v1.23.0',
      schemaChannel: 'stable',
      unknownExtensionPolicy: input.unknownExtensionPolicy,
      outboundRequestIdPrefix: 'agenai-acp-',
      ...(input.sessionInteractions ? { extensions: createSessionInteractionExtensionRegistry(input.sessionInteractions) } : {}),
      limits: {
        maxInboundFrameBytes: Math.min(input.limits.maxQueuedBytes, 1_024 * 1_024),
        maxOutboundFrameBytes: Math.min(input.limits.maxQueuedBytes, 8 * 1_024 * 1_024),
        maxOutboundBufferedBytes: Math.min(input.limits.maxQueuedBytes, 8 * 1_024 * 1_024) + 1,
        maxNotificationHandlerConcurrency: input.limits.maxQueuedMessages,
        maxInboundRequestConcurrency: input.limits.maxPendingRequests,
        defaultRequestTimeoutMs: 30 * 60_000,
        maxRequestTimeoutMs: 30 * 60_000,
        shutdownDrainMs: 0,
      },
      notificationHandlers: {
        ...(input.sessionInteractions?.mapping === 'grok-build-1.0.60-session-requests-v1'
          ? Object.fromEntries([GROK_QUEUE_METHOD, GROK_SESSION_NOTIFICATION_METHOD].map((method) => [method,
            (notification: import('@agen-ai/acp-transport').AcpNotificationContext) => {
              if (!ingress?.onExtensionNotification) throw new AcpProviderConnectionError('acp_provider_session_not_attached', 'Native continuation output has no bound owner.');
              return ingress.onExtensionNotification(notification);
            }])) : {}),
        'session/update': (notification) => {
          if (!ingress) throw new AcpProviderConnectionError('acp_provider_session_not_attached', 'ACP output has no bound session.');
          return ingress.onNotification(notification);
        },
        'elicitation/complete': (notification) => router.complete(notification.params ?? null),
      },
      reverseRequestHandlers: {
        ...(sessionInteractions ? { [input.sessionInteractions?.mapping === 'grok-folder-trust-v1'
          ? GROK_FOLDER_TRUST_METHOD : GROK_PLAN_REVIEW_METHOD]: sessionInteractions.handleRequest } : {}),
        ...Object.fromEntries(['session/request_permission', 'elicitation/create', 'fs/read_text_file', 'fs/write_text_file',
          'terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release']
          .map((method) => [method, (request: import('@agen-ai/acp-transport').AcpReverseRequestContext) => router.admit(request)])),
      },
      onFatalError: fail,
    });
    void client.closed.then((result) => {
      fail(result.error ?? new AcpProviderConnectionError('acp_provider_connection_closed', 'The ACP connection stopped.'));
    });
    const response = await createAcpStandardSessionOperations(client).initialize({
      protocolVersion: 1,
      clientCapabilities: {
        ...(input.sessionInteractions?.mapping === 'grok-folder-trust-v1' ? { _meta: GROK_FOLDER_TRUST_CAPABILITY_META } : {}),
        fs: { readTextFile: !!host.readTextFile, writeTextFile: !!host.writeTextFile },
        terminal: !!host.createTerminal,
        auth: { terminal: !!host.authenticateInTerminal && !!input.authentication?.terminal },
        elicitation: { form: {}, ...(host.url ? { url: {} } : {}) },
        ...(input.configuration === 'selectable' ? { session: { configOptions: { boolean: {} } } } : {}),
      },
      clientInfo: { name: '@agen-ai/provider-acp', version: '0.4.2' },
    }, {
      timeoutMs: input.limits.initializationTimeoutMs,
      signal: initialization.signal,
    });
    if (stopped.signal.aborted) throw stopped.signal.reason;
    const negotiated = readNegotiatedAgent(response, input.permissionMapping, input.sessionInteractions);
    initialization.signal.removeEventListener('abort', onAbort);
    return Object.freeze({
      client,
      negotiated,
      stopped: stopped.signal,
      ...(execution ? { execution } : {}),
      ...(sessionInteractions ? { sessionInteractions } : {}),
      bindSession: (binding: AcpBoundSession) => router.bindSession(binding),
      ...(host.form || host.url ? { hostElicitation: (context: import('@agen-ai/acp-transport').AcpReverseRequestContext,
        observeCallback?: (work: Promise<void>) => void) => router.sessionElicitation(context, observeCallback) } : {}),
      async requestWithScope(method: string, params: AcpJsonValue, scope: AcpHostInteractionScope, options: AcpRequestOptions = {}) {
        if (!['authenticate', 'session/new', 'session/load', 'session/resume', 'session/set_config_option', 'session/set_mode'].includes(method)) {
          throw new TypeError('This ACP method does not grant request-scoped host interaction authority.');
        }
        const bound = router.requestScope(scope, options.signal ?? stopped.signal, options);
        try { return await client!.request(method, params, bound.options); } finally { await bound.close(); }
      },
      attachSession(next: AcpSessionIngress) {
        if (stopped.signal.aborted) throw stopped.signal.reason;
        if (attached) throw new AcpProviderConnectionError('acp_provider_connection_already_attached', 'ACP connections accept exactly one session.');
        attached = true;
        ingress = next;
        joinSessionCallbacks = next.joinCallbacks;
        return () => { ingress = undefined; };
      },
      close,
    });
  } catch (cause) {
    if (execution?.cleanupFailure) throw execution.retainedError(cause, execution.cleanupFailure.error);
    try { await close(); } catch (cleanupError) {
      if (execution) throw execution.retainedError(cause, cleanupError);
      throw new AggregateError([cause, cleanupError], 'ACP initialization and cleanup failed.');
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
    input.context.signal?.removeEventListener('abort', onInitializationAbort);
  }
}

function validateLease(lease: AcpConnectionLease, usedStreams: WeakSet<object>): void {
  if (!lease || !(lease.stdout instanceof Readable) || !(lease.stdin instanceof Writable)
    || (lease.stderr !== undefined && !(lease.stderr instanceof Readable))
    || (lease.ownership !== 'owned' && lease.ownership !== 'borrowed')
    || (lease.ownership === 'owned' && typeof lease.release !== 'function')) {
    throw new TypeError('ACP connection factories must return an explicit stream lease.');
  }
  const streams = [lease.stdout, lease.stdin, ...(lease.stderr ? [lease.stderr] : [])];
  if (streams.some((stream) => usedStreams.has(stream))) {
    throw new AcpProviderConnectionError('acp_provider_stream_reused', 'ACP connection streams must be fresh and exclusive.');
  }
  for (const stream of streams) usedStreams.add(stream);
}
