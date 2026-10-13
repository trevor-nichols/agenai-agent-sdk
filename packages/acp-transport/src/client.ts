// ------------------------------------------------------------------------------------------------
//                client.ts - Bounded schema-pinned ACP JSON-RPC client - Dependencies: streams/Ajv
// ------------------------------------------------------------------------------------------------

import { AcpClientError, AcpProtocolError, AcpRemoteError, AcpRequestError, AcpRpcHandlerError } from './errors.js';
import { createAcpExtensionRegistry } from './extensions.js';
import { captureAcpStderr } from './diagnostics.js';
import { assertBoundedAcpJson, parseBoundedAcpJson, type AcpJsonValue } from './json.js';
import { createAcpLineFramer } from './lineFramer.js';
import { resolveAcpProtocolLimits } from './limits.js';
import { createAcpMessageWriter } from './messageWriter.js';
import {
  acpRequestIdKey,
  parseAcpMessage,
  type AcpErrorObject,
  type AcpNotificationMessage,
  type AcpRequestId,
  type AcpRequestMessage,
  type AcpResponseMessage,
} from './protocol.js';
import { createAcpSchemaValidator } from './schema.js';
import type {
  AcpClient,
  AcpClientCloseResult,
  AcpResponseReceived,
  CreateAcpClientOptions,
} from './clientContracts.js';
import {
  boundedTimeout,
  cleanupPendingRequest,
  deferred,
  isCriticalExtensionMethod,
  type ActiveReverseRequest,
  type PendingRequest,
} from './clientState.js';

// ------------------------------------------------------------------------------------------------
//                Client Factory
// ------------------------------------------------------------------------------------------------

