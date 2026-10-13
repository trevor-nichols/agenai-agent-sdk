import { isAbsolute, normalize } from 'node:path';
import {
  parseAgentSessionOpenInput,
  type AgentInstanceId,
  type AgentProviderKey,
  type AgentSessionId,
} from '@agen-ai/agent-protocol';
import type { AcpJsonObject, AcpStandardMcpServer, AcpUnknownExtensionPolicy } from '@agen-ai/acp-transport';
import {
  createAgentProviderReadiness,
  createAgentProviderSessionCleanupError,
  isAgentProviderSessionCleanupErrorFor,
  throwIfAgentOperationAborted,
  type AgentProviderCreateSessionInput,
  type AgentProviderResumeSessionInput,
  type AgentProviderSession,
  type AgentProviderReadinessCheckInput,
  type MaterializedAgentProviderInstance,
} from '@agen-ai/agent-runtime';
import { createAcpAuthentication } from './auth/controller.js';
import { selectedAuthenticationMethods } from './auth/methods.js';
import { acpProviderCapabilities } from './capabilities.js';
import type { AcpConnectionFactory, AcpSessionMcpBindingOptions } from './contracts.js';
import type { AcpAuthenticationMethods, AcpHostFacilities } from './host/contracts.js';
import type { AcpProviderLimits } from './limits.js';
import type { AcpInitializedConnection } from './connection/contracts.js';
import { AcpProviderConnectionError } from './connection/errors.js';
import { initializeAcpConnection } from './connection/initialize.js';
import { negotiatedEnvelope } from './connection/negotiation.js';
import { assertAcpMcpSupport, supportsAcpSessionMcpBinding } from './mcp.js';
import { createAcpProviderSession } from './session/create.js';
import { AcpSessionResources } from './session/resources.js';

