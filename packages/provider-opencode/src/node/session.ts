// ------------------------------------------------------------------------------------------------
//                session.ts - One live OpenCode session over one owned server and one owned tool session
// ------------------------------------------------------------------------------------------------

import type { AgentError, AgentProviderKey, AgentSessionBinding, AgentSessionId } from '@agen-ai/agent-protocol';
import {
  AgentProviderContractError, createAgentProviderSessionCleanupError, type AgentProviderCreateSessionInput, type AgentProviderOutput,
  type AgentProviderSession, type AgentProviderResolveRequestInput, type AgentProviderStartTurnInput, type AgentRequestResolutionResult,
  type AgentSessionApprovalPolicy,
} from '@agen-ai/agent-runtime';
import type { NodeProviderToolSession } from '@agen-ai/provider-tools/node';
import type { NodeOpenCodeModelProvider } from '../index.js';
import type { NativeSession } from './native.js';
import { ActiveTurn, type TurnHost } from './turn.js';
import { isUsageEvent, OpenCodeUsage, type UsageEvent } from './usage.js';

const UNSUPPORTED = Object.freeze({ kind: 'unsupported' as const });
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PROMPT_CHARACTERS = 131_072;

export interface OpenCodeSessionInput {
  readonly providerKey: AgentProviderKey;
  readonly openingInput: AgentProviderCreateSessionInput;
  readonly sessionId: AgentSessionId;
  readonly binding: AgentSessionBinding;
  readonly approvalPolicy: AgentSessionApprovalPolicy | undefined;
  readonly tools: NodeProviderToolSession;
  readonly native: NativeSession;
  /** The configured route and model every native step must run on. */
  readonly model: Readonly<{ provider: NodeOpenCodeModelProvider; id: string }>;
  /** Removes the session's private native state once both owners are joined. */
  readonly release: () => Promise<void>;
}

class TurnRefused extends Error {
  constructor(readonly error: AgentError) {
    super(error.message);
    this.name = 'NodeOpenCodeTurnRefused';
  }
}

const refusal = (code: string, message: string) =>
  new TurnRefused({ category: 'invalid_request', code, message, recovery: { kind: 'none' } });

function promptText(input: AgentProviderStartTurnInput): string {
  if (input.output !== undefined) throw refusal('structured_output_unsupported', 'OpenCode sessions do not support structured output.');
  if (input.interactionMode !== 'default') throw refusal('interaction_mode_unsupported', 'OpenCode sessions support only the default interaction mode.');
  const texts = input.parts.map((part) => {
    if (part.type !== 'text') throw refusal('input_unsupported', 'OpenCode sessions accept text input only.');
    return part.text;
  });
  const text = texts.join('\n\n');
  if (!text.trim() || text.length > PROMPT_CHARACTERS) throw refusal('input_invalid', 'Turn text must be non-empty and bounded.');
  return text;
}

/**
 * The session is unusable after any native failure, drift, abandoned or unconfirmed turn. Closing
 * always stops tools before the server, then joins native control requests, and keeps both owners
 * until each is joined.
 */
