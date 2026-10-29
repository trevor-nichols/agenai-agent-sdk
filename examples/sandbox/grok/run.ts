import type { AcpJsonObject, AcpJsonValue, AcpNotificationHandler, AcpProtocolLimits } from '@agen-ai/acp-transport';
import type { Sandbox } from '@agen-ai/sandbox';
import { captureSandboxRecipeFields, parseSandboxCliPrompt } from '../credentials/index.js';
import { createSandboxGrokClient } from './client.js';
import { reserveSandboxGrok } from './launch.js';
import type { SandboxGrokCredential, SandboxGrokInput } from './launch.js';
import type { SandboxAcpFileBudgets } from './requests.js';
import { captureBudgets } from './requests.js';

export interface SandboxGrokTurnInput {
  readonly launch: SandboxGrokInput<SandboxGrokCredential>;
  readonly task: string;
  readonly grant: Readonly<{ kind: 'read_only' | 'read_write' }>;
  readonly budgets: SandboxAcpFileBudgets;
  readonly limits?: Partial<AcpProtocolLimits>;
  /** Sensitive native updates. The observer must finish within the selected transport limits. */
  readonly onSessionUpdate: AcpNotificationHandler;
  /** A synchronous caller policy for one current tool call; persistent approval is never selected. */
  readonly allowPermission: (toolCall: AcpJsonObject) => boolean;
  readonly signal?: AbortSignal;
}

export class SandboxGrokRunError extends Error {
  constructor(readonly code: 'execution_failed' | 'cancelled' | 'cleanup_failed', private readonly cleanup: () => Promise<void>) {
    super('The sandbox Grok turn did not settle successfully; retain the original sandbox owner.');
    this.name = 'SandboxGrokRunError';
    Object.defineProperty(this, 'cleanup', { enumerable: false });
  }
  retryCleanup(): Promise<void> { return this.cleanup(); }
}

