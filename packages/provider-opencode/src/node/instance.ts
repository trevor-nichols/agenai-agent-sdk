// ------------------------------------------------------------------------------------------------
//                instance.ts - One materialized OpenCode instance: tool owner, readiness and session opening
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import {
  parseAgentProviderConversationId, parseAgentSessionBinding, parseAgentSessionOpenInput, type AgentInstanceId, type AgentProviderKey,
} from '@agen-ai/agent-protocol';
import {
  createAgentProviderReadiness, createAgentProviderSessionCleanupError, type AgentProviderCreateSessionInput, type AgentProviderSession,
  type MaterializedAgentProviderInstance,
} from '@agen-ai/agent-runtime';
import { NodeProviderCleanupError } from '@agen-ai/provider-tools';
import { nodeProviderToolDefinitions, type NodeProviderToolOwner, type NodeProviderToolSession } from '@agen-ai/provider-tools/node';
import { OPENCODE_VERSION } from '../index.js';
import { openCodeCapabilities } from './capabilities.js';
import { createNativeLayout, type NativeLayout } from './config.js';
import { NodeOpenCodeProviderError } from './errors.js';
import { openNativeSession, type NativeSession } from './native.js';
import type { ParsedOpenCodeOptions } from './options.js';
import { NativeCleanupFailure } from './server.js';
import { createOpenCodeSession } from './session.js';

export interface OpenCodeInstanceInput {
  readonly providerKey: AgentProviderKey;
  readonly instanceId: AgentInstanceId;
  readonly model: string;
  readonly options: ParsedOpenCodeOptions;
  readonly owner: NodeProviderToolOwner;
  readonly onDisposed: () => void;
}

/** The read-only plugin copy is restored to writable first so its private layout can be removed. */
async function removeLayout(layout: NativeLayout): Promise<void> {
  await chmod(layout.plugin, 0o700).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  await rm(layout.root, { recursive: true, force: true });
}

