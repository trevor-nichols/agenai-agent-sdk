import {
  parseAgentTurnId,
  type AgentApprovalOption,
  type AgentApprovalRequest,
  type AgentApprovalResolution,
} from '@agen-ai/agent-protocol';
import type { AgentApprovalConsequence } from '@agen-ai/agent-protocol/requests';
import type { AgentProviderSession } from '@agen-ai/agent-runtime';

export const independentApprovalProgress = 'Independent work continues while the approval is open.';

export function exampleGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function describeConsequence(consequence: AgentApprovalConsequence): string {
  switch (consequence.kind) {
    case 'scoped':
      return `${consequence.persistence}; ${consequence.scope.kind}`;
    case 'provider_managed_remembrance':
      return `Duration: ${consequence.duration.kind}; applicability: ${consequence.applicability.kind}. ${consequence.explanation}`;
  }
}

// This is a simulated user choice for the bundled teaching examples, not an automatic host policy.
export function selectDisplayedOption(request: AgentApprovalRequest, label: string): AgentApprovalResolution {
  const matches = request.options.filter((option) => option.label === label);
  const option = matches[0];
  if (matches.length !== 1 || !option) throw new Error('The displayed choice must identify exactly one offered option.');
  return { requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: option.optionId };
}

export async function runApprovalWalkthrough(
  session: AgentProviderSession,
  name: string,
  choose: (request: AgentApprovalRequest) => AgentApprovalResolution,
  onReceipt: () => void = () => {},
) {
  const lifetime = new AbortController();
  const progress = exampleGate();
  const releaseProgress = () => progress.release();
  lifetime.signal.addEventListener('abort', releaseProgress, { once: true });
  const timeout = setTimeout(() => lifetime.abort(new Error('The synthetic approval example exceeded 10 seconds.')), 10_000);
  const transcript: string[] = [];
  let offered: readonly (AgentApprovalOption & Readonly<{ display: string }>)[] = [];
  let resolution: AgentApprovalResolution | undefined;
  let receiptStatus: string | undefined;
  let completed = false;
  let answerTask: Promise<void> | undefined;
  let answerFailure: { error: unknown } | undefined;
  try {
    const execution = session.startTurn({
      turnId: parseAgentTurnId(`remembered:${name}`), interactionMode: 'default',
      parts: [{ type: 'text', text: name }], signal: lifetime.signal,
    });
    for await (const output of execution.outputs) {
      if (output.kind !== 'event') continue;
      const event = output.event;
      if (event.type === 'turn.started') transcript.push('turn.started');
      if (event.type === 'request.opened') {
        const request = event.payload.request;
        if (request.requestKind !== 'approval' || answerTask) throw new Error('Expected one approval on the original turn.');
        offered = request.options.map((option) => ({ ...option, display: describeConsequence(option.consequence) }));
        transcript.push('request.opened');
        // A real UI makes an abort-aware decision here. Keep pulling the original output stream.
        answerTask = (async () => {
          await progress.promise;
          lifetime.signal.throwIfAborted();
          resolution = choose(request);
          transcript.push('answer.submitted');
          const receipt = await execution.resolveRequest({ resolution, signal: lifetime.signal });
          receiptStatus = receipt.status;
          if (receipt.status !== 'delivered') throw new Error(`The answer was ${receipt.status}; do not replay it.`);
          transcript.push('answer.delivered');
          // Delivery confirms adapter acceptance. It proves no provider rule write or future match.
          onReceipt();
        })().catch((error: unknown) => { answerFailure = { error }; lifetime.abort(error); });
      }
      if (event.type === 'content.delta') {
        transcript.push(`output:${event.payload.delta}`);
        if (event.payload.delta === independentApprovalProgress) progress.release();
      }
      if (event.type === 'turn.completed') {
        transcript.push(`turn.completed:${event.payload.outcome}`);
        if (event.payload.outcome !== 'completed') throw new Error('The original turn did not complete.');
        completed = true;
      }
    }
    await answerTask;
    if (answerFailure) throw answerFailure.error;
    if (!completed || !resolution) throw new Error('The reader ended before the answer and terminal output.');
  } catch (error) {
    throw answerFailure?.error ?? error;
  } finally {
    clearTimeout(timeout);
    lifetime.abort();
    try { await session.close({ reason: 'shutdown', signal: AbortSignal.timeout(2_000) }); }
    finally { await answerTask; lifetime.signal.removeEventListener('abort', releaseProgress); }
    transcript.push('session.closed', 'handler.joined');
  }
  return { offered, resolution, receipt: receiptStatus, transcript, cleanup: 'joined' as const };
}
