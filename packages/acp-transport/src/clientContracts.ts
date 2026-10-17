// ------------------------------------------------------------------------------------------------
//                clientContracts.ts - Public ACP client contracts - Dependencies: streams/protocol
// ------------------------------------------------------------------------------------------------

import type { Readable, Writable } from 'node:stream';

import type { AcpExtensionRegistry } from './extensions.js';
import type { AcpRemoteError } from './errors.js';
import type { AcpJsonValue } from './json.js';
import type { AcpProtocolLimits } from './limits.js';
import type { AcpRequestId } from './protocol.js';
import type { AcpSchemaChannel, AcpSchemaProfile } from './schema.js';

export interface AcpReverseRequestContext {
  readonly id: AcpRequestId;
  readonly method: string;
  readonly params: AcpJsonValue | undefined;
  readonly signal: AbortSignal;
  /** Fulfills after this handler and its actual response write settle. Observe without awaiting inside the handler. */
  readonly settled: Promise<void>;
}

export type AcpReverseRequestHandler = (
  context: AcpReverseRequestContext,
) => AcpJsonValue | Promise<AcpJsonValue>;

export interface AcpNotificationContext {
  readonly method: string;
  readonly params: AcpJsonValue | undefined;
}

export type AcpNotificationHandler = (
  context: AcpNotificationContext,
) => void | Promise<void>;

export type AcpResponseReceived =
  | Readonly<{ kind: 'result'; result: AcpJsonValue }>
  | Readonly<{ kind: 'error'; error: AcpRemoteError }>;

export interface AcpRequestDispatchContext {
  readonly requestId: AcpRequestId;
}

export type AcpUnknownExtensionPolicy = 'reject' | 'standard';

export interface CreateAcpClientOptions {
  readonly stdout: Readable;
  readonly stdin: Writable;
  readonly stderr?: Readable;
  readonly schemaChannel: AcpSchemaChannel;
  readonly schemaProfile?: AcpSchemaProfile;
  /** Defaults to reject; standard ignores unknown extension notifications and rejects their requests. */
  readonly unknownExtensionPolicy?: AcpUnknownExtensionPolicy;
  readonly outboundRequestIdPrefix?: string;
  readonly limits?: Partial<AcpProtocolLimits>;
  readonly reverseRequestHandlers?: Readonly<Record<string, AcpReverseRequestHandler>>;
  readonly notificationHandlers?: Readonly<Record<string, AcpNotificationHandler>>;
  readonly extensions?: AcpExtensionRegistry;
  readonly now?: () => number;
  readonly onFatalError?: (error: Error) => void;
  readonly disposeTransport?: () => void | Promise<void>;
}

export interface AcpRequestOptions {
  readonly timeoutMs?: number;
  readonly deadlineAt?: number | Date;
  readonly signal?: AbortSignal;
  /** Runs synchronously after local admission and immediately before the transport write. */
  readonly onRequestDispatch?: (context: AcpRequestDispatchContext) => void;
  /** Runs synchronously after response validation, before promise settlement and the next frame. */
  readonly onResponseReceived?: (response: AcpResponseReceived) => void;
}

export interface AcpClientCloseResult {
  readonly kind: 'disposed' | 'peer_closed' | 'fatal';
  readonly error?: Error;
}

export interface AcpClient {
  readonly request: (
    method: string,
    params: AcpJsonValue,
    options?: AcpRequestOptions,
  ) => Promise<AcpJsonValue>;
  readonly notify: (method: string, params: AcpJsonValue) => Promise<void>;
  readonly diagnostics: () => readonly string[];
  readonly closed: Promise<AcpClientCloseResult>;
  readonly dispose: () => Promise<void>;
}
