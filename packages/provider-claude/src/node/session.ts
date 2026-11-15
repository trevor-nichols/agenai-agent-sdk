// ------------------------------------------------------------------------------------------------
//                session.ts - One live Claude session over one worker and one owned tool session
// ------------------------------------------------------------------------------------------------

import type { AgentError, AgentProviderKey, AgentSessionBinding, AgentSessionId } from '@agen-ai/agent-protocol';
import {
  createAgentProviderSessionCleanupError, type AgentProviderCreateSessionInput, type AgentProviderOutput, type AgentProviderSession,
  type AgentProviderResolveRequestInput, type AgentProviderStartTurnInput, type AgentRequestResolutionResult, type AgentSessionApprovalPolicy,
} from '@agen-ai/agent-runtime';
import type { NodeProviderToolSession } from '@agen-ai/provider-tools/node';
import type { WorkerProcess } from './process.js';
import { PROMPT_CHARACTERS } from './protocol.js';
import { ActiveTurn, type TurnHost } from './turn.js';
import { ClaudeUsage } from './usage.js';

const UNSUPPORTED = Object.freeze({ kind: 'unsupported' as const });
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ClaudeSessionInput {
  readonly providerKey: AgentProviderKey;
  readonly openingInput: AgentProviderCreateSessionInput;
  readonly sessionId: AgentSessionId;
  readonly binding: AgentSessionBinding;
  readonly approvalPolicy: AgentSessionApprovalPolicy | undefined;
  readonly tools: NodeProviderToolSession;
  readonly worker: WorkerProcess;
  readonly ownedTools: ReadonlySet<string>;
  /** The model the worker was configured with; Claude must report exactly this one. */
  readonly model: string;
  /** Removes the session's private native state once both process owners are joined. */
  readonly release: () => Promise<void>;
}

class TurnRefused extends Error {
  constructor(readonly error: AgentError) {
    super(error.message);
    this.name = 'NodeClaudeTurnRefused';
  }
}

const refusal = (code: string, message: string) =>
  new TurnRefused({ category: 'invalid_request', code, message, recovery: { kind: 'none' } });

function promptText(input: AgentProviderStartTurnInput): string {
  if (input.output !== undefined) throw refusal('structured_output_unsupported', 'Claude sessions do not support structured output.');
  if (input.interactionMode !== 'default') throw refusal('interaction_mode_unsupported', 'Claude sessions support only the default interaction mode.');
  const texts = input.parts.map((part) => {
    if (part.type !== 'text') throw refusal('input_unsupported', 'Claude sessions accept text input only.');
    return part.text;
  });
  const text = texts.join('\n\n');
  if (!text.trim() || text.length > PROMPT_CHARACTERS) throw refusal('input_invalid', 'Turn text must be non-empty and bounded.');
  return text;
}

/**
 * The session is unusable after any worker failure, abandoned or unconfirmed turn. Closing always
 * stops tools before the worker and keeps both owners until each is joined.
 */
export function createClaudeSession(input: ClaudeSessionInput): AgentProviderSession {
  let state: 'idle' | 'running' | 'closing' | 'closed' = 'idle';
  let failure: string | undefined;
  let active: ActiveTurn | undefined;
  let closing: Promise<void> | undefined;
  const host: TurnHost = {
    providerKey: input.providerKey,
    sessionId: input.sessionId, tools: input.tools, worker: input.worker, ownedTools: input.ownedTools, model: input.model, nativeRefs: new Set(),
    usage: new ClaudeUsage(input.providerKey),
    fail(reason) { failure ??= reason; },
  };

  input.worker.listen((event) => {
    if (active) { active.admit(event); return; }
    if (event.type === 'tool_call') {
      try { input.worker.send({ type: 'tool_result', callId: event.callId, text: 'Tool call refused: no turn is active.', isError: true }); }
      catch { /* the worker transport reports its own failure */ }
    }
    if (event.type !== 'residual' && event.type !== 'assistant_text') failure ??= `worker_${event.type}_outside_turn`;
  });

  const startTurn: AgentProviderSession['startTurn'] = (turnInput) => {
    if (state !== 'idle') throw refusal('turn_unavailable', state === 'running' ? 'A turn is already active.' : 'The session is closed.');
    if (failure) throw new TurnRefused({ category: 'provider', code: 'session_failed', message: `The Claude session is no longer usable (${failure}).`, recovery: { kind: 'none' } });
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
        if (!completed) { failure ??= 'turn_abandoned'; turn.interrupt('interrupted'); }
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
      try { await input.tools.close(); } catch (error) { errors.push(error); }
      try { await input.worker.close(); } catch (error) { errors.push(error); }
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