export function createOpenCodeSession(input: OpenCodeSessionInput): AgentProviderSession {
  let state: 'idle' | 'running' | 'closing' | 'closed' = 'idle';
  let failure: string | undefined;
  let active: ActiveTurn | undefined;
  let closing: Promise<void> | undefined;
  let toolsClosed = false;
  let nativeClosed = false;
  const host: TurnHost = {
    sessionId: input.sessionId, tools: input.tools, native: input.native, nativeRefs: new Set(), controls: new Set(),
    usage: new OpenCodeUsage(input.providerKey, input.model.provider, input.model.id),
    fail(reason) { failure ??= reason; },
  };

  /** Session totals arriving between turns wait for the next turn; a model step outside a turn is a sequence violation. */
  const accountIdle = (event: UsageEvent) => {
    try {
      if (!host.usage.admit(event)) failure ??= 'opencode_model_drift';
    } catch (cause) {
      if (!(cause instanceof AgentProviderContractError)) throw cause;
      failure ??= cause.code;
    }
  };

  input.native.listen((signal) => {
    if (active) { active.receive(signal); return; }
    if (signal.type === 'cancel') return;
    if (signal.type === 'call') {
      try { input.native.reply(signal.call.id, { text: 'Tool call refused: no turn is active.', isError: true }); }
      catch { /* the endpoint reports its own failure */ }
    }
    if (signal.type === 'event' && signal.event.kind === 'benign') return;
    if (signal.type === 'event' && isUsageEvent(signal.event)) { accountIdle(signal.event); return; }
    failure ??= signal.type === 'event' ? `native_${signal.event.kind}_outside_turn` : `native_${signal.type}_outside_turn`;
  });

  const startTurn: AgentProviderSession['startTurn'] = (turnInput) => {
    if (state !== 'idle') throw refusal('turn_unavailable', state === 'running' ? 'A turn is already active.' : 'The session is closed.');
    if (failure) throw new TurnRefused({ category: 'provider', code: 'session_failed', message: `The OpenCode session is no longer usable (${failure}).`, recovery: { kind: 'none' } });
    const prompt = promptText(turnInput);
    const turn = new ActiveTurn(host, turnInput.turnId);
    active = turn;
    state = 'running';
    const interrupt = () => turn.interrupt('interrupted');
    let deadline: NodeJS.Timeout | undefined;
    if (turnInput.signal?.aborted) { turn.ending = 'interrupted'; turn.abort.abort(); }
    else turnInput.signal?.addEventListener('abort', interrupt, { once: true });
    if (turnInput.deadlineAt !== undefined) {
      const expiresAt = Date.parse(turnInput.deadlineAt);
      const checkDeadline = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) { turn.interrupt('expired'); return; }
        // Node turns delays above its signed 32-bit limit into a 1 ms timeout.
        deadline = setTimeout(checkDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
        deadline.unref();
      };
      checkDeadline();
    }
    async function* outputs(): AsyncGenerator<AgentProviderOutput> {
      let completed = false;
      try {
        for await (const output of turn.run(prompt, turnInput.onProviderExecutionStarted)) {
          if (output.kind === 'event' && output.event.type === 'turn.completed') completed = true;
          yield output;
        }
      } finally {
        clearTimeout(deadline);
        turnInput.signal?.removeEventListener('abort', interrupt);
        if (!completed) { failure ??= 'turn_abandoned'; turn.abandon(); }
        else host.usage.finishTurn(turnInput.turnId);
        active = undefined;
        if (state === 'running') state = 'idle';
      }
    }
    return Object.freeze({
      turnId: turnInput.turnId,
      outputs: outputs(),
      resolveRequest: async (resolution: AgentProviderResolveRequestInput): Promise<AgentRequestResolutionResult> => active === turn
        ? turn.resolveRequest(resolution)
        : { status: 'rejected', requestState: 'unavailable',
          error: { category: 'invalid_request', code: 'request_unavailable', message: 'The turn is no longer active.', recovery: { kind: 'none' } } },
    });
  };

  const close = (): Promise<void> => {
    if (state === 'closed') return Promise.resolve();
    closing ??= (async () => {
      state = 'closing';
      active?.stop('The session closed.');
      const errors: unknown[] = [];
      if (!toolsClosed) try { await input.tools.close(); toolsClosed = true; } catch (error) { errors.push(error); }
      if (!nativeClosed) try { await input.native.close(); nativeClosed = true; } catch (error) { errors.push(error); }
      await Promise.all(host.controls);
      if (!errors.length) try { await input.release(); } catch (error) { errors.push(error); }
      if (errors.length) {
        throw createAgentProviderSessionCleanupError({ providerKey: input.providerKey, openingInput: input.openingInput, errors, retryCleanup: close });
      }
      state = 'closed';
    })().catch((error: unknown) => { closing = undefined; throw error; });
    return closing;
  };

  return Object.freeze<AgentProviderSession>({
    binding: input.binding,
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    startTurn,
    interruption: Object.freeze({
      kind: 'supported' as const,
      interruptTurn: (interruptInput) => {
        if (active?.turnId !== interruptInput.turnId) return { status: 'completed' as const };
        active.interrupt('interrupted');
        return { status: 'accepted' as const };
      },
    }),
    steering: UNSUPPORTED,
    configuration: Object.freeze({ kind: 'managed' as const }),
    operations: UNSUPPORTED,
    managedContent: UNSUPPORTED,
    environment: UNSUPPORTED,
    collaboration: UNSUPPORTED,
    generatedResources: UNSUPPORTED,
    close,
  });
}
