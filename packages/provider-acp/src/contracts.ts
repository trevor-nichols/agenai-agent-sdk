import type { Readable, Writable } from 'node:stream';
import type { AgentInstanceId, AgentSessionId } from '@agen-ai/agent-protocol';
import type { AgentSessionHostBinding, MaybePromise } from '@agen-ai/agent-runtime';
import type { AcpProviderLimits } from './limits.js';
import type { AcpStandardMcpServer, AcpUnknownExtensionPolicy } from '@agen-ai/acp-transport';
import type { AcpAuthenticationMethods, AcpHostFacilities } from './host/contracts.js';

export type { AcpProviderLimits } from './limits.js';

export interface AcpConnectionStreams {
  readonly stdout: Readable;
  readonly stdin: Writable;
  readonly stderr?: Readable;
}

/** Owned release callbacks must be idempotent; failed cleanup can be explicitly retried. */
export type AcpConnectionLease = AcpConnectionStreams & (
  | Readonly<{ ownership: 'owned'; release: () => MaybePromise<void> }>
  | Readonly<{ ownership: 'borrowed' }>
);

export interface AcpConnectionFactoryContext {
  readonly instanceId: AgentInstanceId;
  readonly signal?: AbortSignal;
}

/** Every invocation must return fresh streams exclusively reserved for this connection. */
export type AcpConnectionFactory = (
  context: AcpConnectionFactoryContext,
) => MaybePromise<AcpConnectionLease>;

export interface AcpSessionMcpBindingContext {
  readonly instanceId: AgentInstanceId;
  readonly sessionId: AgentSessionId;
  readonly workingDirectory: string;
  readonly operation: 'create' | 'resume';
  /** Validated session-local facade. Its original lifetime belongs to the runtime. */
  readonly hostBinding: AgentSessionHostBinding;
  /** Bounds acquisition; a late result remains owned and must still be released. */
  readonly signal: AbortSignal;
}

/** Release must quiesce its actual producers and be idempotent after successful cleanup. */
export interface AcpSessionMcpBindingLease {
  readonly mcpServers: readonly AcpStandardMcpServer[];
  readonly release: () => MaybePromise<void>;
}

/** Return a fresh exclusive lease. Rejection leaves no producers; partial acquisition returns an owned lease. */
export type AcpSessionMcpBindingFactory = (
  context: AcpSessionMcpBindingContext,
) => MaybePromise<AcpSessionMcpBindingLease>;

export interface AcpSessionMcpBindingOptions {
  /** Host-certified bridge transport. Every returned server must use this exact transport. */
  readonly transport: 'http' | 'sse';
  /** Installs the binding's tools and tool_context instructions; never releases the runtime binding. */
  readonly create: AcpSessionMcpBindingFactory;
}

export interface CreateAcpProviderDriverOptions {
  readonly providerKey: string;
  readonly createConnection: AcpConnectionFactory;
  /** Defaults to standard handling of unknown optional vendor extensions. */
  readonly unknownExtensionPolicy?: AcpUnknownExtensionPolicy;
  readonly limits?: Partial<AcpProviderLimits>;
  readonly configuration?: 'managed' | 'selectable';
  readonly authentication?: AcpAuthenticationMethods;
  readonly host?: AcpHostFacilities;
  /** Host-approved setup sent to the peer; this is not an observed MCP inventory. */
  readonly mcpServers?: readonly AcpStandardMcpServer[];
  readonly sessionMcpBinding?: AcpSessionMcpBindingOptions;
}