export function materializeOpenCodeInstance(input: OpenCodeInstanceInput): MaterializedAgentProviderInstance {
  const { owner, providerKey } = input;
  const definitions = nodeProviderToolDefinitions();
  let session: AgentProviderSession | undefined;
  let opening: Promise<AgentProviderSession> | undefined;
  /** The cleanup of a failed opening that did not settle; it blocks reuse and runs before disposal. */
  let failedOpening: (() => Promise<void>) | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const open = async (openingInput: AgentProviderCreateSessionInput, editApproval: 'automatic' | 'host'): Promise<AgentProviderSession> => {
    const parsed = parseAgentSessionOpenInput({ operation: 'create', sessionId: openingInput.sessionId, configuration: openingInput.configuration });
    if (parsed.configuration.kind !== 'managed') throw new NodeOpenCodeProviderError('invalid_session', 'OpenCode sessions use managed configuration.');
    const tools: NodeProviderToolSession = await owner.openSession({ editApproval }).catch((error: unknown) => {
      if (!(error instanceof NodeProviderCleanupError)) throw error;
      throw createAgentProviderSessionCleanupError({ providerKey, openingInput, errors: [error.cause, error.cleanupError], retryCleanup: error.retryCleanup });
    });
    let native: Pick<NativeSession, 'close'> | undefined;
    let layout: NativeLayout | undefined;
    let nativeClosed = false;
    let toolsClosed = false;
    let pending: Promise<void> | undefined;
    // The private layout holds the server's home, state and endpoint, so it outlives both owners.
    const settleResources = async () => {
      const errors: unknown[] = [];
      if (native && !nativeClosed) try { await native.close(); nativeClosed = true; } catch (error) { errors.push(error); }
      if (!toolsClosed) try { await tools.close(); toolsClosed = true; } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'OpenCode session resources did not settle.');
      if (layout) await removeLayout(layout);
      layout = undefined;
    };
    const cleanup = (): Promise<void> => {
      pending ??= settleResources().then(() => { if (failedOpening === cleanup) failedOpening = undefined; })
        .finally(() => { pending = undefined; });
      return pending;
    };
    try {
      openingInput.signal?.throwIfAborted();
      await owner.assertNativeUnchanged();
      layout = await createNativeLayout(owner.stateDirectory);
      const opened = await openNativeSession({
        executable: owner.nativeExecutablePath, layout, provider: input.options.provider, model: input.model,
        apiKey: input.options.apiKey, apiBaseUrl: input.options.apiBaseUrl, usageLimits: input.options.usageLimits, tools: definitions, signal: openingInput.signal,
      }).catch((error: unknown) => {
        if (error instanceof NativeCleanupFailure) native = Object.freeze({ close: error.retryCleanup });
        throw error;
      });
      native = opened;
      const binding = parseAgentSessionBinding({ conversationId: parseAgentProviderConversationId(`opencode:${randomUUID()}`) });
      const sessionLayout = layout;
      const live = createOpenCodeSession({
        providerKey, openingInput, sessionId: parsed.sessionId, binding, tools, native: opened,
        model: { provider: input.options.provider, id: input.model },
        approvalPolicy: openingInput.approvalPolicy ? Object.freeze({ policy: Object.freeze({ kind: openingInput.approvalPolicy.kind }), verification: 'controlled_configuration' as const }) : undefined,
        release: async () => {
          await removeLayout(sessionLayout);
          if (session === live) session = undefined;
        },
      });
      session = live;
      openingInput.onBindingCreated(binding);
      return live;
    } catch (cause) {
      session = undefined;
      failedOpening = cleanup;
      try { await cleanup(); } catch (cleanupError) {
        throw createAgentProviderSessionCleanupError({ providerKey, openingInput, errors: [cause, cleanupError], retryCleanup: cleanup });
      }
      throw cause;
    }
  };

  const createSession = (openingInput: AgentProviderCreateSessionInput): Promise<AgentProviderSession> => {
    if (disposed) return Promise.reject(new NodeOpenCodeProviderError('closed', 'The OpenCode instance is disposed.'));
    if (session || opening || failedOpening) {
      return Promise.reject(new NodeOpenCodeProviderError('session_active', failedOpening
        ? 'A failed session opening is still owned; settle its cleanup first.' : 'The OpenCode instance already has a live session.'));
    }
    const policy = openingInput.approvalPolicy?.kind;
    if (openingInput.workingDirectory !== owner.workspace.workspaceDirectory || openingInput.output !== undefined
      || openingInput.hostBinding !== undefined || openingInput.interactions !== undefined
      || (policy !== undefined && policy !== 'host' && policy !== 'provider_accept_edits')) {
      return Promise.reject(new NodeOpenCodeProviderError('invalid_session', 'OpenCode sessions open fresh in the bound workspace with host or provider_accept_edits approval only.'));
    }
    opening = open(openingInput, policy === 'provider_accept_edits' ? 'automatic' : 'host');
    return opening.finally(() => { opening = undefined; });
  };

  const settle = async () => {
    disposed = true;
    await opening?.catch(() => {});
    await failedOpening?.();
    if (session) await session.close({ reason: 'shutdown' });
    await owner.dispose();
    input.onDisposed();
  };

  return Object.freeze<MaterializedAgentProviderInstance>({
    instanceId: input.instanceId,
    capabilities: openCodeCapabilities(providerKey, input.options.provider),
    adapter: Object.freeze({
      approvalPolicy: Object.freeze({ kind: 'supported' as const, policies: Object.freeze([
        Object.freeze({ policy: 'host' as const, operations: Object.freeze(['create'] as const) }),
        Object.freeze({ policy: 'provider_accept_edits' as const, operations: Object.freeze(['create'] as const) }),
      ] as const) }),
      createSession,
      resumption: Object.freeze({ kind: 'unsupported' as const }),
      branching: Object.freeze({ kind: 'unsupported' as const }),
      authentication: Object.freeze({ kind: 'unsupported' as const }),
    }),
    accountQuota: Object.freeze({ kind: 'unsupported' as const }),
    environment: Object.freeze({ kind: 'unsupported' as const }),
    async checkReadiness() {
      const checkedAt = new Date().toISOString();
      if (disposed) return createAgentProviderReadiness({ status: 'unavailable', checkedAt, reason: { category: 'provider', code: 'instance_disposed', message: 'The OpenCode instance is disposed.', recovery: { kind: 'none' } } });
      try { await owner.assertNativeUnchanged(); } catch {
        return createAgentProviderReadiness({ status: 'unavailable', checkedAt, reason: { category: 'provider', code: 'native_changed', message: 'The verified OpenCode executable changed or became unreadable.', recovery: { kind: 'none' } } });
      }
      return createAgentProviderReadiness({ status: 'ready', checkedAt, version: OPENCODE_VERSION });
    },
    dispose() {
      disposal ??= settle().catch((error: unknown) => { disposal = undefined; throw error; });
      return disposal;
    },
  });
}
