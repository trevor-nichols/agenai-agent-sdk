// ------------------------------------------------------------------------------------------------
//                instance.ts - One materialized Claude instance: tool owner, readiness and session opening
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseAgentProviderConversationId, parseAgentSessionBinding, parseAgentSessionOpenInput, type AgentInstanceId, type AgentProviderKey,
} from '@agen-ai/agent-protocol';
import {
  createAgentProviderReadiness, createAgentProviderSessionCleanupError, type AgentProviderCreateSessionInput, type AgentProviderSession,
  type MaterializedAgentProviderInstance,
} from '@agen-ai/agent-runtime';
import { NodeProviderCleanupError } from '@agen-ai/provider-tools';
import { nodeProviderToolDefinitions, type NodeProviderToolOwner, type NodeProviderToolSession } from '@agen-ai/provider-tools/node';
import { CLAUDE_CODE_VERSION } from '../index.js';
import { claudeCapabilities } from './capabilities.js';
import type { ParsedClaudeOptions } from './options.js';
import { NodeClaudeProviderError, WorkerFailure } from './errors.js';
import { startWorker, WorkerCleanupFailure, type WorkerProcess } from './process.js';
import { WORKER_PROTOCOL } from './protocol.js';
import { createClaudeSession } from './session.js';
import { ownedToolNames } from './turn.js';

const MAX_TURNS = 32;

/** The complete Claude Code environment; nothing is inherited from the controller process. */
function claudeEnvironment(options: ParsedClaudeOptions, paths: Readonly<{ home: string; config: string; temporary: string }>) {
  return {
    ANTHROPIC_API_KEY: options.apiKey, ANTHROPIC_BASE_URL: options.apiBaseUrl,
    CLAUDE_CONFIG_DIR: paths.config, CLAUDE_CODE_TMPDIR: paths.temporary, HOME: paths.home, TMPDIR: paths.temporary,
    PATH: '/usr/bin:/bin', SHELL: '/bin/bash', LANG: 'C.UTF-8',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  };
}

export interface ClaudeInstanceInput {
  readonly providerKey: AgentProviderKey;
  readonly instanceId: AgentInstanceId;
  readonly model: string;
  readonly options: ParsedClaudeOptions;
  readonly sdkEntry: string;
  readonly owner: NodeProviderToolOwner;
  readonly onDisposed: () => void;
}