export async function createAcpProviderInstance(input: {
  readonly providerKey: AgentProviderKey;
  readonly instanceId: AgentInstanceId;
  readonly createConnection: AcpConnectionFactory;
  readonly unknownExtensionPolicy: AcpUnknownExtensionPolicy;
  readonly limits: AcpProviderLimits;
  readonly usedStreams: WeakSet<object>;
  readonly configuration: 'managed' | 'selectable';
  readonly authentication: AcpAuthenticationMethods;
  readonly host: AcpHostFacilities;
  readonly mcpServers: readonly AcpStandardMcpServer[];
  readonly sessionMcpBinding?: AcpSessionMcpBindingOptions;
}): Promise<MaterializedAgentProviderInstance> {
  const lifetime = new AbortController();
  const connect = (signal: AbortSignal) => initializeAcpConnection({
    createConnection: input.createConnection,
    unknownExtensionPolicy: input.unknownExtensionPolicy,
    context: { instanceId: input.instanceId, signal },
    limits: input.limits, usedStreams: input.usedStreams,
    configuration: input.configuration, authentication: input.authentication, host: input.host,
  });
  let eager: AcpInitializedConnection | undefined = await connect(lifetime.signal);
  const negotiated = eager.negotiated;
  let methods: ReturnType<typeof selectedAuthenticationMethods>;
  let capabilities: ReturnType<typeof acpProviderCapabilities>;
  try {
    assertAcpMcpSupport(input.mcpServers, negotiated);
    methods = selectedAuthenticationMethods(negotiated, input.authentication, input.host);
    capabilities = acpProviderCapabilities(input.providerKey, negotiated, input.configuration, [...methods.keys()]);
  } catch (cause) {
    try { await eager.close(); } catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'ACP materialization and cleanup failed.'); }
    throw cause;
  }
  const envelope = negotiatedEnvelope(negotiated);
  const connections = new Set<AcpInitializedConnection>([eager]);
  const resources = new Set<AcpSessionResources>();
  const sessions = new Map<AgentSessionId, AgentProviderSession>();
  const creatingIds = new Set<AgentSessionId>();
  const pending = new Set<Promise<AgentProviderSession>>();
  let disposePromise: Promise<void> | undefined;
  const cleanupPending = () => [...resources].some((resource) => resource.cleanupPending);
  const bindingSupported = supportsAcpSessionMcpBinding(input.sessionMcpBinding, negotiated);
  const now = () => new Date().toISOString();
  const retire = async (connection: AcpInitializedConnection) => {
    if (eager === connection) eager = undefined;
    await connection.close();
    connections.delete(connection);
  };
  const acquire = async (signal: AbortSignal) => {
    const reserved = eager;
    eager = undefined;
    const connection = reserved ?? await connect(signal);
    connections.add(connection);
    try {
      throwIfAgentOperationAborted(signal);
      if (negotiatedEnvelope(connection.negotiated) !== envelope) {
        throw new AcpProviderConnectionError('acp_provider_negotiation_changed', 'The ACP peer changed its initialized behavior envelope.');
      }
      return connection;
    } catch (cause) {
      try { await retire(connection); } catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'ACP negotiation and cleanup failed.'); }
      throw cause;
    }
  };
  const authentication = createAcpAuthentication({
    instanceId: input.instanceId, methods, host: input.host, limits: input.limits, lifetime: lifetime.signal, now,
    async acquire(signal) {
      if (cleanupPending()) throw new AcpProviderConnectionError('acp_session_cleanup_pending', 'Session resource cleanup must complete before authentication mutation.');
      if (sessions.size || pending.size) throw new AcpProviderConnectionError('acp_authentication_sessions_active', 'Authentication changes require an idle ACP instance.');
      return acquire(signal);
    },
    retain(connection) { throwIfAgentOperationAborted(lifetime.signal); eager = connection; },
    retire,
  });

  const open = async (context: AgentProviderCreateSessionInput | AgentProviderResumeSessionInput, resume: boolean): Promise<AgentProviderSession> => {
    throwIfAgentOperationAborted(context.signal);
    throwIfAgentOperationAborted(lifetime.signal);
    if (authentication.active) throw new AcpProviderConnectionError('acp_authentication_active', 'Authentication owns the ACP instance.');
    if (authentication.cleanupPending) throw new AcpProviderConnectionError('acp_authentication_cleanup_pending', 'Authentication terminal cleanup must complete before session mutation.');
    if (cleanupPending()) throw new AcpProviderConnectionError('acp_session_cleanup_pending', 'Session resource cleanup must complete before session mutation.');
    if (context.hostBinding !== undefined && !bindingSupported) throw new TypeError('The ACP peer does not support the configured session MCP binding.');
    const parsed = resume
      ? parseAgentSessionOpenInput({ operation: 'resume', sessionId: context.sessionId,
        binding: (context as AgentProviderResumeSessionInput).binding, configuration: context.configuration })
      : parseAgentSessionOpenInput({ operation: 'create', sessionId: context.sessionId, configuration: context.configuration });
    if ((input.configuration === 'managed') !== (parsed.configuration.kind === 'managed')) throw new TypeError('ACP session configuration does not match the frozen driver mode.');
    if (typeof context.workingDirectory !== 'string' || context.workingDirectory.length > 4_096
      || !isAbsolute(context.workingDirectory) || normalize(context.workingDirectory) !== context.workingDirectory
      || /[\p{Cc}\p{Cf}]/u.test(context.workingDirectory)) throw new TypeError('ACP session workingDirectory must be a canonical absolute path.');
    if (parsed.operation === 'resume' && parsed.binding.historyAnchor !== undefined) throw new TypeError('ACP cannot map a through-turn history anchor.');
    if (!resume && typeof (context as AgentProviderCreateSessionInput).onBindingCreated !== 'function') throw new TypeError('ACP session creation requires a binding observer.');
    if (sessions.has(parsed.sessionId) || creatingIds.has(parsed.sessionId)) {
      throw new AcpProviderConnectionError('acp_provider_session_duplicate', 'The instance already owns this session identity.');
    }
    creatingIds.add(parsed.sessionId);
    const signal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal;
    const operation = (async () => {
      let connection: AcpInitializedConnection | undefined;
      let resource: AcpSessionResources | undefined;
      let opened: AgentProviderSession | undefined;
      try {
        connection = await acquire(signal);
        const ownedConnection = connection;
        resource = new AcpSessionResources({ instanceId: input.instanceId,
          context: { ...context, sessionId: parsed.sessionId, configuration: parsed.configuration, signal },
          operation: resume ? 'resume' : 'create', connection, staticServers: input.mcpServers,
          ...(input.sessionMcpBinding ? { binding: input.sessionMcpBinding } : {}), limits: input.limits,
          onReleased: () => { resources.delete(resource!); connections.delete(ownedConnection); },
        });
        resources.add(resource);
        const mcpServers = await resource.mcpServers();
        throwIfAgentOperationAborted(signal);
        const closeResources = () => resource!.close();
        const sessionCapabilities = negotiated.agentCapabilities.sessionCapabilities as AcpJsonObject | undefined;
        const session = await createAcpProviderSession({
          context: { ...context, sessionId: parsed.sessionId, configuration: parsed.configuration, signal },
          openingInput: context,
          ...(parsed.operation === 'resume' ? { resume: { binding: parsed.binding,
            method: sessionCapabilities?.resume != null ? 'session/resume' as const : 'session/load' as const } } : {}),
          mcpServers,
          connection, capabilities, limits: input.limits, now,
          onClosed: () => { sessions.delete(parsed.sessionId); connections.delete(ownedConnection); },
          closeResources,
        });
        opened = session;
        throwIfAgentOperationAborted(signal);
        sessions.set(parsed.sessionId, session);
        return session;
      } catch (cause) {
        if (isAgentProviderSessionCleanupErrorFor(cause, context) && cause.providerKey === input.providerKey) throw cause;
        if (resource || connection) {
          const cleanup = () => opened ? opened.close({ reason: 'contract_rejected' })
            : resource ? resource.close() : retire(connection!);
          try { await cleanup(); }
          catch (cleanupError) {
            throw createAgentProviderSessionCleanupError({ providerKey: input.providerKey, openingInput: context,
              errors: [cause, cleanupError], retryCleanup: cleanup });
          }
        }
        throw cause;
      }
    })();
    pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); creatingIds.delete(parsed.sessionId); }
  };

  return Object.freeze({
    instanceId: input.instanceId,
    capabilities,
    adapter: Object.freeze({
      hostBinding: bindingSupported
        ? Object.freeze({ kind: 'supported' as const, toolTransport: 'mcp' as const, instructionPlacements: Object.freeze(['tool_context' as const]) })
        : Object.freeze({ kind: 'unsupported' as const }),
      createSession: (context: AgentProviderCreateSessionInput) => open(context, false),
      resumption: capabilities.sessions.resume
        ? Object.freeze({ kind: 'supported' as const, resumeSession: (context: AgentProviderResumeSessionInput) => open(context, true) })
        : Object.freeze({ kind: 'unsupported' as const }),
      branching: { kind: 'unsupported' as const },
      authentication: authentication.port,
    }),
    accountQuota: { kind: 'unsupported' as const },
    environment: { kind: 'unsupported' as const },
    checkReadiness(check: AgentProviderReadinessCheckInput = {}) {
      throwIfAgentOperationAborted(check.signal);
      const knownPeersStopped = connections.size > 0 && [...connections].every((connection) => connection.stopped.aborted);
      return createAgentProviderReadiness({
        status: lifetime.signal.aborted || knownPeersStopped || authentication.cleanupPending || cleanupPending() ? 'unavailable' : 'ready', checkedAt: now(),
        ...(negotiated.agentInfo ? { version: negotiated.agentInfo.version } : {}),
        diagnostics: { initialization: 'completed', authentication: 'not_checked', inference: 'not_checked' },
      });
    },
    dispose() {
      if (!disposePromise) {
        disposePromise = Promise.resolve().then(async () => {
          const failures = new Set<unknown>();
          const closingConnections = new Set(connections);
          const closing = await Promise.allSettled([
            authentication.close(),
            ...[...sessions.values()].map((session) => session.close({ reason: 'shutdown' })),
            ...[...resources].map((resource) => resource.close()),
            ...[...closingConnections].map((connection) => connection.close()),
          ]);
          for (const result of closing) if (result.status === 'rejected') failures.add(result.reason);
          await Promise.allSettled([...pending]);
          const remaining = await Promise.allSettled([...connections].filter((connection) => !closingConnections.has(connection)).map((connection) => connection.close()));
          for (const result of remaining) if (result.status === 'rejected') failures.add(result.reason);
          if (failures.size) throw new AggregateError(failures, 'ACP instance cleanup failed.');
          connections.clear(); sessions.clear();
        }).catch((error) => { disposePromise = undefined; throw error; });
        lifetime.abort(new AcpProviderConnectionError('acp_provider_instance_disposed', 'The ACP instance was disposed.'));
      }
      return disposePromise;
    },
  });
}