/** One process, one ACP reader and one turn; stops the whole sandbox before the caller exports. */
export async function runSandboxGrokTurn(sandbox: Sandbox, input: SandboxGrokTurnInput) {
  const fields = captureSandboxRecipeFields(input, ['launch', 'task', 'grant', 'budgets', 'onSessionUpdate', 'allowPermission'], ['limits', 'signal']);
  const task = parseSandboxCliPrompt(fields.task);
  if (typeof fields.onSessionUpdate !== 'function' || typeof fields.allowPermission !== 'function'
    || (fields.signal !== undefined && !(fields.signal instanceof AbortSignal))) {
    throw new TypeError('Select a Grok observer, once-only permission policy and optional cancellation signal.');
  }
  // Capture callback identity once; later caller replacement cannot change an entered turn's policy.
  const onSessionUpdate = input.onSessionUpdate;
  const allowPermission = input.allowPermission;
  const signal = input.signal;
  const grant = Object.freeze({ kind: input.grant.kind });
  if (grant.kind !== 'read_only' && grant.kind !== 'read_write') throw new TypeError('Select a Grok file grant.');
  const budgets = captureBudgets(input.budgets);
  const limits = input.limits === undefined ? undefined : Object.freeze({ ...input.limits });
  signal?.throwIfAborted();
  const { reservation, preflight } = await reserveSandboxGrok(sandbox, input.launch);
  let integration: ReturnType<typeof createSandboxGrokClient> | undefined;
  let sessionId: string | undefined;
  let active = false;
  let updates = 0; let permissionSelections = 0;
  let cleaning: Promise<void> | undefined;
  let cleaned = false;
  let writeFailed = false;
  let observerFailed = false;
  let transportFailed = false;
  const observers = new Set<Promise<void>>();
  let turnClosing: Promise<void> | undefined;
  const cleanup = () => {
    active = false;
    integration?.files.revoke();
    if (cleaned) return Promise.resolve();
    cleaning ??= (async () => {
      const disposing = integration?.client.dispose();
      const joining = integration?.files.close();
      const stopping = reservation.stop();
      const [owners, work] = await Promise.all([
        Promise.allSettled([disposing, stopping]),
        // The file scope rejects only with its persistent write failure, after every entered callback settled.
        // That is execution truth, not unfinished cleanup, so retry depends only on the original owners.
        Promise.allSettled([joining, turnClosing]),
      ]);
      if (work.some((outcome) => outcome.status === 'rejected')) writeFailed = true;
      if (owners.some((outcome) => outcome.status === 'rejected')) throw new SandboxGrokRunError('cleanup_failed', cleanup);
      if (integration !== undefined && (await integration.client.closed).kind === 'fatal') transportFailed = true;
      // Disposal bounds its notification drain; an overdue observer still belongs to this caller.
      if (observers.size > 0) throw new SandboxGrokRunError('cleanup_failed', cleanup);
      cleaned = true;
    })().finally(() => { cleaning = undefined; });
    return cleaning;
  };
  const abort = () => { active = false; integration?.files.revoke(); void cleanup().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let stopReason: string | undefined;
  let failed = false;
  try {
    signal?.throwIfAborted();
    const streams = await reservation.start(signal === undefined ? undefined : { signal });
    integration = createSandboxGrokClient({ streams, sandbox, grant, budgets,
      ...(limits === undefined ? {} : { limits }),
      onSessionUpdate(context) {
        const observing = (async () => {
          try {
            if (++updates > 4096) throw new Error('The Grok update count exceeded this example bound.');
            await onSessionUpdate(context);
          } catch (error) { observerFailed = true; throw error; }
        })();
        observers.add(observing);
        void observing.then(() => observers.delete(observing), () => observers.delete(observing));
        return observing;
      },
      onPermission(context) {
        const params = object(context.params);
        const toolCall = params === undefined ? undefined : object(params.toolCall);
        const options = params?.options;
        const once = Array.isArray(options) ? options.flatMap((option) => {
          const record = object(option);
          return record?.kind === 'allow_once' && typeof record.optionId === 'string' ? [record.optionId] : [];
        }) : [];
        const choice = once.length === 1 ? once[0] : undefined;
        if (!active || context.signal.aborted || signal?.aborted || params?.sessionId !== sessionId || toolCall === undefined
          || choice === undefined || permissionSelections >= 16 || allowPermission(toolCall) !== true) {
          return { outcome: { outcome: 'cancelled' } };
        }
        permissionSelections++;
        return { outcome: { outcome: 'selected', optionId: choice } };
      },
    });
    if (signal?.aborted) { abort(); signal.throwIfAborted(); }
    const { client, files } = integration;
    const request = (method: string, params: AcpJsonObject) => client.request(method, params,
      { lifetime: 'until_settled', ...(signal === undefined ? {} : { signal }) });
    const initialized = object(await request('initialize', { protocolVersion: 1,
      clientInfo: { name: 'agenai-sandbox-grok-example', version: '1.0.0' }, clientCapabilities: { ...files.capabilities } }));
    const authMethods = initialized?.authMethods;
    if (object(initialized?._meta)?.agentVersion !== '1.0.62' || !Array.isArray(authMethods)
      || !authMethods.some((method) => object(method)?.id === (preflight.credentialRoute === 'api_key' ? 'xai.api_key' : 'cached_token'))) {
      throw new Error('Unexpected native Grok version or auth route.');
    }
    const session = object(await request('session/new', { cwd: sandbox.workspace, mcpServers: [],
      _meta: { clientFsRead: true, clientFsWrite: grant.kind === 'read_write', clientTerminal: false } }));
    if (typeof session?.sessionId !== 'string' || object(session.models)?.currentModelId !== 'grok-build-0.1') {
      throw new Error('Unexpected native Grok session.');
    }
    sessionId = session.sessionId;
    const turn = files.bindSession(sessionId).openTurn();
    active = true;
    try {
      const result = object(await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: task }] }));
      if (typeof result?.stopReason !== 'string' || !['end_turn', 'max_tokens', 'refusal', 'cancelled', 'max_turn_requests'].includes(result.stopReason)) {
        throw new Error('Unexpected native Grok turn result.');
      }
      stopReason = result.stopReason;
    } finally { active = false; turnClosing = turn.close(); void turnClosing.catch(() => {}); }
  } catch { failed = true; }
  finally { signal?.removeEventListener('abort', abort); }
  await cleanup();
  if (failed || writeFailed || observerFailed || transportFailed || stopReason === undefined) {
    throw new SandboxGrokRunError(signal?.aborted ? 'cancelled' : 'execution_failed', cleanup);
  }
  return Object.freeze({ preflight, stopReason, updates, permissionSelections });
}

function object(value: AcpJsonValue | undefined): AcpJsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