export function createAcpClient(options: CreateAcpClientOptions): AcpClient {
  const requestedUnknownExtensionPolicy = options.unknownExtensionPolicy;
  const unknownExtensionPolicy = requestedUnknownExtensionPolicy === undefined ? 'reject' : requestedUnknownExtensionPolicy;
  if (unknownExtensionPolicy !== 'reject' && unknownExtensionPolicy !== 'standard') {
    throw new TypeError('ACP unknown extension policy is invalid.');
  }
  const limits = resolveAcpProtocolLimits(options.limits);
  const outboundRequestIdPrefix = options.outboundRequestIdPrefix;
  if (outboundRequestIdPrefix !== undefined && (
    !/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(outboundRequestIdPrefix)
    || Buffer.byteLength(outboundRequestIdPrefix, 'utf8') > limits.maxRequestIdBytes - 16
  )) {
    throw new TypeError('ACP outbound request ID prefix is invalid.');
  }
  const schema = createAcpSchemaValidator(options.schemaChannel, options.schemaProfile);
  const extensions = options.extensions ?? createAcpExtensionRegistry();
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingRequest>();
  const activeReverse = new Map<string, ActiveReverseRequest>();
  const reservedInboundRequestIds = new Set<string>();
  const activeNotifications = new Set<Promise<void>>();
  const diagnostics = captureAcpStderr(options.stderr, limits.maxStderrBufferedBytes);
  const writer = createAcpMessageWriter({
    writable: options.stdin,
    maxFrameBytes: limits.maxOutboundFrameBytes,
    maxBufferedBytes: limits.maxOutboundBufferedBytes,
  });
  const closeDeferred = deferred<AcpClientCloseResult>();
  let state: 'open' | 'closing' | 'closed' = 'open';
  let closePromise: Promise<void> | undefined;
  let nextRequestId = 1;
  let notificationWindowStartedAt = now();
  let notificationsInWindow = 0;
  const framerState: { current?: ReturnType<typeof createAcpLineFramer> } = {};

  const assertOpen = () => {
    if (state !== 'open') {
      throw new AcpClientError('acp_client_closed', 'The ACP client is not open.');
    }
  };

  const cleanupPending = (entry: PendingRequest) => {
    cleanupPendingRequest(pending, entry);
  };

  const close = (result: AcpClientCloseResult): Promise<void> => {
    if (closePromise) return closePromise;
    const completion = deferred<void>();
    closePromise = completion.promise;
    state = 'closing';
    framerState.current?.dispose();
    diagnostics.dispose();
    const closeError = result.error ?? new AcpClientError(
      'acp_client_disposed',
      'The ACP client was disposed.',
    );
    for (const entry of pending.values()) {
      cleanupPending(entry);
      entry.reject(closeError);
    }
    for (const active of activeReverse.values()) active.controller.abort(closeError);

    void (async () => {
      const settlements = [
        ...[...activeReverse.values()].map((active) => active.settlement),
        ...activeNotifications,
      ];
      await writer.dispose(limits.shutdownDrainMs);
      if (settlements.length > 0 && limits.shutdownDrainMs > 0) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(settlements),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, limits.shutdownDrainMs);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
      }
      try {
        await options.disposeTransport?.();
      } finally {
        state = 'closed';
        closeDeferred.resolve(result);
      }
    })().then(completion.resolve, completion.reject);
    if (result.kind === 'fatal' && result.error) options.onFatalError?.(result.error);
    return closePromise;
  };

  const fatal = (error: Error) => {
    if (state !== 'open') return;
    void close({ kind: 'fatal', error }).catch(() => undefined);
  };

  const writeOrFail = async (
    message: AcpRequestMessage | AcpNotificationMessage | AcpResponseMessage,
  ): Promise<void> => {
    try {
      await writer.write(message);
    } catch (error) {
      const normalized = error instanceof Error
        ? error
        : new AcpClientError('acp_stdin_write_failed', 'The ACP input stream write failed.');
      fatal(normalized);
      throw normalized;
    }
  };

  const sendErrorResponse = async (id: AcpRequestId, error: AcpErrorObject): Promise<void> => {
    if (state !== 'open') return;
    await writeOrFail({ jsonrpc: '2.0', id, error });
  };

  const sendReservedErrorResponse = (
    key: string,
    id: AcpRequestId,
    error: AcpErrorObject,
  ): void => {
    reservedInboundRequestIds.add(key);
    void sendErrorResponse(id, error)
      .catch(() => undefined)
      .finally(() => reservedInboundRequestIds.delete(key));
  };

  const validateOutbound = (
    kind: 'request' | 'notification',
    method: string,
    params: AcpJsonValue,
  ): boolean => {
    assertBoundedAcpJson(params, limits);
    if (schema.hasMethod('agent', method, kind)) {
      schema.validate('agent', method, kind, params);
      return false;
    }
    const direction = kind === 'request' ? 'outbound_request' : 'outbound_notification';
    if (!extensions.get(direction, method)) {
      throw new AcpClientError(
        'acp_outbound_method_not_registered',
        'The ACP outbound method is not in the pinned schema or extension registry.',
        { method, kind },
      );
    }
    extensions.validateParams(direction, method, params);
    return true;
  };

  const validateResponseResult = (entry: PendingRequest, result: AcpJsonValue) => {
    if (entry.extension) {
      extensions.validateResult('outbound_request', entry.method, result);
    } else {
      schema.validate('agent', entry.method, 'response', result);
    }
  };

  const handleResponse = (message: AcpResponseMessage) => {
    const key = acpRequestIdKey(message.id);
    if (reservedInboundRequestIds.has(key)) {
      fatal(new AcpProtocolError('acp_request_id_direction_collision'));
      return;
    }
    const entry = pending.get(key);
    if (!entry) {
      fatal(new AcpProtocolError('acp_orphan_or_late_response', { requestIdType: typeof message.id }));
      return;
    }
    cleanupPending(entry);
    let received: AcpResponseReceived;
    try {
      if ('error' in message) {
        received = { kind: 'error', error: new AcpRemoteError(
          message.id,
          message.error.code,
          message.error.message,
          message.error.data,
        ) };
      } else {
        validateResponseResult(entry, message.result);
        received = { kind: 'result', result: message.result };
      }
    } catch (error) {
      const normalized = error instanceof Error
        ? error
        : new AcpProtocolError('acp_response_validation_failed');
      entry.reject(normalized);
      fatal(normalized);
      return;
    }
    try {
      entry.onResponseReceived?.(received);
    } catch (error) {
      const normalized = error instanceof Error
        ? error
        : new AcpProtocolError('acp_response_admission_failed');
      entry.reject(normalized);
      fatal(normalized);
      return;
    }
    if (received.kind === 'error') entry.reject(received.error);
    else entry.resolve(received.result);
  };

  const handleProtocolNotification = (message: AcpNotificationMessage): boolean => {
    if (message.method !== '$/cancel_request') return false;
    if (!schema.hasMethod('protocol', message.method, 'notification')) {
      fatal(new AcpProtocolError('acp_unstable_notification_denied'));
      return true;
    }
    try {
      schema.validate('protocol', message.method, 'notification', message.params);
      const params = message.params as { readonly requestId: AcpRequestId };
      activeReverse.get(acpRequestIdKey(params.requestId))?.controller.abort(
        new AcpRequestError('acp_reverse_request_canceled', params.requestId),
      );
    } catch (error) {
      fatal(error instanceof Error ? error : new AcpProtocolError('acp_cancel_invalid'));
    }
    return true;
  };

  const accountNotification = () => {
    const current = now();
    if (current - notificationWindowStartedAt >= limits.notificationWindowMs) {
      notificationWindowStartedAt = current;
      notificationsInWindow = 0;
    }
    notificationsInWindow += 1;
    if (notificationsInWindow > limits.maxNotificationsPerWindow) {
      throw new AcpProtocolError('acp_notification_rate_exceeded');
    }
  };

  const handleNotification = (message: AcpNotificationMessage) => {
    try {
      accountNotification();
    } catch (error) {
      fatal(error instanceof Error ? error : new AcpProtocolError('acp_notification_rate_exceeded'));
      return;
    }
    if (handleProtocolNotification(message)) return;

    let safelyIgnorable = false;
    try {
      if (schema.hasMethod('client', message.method, 'notification')) {
        schema.validate('client', message.method, 'notification', message.params);
      } else {
        const extension = extensions.get('inbound_notification', message.method);
        if (!extension) {
          if (unknownExtensionPolicy === 'standard' && message.method.startsWith('_')) return;
          throw new AcpProtocolError(
            isCriticalExtensionMethod(message.method)
              ? 'acp_unknown_critical_extension'
              : 'acp_unsolicited_notification',
            { method: message.method },
          );
        }
        extensions.validateParams('inbound_notification', message.method, message.params);
        safelyIgnorable = extension.safelyIgnorable === true;
      }
    } catch (error) {
      fatal(error instanceof Error ? error : new AcpProtocolError('acp_notification_invalid'));
      return;
    }

    const handler = options.notificationHandlers?.[message.method];
    if (!handler) {
      if (!safelyIgnorable) fatal(new AcpProtocolError('acp_notification_handler_missing', {
        method: message.method,
      }));
      return;
    }
    if (activeNotifications.size >= limits.maxNotificationHandlerConcurrency) {
      fatal(new AcpProtocolError('acp_notification_concurrency_exceeded'));
      return;
    }
    const settlement = deferred<void>();
    activeNotifications.add(settlement.promise);
    void (async () => {
      try {
        await handler({ method: message.method, params: message.params });
      } catch (error) {
        fatal(error instanceof Error ? error : new AcpClientError(
          'acp_notification_handler_failed',
          'An ACP notification handler failed.',
        ));
      } finally {
        activeNotifications.delete(settlement.promise);
        settlement.resolve();
      }
    })();
  };

  const runReverseRequest = (
    message: AcpRequestMessage,
    extension: boolean,
    handler: NonNullable<CreateAcpClientOptions['reverseRequestHandlers']>[string],
    controller: AbortController,
  ): Promise<void> => (async () => {
    try {
      const result = await handler({
        id: message.id,
        method: message.method,
        params: message.params,
        signal: controller.signal,
      });
      assertBoundedAcpJson(result, limits);
      if (extension) extensions.validateResult('inbound_request', message.method, result);
      else schema.validate('client', message.method, 'response', result);
      if (state === 'open') await writeOrFail({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (state !== 'open') return;
      const rpcError = error instanceof AcpRpcHandlerError
        ? error
        : controller.signal.aborted
          ? new AcpRpcHandlerError(-32800, 'Request cancelled')
          : new AcpRpcHandlerError(-32603, 'Internal error');
      if (rpcError.data !== undefined) assertBoundedAcpJson(rpcError.data, limits);
      await sendErrorResponse(message.id, {
        code: rpcError.code,
        message: rpcError.message,
        ...(rpcError.data !== undefined ? { data: rpcError.data as AcpJsonValue } : {}),
      });
    }
  })();

  const handleRequest = (message: AcpRequestMessage) => {
    const key = acpRequestIdKey(message.id);
    if (pending.has(key)) {
      fatal(new AcpProtocolError('acp_request_id_direction_collision'));
      return;
    }
    if (reservedInboundRequestIds.has(key)) {
      fatal(new AcpProtocolError('acp_duplicate_reverse_request_id'));
      return;
    }
    let extension = false;
    try {
      if (schema.hasMethod('client', message.method, 'request')) {
        schema.validate('client', message.method, 'request', message.params);
      } else if (extensions.get('inbound_request', message.method)) {
        extensions.validateParams('inbound_request', message.method, message.params);
        extension = true;
      } else if (unknownExtensionPolicy === 'standard' && message.method.startsWith('_')) {
        sendReservedErrorResponse(key, message.id, { code: -32601, message: 'Method not found' });
        return;
      } else {
        throw new AcpProtocolError(
          isCriticalExtensionMethod(message.method)
            ? 'acp_unknown_critical_extension'
            : 'acp_unsolicited_request',
          { method: message.method },
        );
      }
    } catch (error) {
      fatal(error instanceof Error ? error : new AcpProtocolError('acp_reverse_request_invalid'));
      return;
    }

    if (activeReverse.size >= limits.maxInboundRequestConcurrency) {
      sendReservedErrorResponse(key, message.id, {
        code: -32000,
        message: 'Inbound request limit reached',
      });
      return;
    }

    const handler = options.reverseRequestHandlers?.[message.method];
    if (!handler) {
      sendReservedErrorResponse(key, message.id, {
        code: -32601,
        message: 'Method not found',
      });
      return;
    }
    const controller = new AbortController();
    reservedInboundRequestIds.add(key);
    const settlement = deferred<void>();
    activeReverse.set(key, { controller, settlement: settlement.promise });
    void runReverseRequest(message, extension, handler, controller)
      .catch((error) => fatal(error instanceof Error ? error : new AcpProtocolError(
        'acp_reverse_request_failed',
      )))
      .finally(() => {
        activeReverse.delete(key);
        reservedInboundRequestIds.delete(key);
        settlement.resolve();
      });
  };

  const onFrame = (frame: string) => {
    if (state !== 'open') return;
    try {
      const message = parseAcpMessage(parseBoundedAcpJson(frame, limits), limits);
      if ('method' in message) {
        if ('id' in message) handleRequest(message);
        else handleNotification(message);
      } else {
        handleResponse(message);
      }
    } catch (error) {
      fatal(error instanceof Error ? error : new AcpProtocolError('acp_frame_invalid'));
    }
  };

  framerState.current = createAcpLineFramer({
    readable: options.stdout,
    maxFrameBytes: limits.maxInboundFrameBytes,
    onFrame,
    onFatal: fatal,
    onEnd: () => {
      void close({
        kind: 'peer_closed',
        error: new AcpClientError('acp_peer_closed', 'The ACP peer closed its output stream.'),
      }).catch(() => undefined);
    },
  });

  const allocateRequestId = (): AcpRequestId => {
    for (let attempts = 0; attempts <= limits.maxOutstandingRequests; attempts += 1) {
      const sequence = nextRequestId;
      nextRequestId = nextRequestId === Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
      const candidate = outboundRequestIdPrefix
        ? `${outboundRequestIdPrefix}${sequence}`
        : sequence;
      const key = acpRequestIdKey(candidate);
      if (!pending.has(key) && !reservedInboundRequestIds.has(key)) return candidate;
    }
    throw new AcpClientError('acp_request_id_space_exhausted', 'No ACP request ID is available.');
  };

  const sendCancellation = (requestId: AcpRequestId) => {
    if (state !== 'open' || !schema.hasMethod('protocol', '$/cancel_request', 'notification')) return;
    const params = { requestId } as AcpJsonValue;
    try {
      schema.validate('protocol', '$/cancel_request', 'notification', params);
      void writeOrFail({ jsonrpc: '2.0', method: '$/cancel_request', params }).catch(() => undefined);
    } catch (error) {
      fatal(error instanceof Error ? error : new AcpProtocolError('acp_cancel_invalid'));
    }
  };

  const client: AcpClient = {
    request: async (method, params, requestOptions = {}) => {
      assertOpen();
      if (pending.size >= limits.maxOutstandingRequests) {
        throw new AcpClientError(
          'acp_outstanding_request_limit_exceeded',
          'The ACP outstanding request limit is reached.',
        );
      }
      const extension = validateOutbound('request', method, params);
      const timeoutMs = boundedTimeout({
        options: requestOptions,
        now: now(),
        defaultMs: limits.defaultRequestTimeoutMs,
        maximumMs: limits.maxRequestTimeoutMs,
      });
      if (timeoutMs <= 0 || requestOptions.signal?.aborted) {
        throw new AcpRequestError('acp_request_aborted', 0);
      }
      const id = allocateRequestId();
      const key = acpRequestIdKey(id);

      return new Promise<AcpJsonValue>((resolve, reject) => {
        const abort = () => {
          const entry = pending.get(key);
          if (!entry) return;
          cleanupPending(entry);
          reject(new AcpRequestError('acp_request_aborted', id));
          sendCancellation(id);
        };
        requestOptions.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => {
          const entry = pending.get(key);
          if (!entry) return;
          cleanupPending(entry);
          reject(new AcpRequestError('acp_request_deadline_exceeded', id));
          sendCancellation(id);
        }, timeoutMs);
        const entry: PendingRequest = {
          id,
          method,
          extension,
          resolve,
          reject,
          timer,
          removeAbortListener: () => requestOptions.signal?.removeEventListener('abort', abort),
          ...(requestOptions.onResponseReceived === undefined ? {} : {
            onResponseReceived: requestOptions.onResponseReceived,
          }),
        };
        pending.set(key, entry);
        try {
          requestOptions.onRequestDispatch?.({ requestId: id });
        } catch (error) {
          cleanupPending(entry);
          reject(error);
          return;
        }
        if (pending.get(key) !== entry) return;
        void writeOrFail({ jsonrpc: '2.0', id, method, params }).catch((error) => {
          if (pending.get(key) !== entry) return;
          cleanupPending(entry);
          reject(error);
        });
      });
    },
    notify: async (method, params) => {
      assertOpen();
      validateOutbound('notification', method, params);
      await writeOrFail({ jsonrpc: '2.0', method, params });
    },
    diagnostics: diagnostics.snapshot,
    closed: closeDeferred.promise,
    dispose: () => close({ kind: 'disposed' }),
  };
  return Object.freeze(client);
}

export type {
  AcpClient,
  AcpClientCloseResult,
  AcpNotificationContext,
  AcpNotificationHandler,
  AcpRequestOptions,
  AcpRequestDispatchContext,
  AcpResponseReceived,
  AcpReverseRequestContext,
  AcpReverseRequestHandler,
  AcpUnknownExtensionPolicy,
  CreateAcpClientOptions,
} from './clientContracts.js';
export * from './standardSessionOperations.js';