export function materializeClaudeInstance(input: ClaudeInstanceInput): MaterializedAgentProviderInstance {
  const { owner, providerKey } = input;
  const definitions = nodeProviderToolDefinitions();
  const owned = ownedToolNames(definitions.map((definition) => definition.name));
  let session: AgentProviderSession | undefined;
  let opening: Promise<AgentProviderSession> | undefined;
  /** The cleanup of a failed opening that did not settle; it blocks reuse and runs before disposal. */
  let failedOpening: (() => Promise<void>) | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const open = async (openingInput: AgentProviderCreateSessionInput, editApproval: 'automatic' | 'host'): Promise<AgentProviderSession> => {
    const parsed = parseAgentSessionOpenInput({ operation: 'create', sessionId: openingInput.sessionId, configuration: openingInput.configuration });
    if (parsed.configuration.kind !== 'managed') throw new NodeClaudeProviderError('invalid_session', 'Claude sessions use managed configuration.');
    const tools: NodeProviderToolSession = await owner.openSession({ editApproval }).catch((error: unknown) => {
      if (!(error instanceof NodeProviderCleanupError)) throw error;
      throw createAgentProviderSessionCleanupError({ providerKey, openingInput, errors: [error.cause, error.cleanupError], retryCleanup: error.retryCleanup });
    });
    let worker: WorkerProcess | undefined;
    let directory: string | undefined;
    let workerClosed = false;
    let toolsClosed = false;
    let pending: Promise<void> | undefined;
    // The private directory holds the worker's home and temporary files, so it outlives both owners.
    const settleResources = async () => {
      const errors: unknown[] = [];
      if (worker && !workerClosed) try { await worker.close(); workerClosed = true; } catch (error) { errors.push(error); }
      if (!toolsClosed) try { await tools.close(); toolsClosed = true; } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Claude session resources did not settle.');
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    };
    const cleanup = (): Promise<void> => {
      pending ??= settleResources().then(() => { if (failedOpening === cleanup) failedOpening = undefined; })
        .finally(() => { pending = undefined; });
      return pending;
    };
    try {
      openingInput.signal?.throwIfAborted();
      await owner.assertNativeUnchanged();
      directory = await mkdtemp(join(owner.stateDirectory, 'claude-session-'));
      const paths = { home: join(directory, 'home'), config: join(directory, 'config'), temporary: join(directory, 'tmp'), native: join(directory, 'native') };
      for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
      const started = await startWorker({
        directory, home: paths.home, temporary: paths.temporary, signal: openingInput.signal,
        configure: {
          type: 'configure', protocol: WORKER_PROTOCOL, sdkEntry: input.sdkEntry, executable: owner.nativeExecutablePath, cwd: paths.native,
          model: input.model, maxTurns: MAX_TURNS, environment: claudeEnvironment(input.options, paths),
          ...(input.options.usageLimits.maxBudgetUsdPerSession === undefined ? {} : { maxBudgetUsd: input.options.usageLimits.maxBudgetUsdPerSession }),
          tools: definitions.map((definition) => ({ name: definition.name, description: definition.description, inputSchema: { ...definition.inputSchema } })),
        },
      }).catch((error: unknown) => {
        if (error instanceof WorkerCleanupFailure) worker = Object.freeze({ listen() {}, send() { throw error; }, close: error.retryCleanup });
        throw error;
      });
      worker = started.worker;
      if (started.tools.length !== owned.size || started.tools.some((tool) => !owned.has(tool))) {
        throw new WorkerFailure('startup', 'Claude did not report exactly the owned tool server.');
      }
      const binding = parseAgentSessionBinding({ conversationId: parseAgentProviderConversationId(`claude:${randomUUID()}`) });
      const sessionDirectory = directory;
      const live = createClaudeSession({
        providerKey, openingInput, sessionId: parsed.sessionId, binding, tools, worker: started.worker, ownedTools: owned, model: input.model,
        approvalPolicy: openingInput.approvalPolicy ? Object.freeze({ policy: Object.freeze({ kind: openingInput.approvalPolicy.kind }), verification: 'controlled_configuration' as const }) : undefined,
        release: async () => {
          await rm(sessionDirectory, { recursive: true, force: true });
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
    if (disposed) return Promise.reject(new NodeClaudeProviderError('closed', 'The Claude instance is disposed.'));
    if (session || opening || failedOpening) {
      return Promise.reject(new NodeClaudeProviderError('session_active', failedOpening
        ? 'A failed session opening is still owned; settle its cleanup first.' : 'The Claude instance already has a live session.'));
    }
    const policy = openingInput.approvalPolicy?.kind;
    if (openingInput.workingDirectory !== owner.workspace.workspaceDirectory || openingInput.output !== undefined
      || openingInput.hostBinding !== undefined || openingInput.interactions !== undefined
      || (policy !== undefined && policy !== 'host' && policy !== 'provider_accept_edits')) {
      return Promise.reject(new NodeClaudeProviderError('invalid_session', 'Claude sessions open fresh in the bound workspace with host or provider_accept_edits approval only.'));
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
    capabilities: claudeCapabilities(providerKey),
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
      if (disposed) return createAgentProviderReadiness({ status: 'unavailable', checkedAt, reason: { category: 'provider', code: 'instance_disposed', message: 'The Claude instance is disposed.', recovery: { kind: 'none' } } });
      try { await owner.assertNativeUnchanged(); } catch {
        return createAgentProviderReadiness({ status: 'unavailable', checkedAt, reason: { category: 'provider', code: 'native_changed', message: 'The verified Claude Code executable changed or became unreadable.', recovery: { kind: 'none' } } });
      }
      return createAgentProviderReadiness({ status: 'ready', checkedAt, version: CLAUDE_CODE_VERSION });
    },
    dispose() {
      disposal ??= settle().catch((error: unknown) => { disposal = undefined; throw error; });
      return disposal;
    },
  });
}
