import type { AgentAuthenticationFlow, AgentInstanceId } from '@agen-ai/agent-protocol';
import {
  createAgentAuthenticationOutput,
  throwIfAgentOperationAborted,
  type AgentProviderAuthentication,
  type AgentProviderAuthenticationStartInput,
  type AgentProviderOutput,
} from '@agen-ai/agent-runtime';
import type { AcpInitializedConnection } from '../connection/contracts.js';
import { AcpProviderConnectionError } from '../connection/errors.js';
import type { AcpHostFacilities } from '../host/contracts.js';
import { awaitHost, hostDeadline } from '../host/lifecycle.js';
import { AcpHostLeases } from '../host/leases.js';
import { hostExitStatus } from '../host/validation.js';
import type { AcpProviderLimits } from '../limits.js';
import type { AcpAuthenticationMethod } from './methods.js';

interface Attempt {
  readonly id: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  dispatched: boolean;
  expired: boolean;
  terminal: boolean;
}

export function createAcpAuthentication(input: {
  readonly instanceId: AgentInstanceId;
  readonly methods: ReadonlyMap<AgentAuthenticationFlow, AcpAuthenticationMethod>;
  readonly host: AcpHostFacilities;
  readonly limits: AcpProviderLimits;
  readonly lifetime: AbortSignal;
  readonly now: () => string;
  readonly acquire: (signal: AbortSignal) => Promise<AcpInitializedConnection>;
  readonly retain: (connection: AcpInitializedConnection) => void;
  readonly retire: (connection: AcpInitializedConnection) => Promise<void>;
}) {
  let active: Attempt | undefined;
  const terminals = new AcpHostLeases(input.limits.hostOperationTimeoutMs);
  const port: AgentProviderAuthentication = input.methods.size === 0 ? Object.freeze({ kind: 'unsupported' }) : Object.freeze({
    kind: 'supported',
    start: (context: AgentProviderAuthenticationStartInput) => start(context),
    async cancel(context) {
      throwIfAgentOperationAborted(context.signal);
      if (!active || active.id !== context.attemptId || active.terminal || context.providerLoginId !== undefined) {
        return { status: 'failed', error: { category: 'invalid_request', code: 'authentication_attempt_not_active', message: 'The authentication attempt is not active.', recovery: { kind: 'none' } } };
      }
      const attempt = active;
      attempt.expired = context.reason === 'timeout';
      attempt.controller.abort(new DOMException('Authentication canceled.', 'AbortError'));
      await attempt.settled;
      return attempt.dispatched && !attempt.terminal
        ? { status: 'failed', error: { category: 'unknown', code: 'authentication_outcome_uncertain', message: 'Authentication was interrupted after native execution began.', recovery: { kind: 'unknown' } } }
        : { status: 'canceled' };
    },
  });

  async function* start(context: AgentProviderAuthenticationStartInput): AsyncGenerator<AgentProviderOutput> {
    throwIfAgentOperationAborted(context.signal);
    throwIfAgentOperationAborted(input.lifetime);
    if (active) throw new AcpProviderConnectionError('acp_authentication_active', 'An ACP authentication attempt is already active.');
    if (terminals.size) throw new AcpProviderConnectionError('acp_authentication_cleanup_pending', 'Authentication terminal cleanup must complete before another attempt.');
    const method = input.methods.get(context.flow);
    if (!method) throw new TypeError('The ACP authentication flow is unsupported.');
    let settle!: () => void;
    const attempt: Attempt = { id: context.attemptId, controller: new AbortController(),
      settled: new Promise<void>((resolve) => { settle = resolve; }), resolve: () => settle(),
      dispatched: false, expired: false, terminal: false };
    active = attempt;
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const result = runAttempt(context, method, attempt, started);
    // Work and cleanup settle independently of the consumer's progress-stream pace.
    void result.catch(() => undefined);
    try {
      await admitted;
      yield createAgentAuthenticationOutput({ attemptId: context.attemptId, status: 'awaiting_user', occurredAt: input.now() });
      yield await result;
    } finally {
      if (active === attempt) attempt.controller.abort(new DOMException('Authentication observer closed.', 'AbortError'));
      await attempt.settled;
    }
  }

  async function runAttempt(
    context: AgentProviderAuthenticationStartInput,
    method: AcpAuthenticationMethod,
    attempt: Attempt,
    started: () => void,
  ): Promise<AgentProviderOutput> {
    const parent = AbortSignal.any([input.lifetime, attempt.controller.signal, ...(context.signal ? [context.signal] : [])]);
    const remaining = context.deadlineAt ? Date.parse(context.deadlineAt) - Date.now() : input.limits.authenticationTimeoutMs;
    const deadline = hostDeadline(parent, Math.max(0, Math.min(input.limits.authenticationTimeoutMs, remaining)));
    let connection: AcpInitializedConnection | undefined;
    let terminalRelease: (() => Promise<void>) | undefined;
    let releaseAttempted = false;
    let succeeded = false;
    let cleanupFailed = false;
    try {
      connection = await input.acquire(deadline.signal);
      throwIfAgentOperationAborted(deadline.signal);
      const scope = { kind: 'authentication' as const, attemptId: context.attemptId, flow: context.flow };
      if (method.type === 'agent') {
        const operation = connection.requestWithScope('authenticate', { methodId: method.methodId }, scope, {
          signal: deadline.signal, timeoutMs: Math.max(1, Math.min(input.limits.authenticationTimeoutMs, remaining)),
          onRequestDispatch: () => { attempt.dispatched = true; },
          onResponseReceived: () => { attempt.terminal = true; },
        });
        started();
        await operation;
      } else {
        await input.retire(connection);
        connection = undefined;
        attempt.dispatched = true;
        started();
        const { lease, release } = await terminals.acquire((signal) => input.host.authenticateInTerminal!({
          instanceId: input.instanceId, scope, signal, methodId: method.methodId, args: method.args, env: method.env,
        }), deadline.signal, deadline.signal, (lease) => { if (lease?.exited) void Promise.resolve(lease.exited).catch(() => undefined); });
        terminalRelease = release;
        if (!lease || typeof lease.release !== 'function' || !lease.exited || typeof lease.exited.then !== 'function') {
          throw new TypeError('The authentication terminal lease is invalid.');
        }
        const status = hostExitStatus(await awaitHost(lease.exited, deadline.signal));
        if (status.exitCode !== 0 || status.signal !== undefined) throw new AcpProviderConnectionError('acp_authentication_terminal_failed', 'The authentication terminal did not exit successfully.');
        releaseAttempted = true;
        await terminalRelease();
        connection = await input.acquire(deadline.signal);
        attempt.terminal = true;
      }
      throwIfAgentOperationAborted(deadline.signal);
      input.retain(connection);
      succeeded = true;
    } catch {
      // Native diagnostic content and host exceptions never enter canonical progress.
    } finally {
      if (!succeeded) {
        const cleanup = await Promise.allSettled([
          ...(terminalRelease && !releaseAttempted ? [terminalRelease()] : []),
          ...(connection ? [input.retire(connection)] : []),
        ]);
        cleanupFailed = cleanup.some((result) => result.status === 'rejected');
      }
      started();
      deadline.close();
      active = undefined;
      attempt.resolve();
    }
    if (succeeded) return createAgentAuthenticationOutput({ attemptId: context.attemptId, status: 'completed', occurredAt: input.now() });
    const interrupted = parent.aborted || deadline.signal.aborted;
    const uncertain = attempt.dispatched && !attempt.terminal;
    const failed = uncertain || cleanupFailed || !interrupted;
    const expired = attempt.expired || (!parent.aborted && deadline.signal.aborted);
    return createAgentAuthenticationOutput({ attemptId: context.attemptId,
      status: failed ? 'failed' : expired ? 'expired' : 'canceled', occurredAt: input.now(),
      ...(failed ? { error: {
        category: 'unknown',
        code: uncertain ? 'authentication_outcome_uncertain' : 'authentication_failed',
        message: uncertain ? 'Authentication ended without a confirmed native result.' : 'The authentication operation failed.',
        recovery: { kind: 'unknown' },
      } } : {}),
    });
  }
  return { port, get active() { return active !== undefined; }, get cleanupPending() { return terminals.size > 0; },
    async close() {
      if (active) {
        const attempt = active;
        attempt.controller.abort(input.lifetime.reason);
        await attempt.settled;
        if (terminals.size) throw new AcpProviderConnectionError('acp_authentication_cleanup_pending', 'Authentication terminal cleanup failed.');
        return;
      }
      await terminals.close();
    } };
}
