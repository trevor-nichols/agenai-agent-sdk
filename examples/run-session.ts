import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAgentConfigurationRevisionId,
  parseAgentInstanceId,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentApprovalRequest,
  type AgentApprovalResolution,
} from '@agen-ai/agent-protocol';
import {
  createAgentProviderRegistry,
  isAgentProviderSessionCleanupErrorFor,
  type AgentCreateSessionInput,
  type AgentProviderSession,
  type AgentProviderDriver,
} from '@agen-ai/agent-runtime';

// Keep this error on the host boundary; its closure owns native cleanup and registry disposal.
export class ExampleSessionCleanupError extends AggregateError {
  constructor(errors: readonly unknown[], readonly retryCleanup: () => Promise<void>) {
    super(errors, 'Example session cleanup remains incomplete.');
    this.name = 'ExampleSessionCleanupError';
  }
}

export async function runExampleSession(
  driver: AgentProviderDriver,
  workingDirectory: string,
  chooseApproval: (request: AgentApprovalRequest, signal: AbortSignal) => Promise<AgentApprovalResolution>,
): Promise<void> {
  const instanceId = parseAgentInstanceId('example:primary');
  const registry = await createAgentProviderRegistry({
    drivers: [driver],
    definitions: [{ providerKey: driver.providerKey, instanceId, driverConfiguration: {} }],
  });
  const openingInput: AgentCreateSessionInput = {
    sessionId: parseAgentSessionId('example:session'),
    workingDirectory,
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('example:configuration:1') },
    // An application should retain this exact opaque binding in its durable session store.
    onBindingCreated: (binding) => writeFileSync(join(workingDirectory, 'binding.json'), JSON.stringify(binding), { mode: 0o600 }),
    signal: AbortSignal.timeout(10_000),
  };
  let session: AgentProviderSession;
  try {
    session = await registry.requireInstance(instanceId).adapter.createSession(openingInput);
  } catch (error) {
    if (isAgentProviderSessionCleanupErrorFor(error, openingInput)) {
      // Propagating an opening failure must not introduce an automatic cleanup retry.
      throw new ExampleSessionCleanupError([error], async () => {
        await error.retryCleanup();
        await registry.dispose();
      });
    }
    try { await registry.dispose(); }
    catch (cleanupError) {
      throw new ExampleSessionCleanupError([error, cleanupError], () => registry.dispose());
    }
    throw error;
  }
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]);
  const answers = new Set<Promise<void>>();
  let answerFailure: { error: unknown } | undefined;
  let operationFailure: { error: unknown } | undefined;
  try {
    let completed = false;
    const execution = session.startTurn({
      turnId: parseAgentTurnId('example:turn'), interactionMode: 'default',
      parts: [{ type: 'text', text: 'Demonstrate a once-only permission with continuous output.' }], signal,
    });
    for await (const output of execution.outputs) {
      // Await the destination's acknowledgement before asking for another output.
      await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(output) + '\n',
        (error) => error ? reject(error) : resolve()));
      if (output.kind !== 'event') continue;
      if (output.event.type === 'request.opened') {
        const request = output.event.payload.request;
        if (request.requestKind !== 'approval') throw new Error('This example handles approval requests only.');
        // The host decision must observe signal; it runs independently from the output reader.
        const answer = (async () => {
          const resolution = await chooseApproval(request, signal);
          signal.throwIfAborted();
          const receipt = await execution.resolveRequest({ resolution, signal });
          if (receipt.status !== 'delivered') throw new Error(`The example answer was ${receipt.status}.`);
        })().catch((error: unknown) => {
          answerFailure ??= { error };
          lifetime.abort(error);
        });
        answers.add(answer);
        void answer.finally(() => answers.delete(answer));
      }
      if (output.event.type === 'turn.completed') {
        if (output.event.payload.outcome !== 'completed') throw new Error('The example turn did not complete successfully.');
        completed = true;
      }
    }
    if (!completed) throw new Error('The example ended without a terminal turn event.');
  } catch (error) {
    operationFailure = { error: answerFailure?.error ?? error };
  }
  lifetime.abort();
  const cleanup = async () => {
    try { await session.close({ reason: 'shutdown' }); }
    finally { await Promise.all(answers); }
    await registry.dispose();
  };
  try { await cleanup(); }
  catch (cleanupError) {
    throw new ExampleSessionCleanupError(
      operationFailure ? [operationFailure.error, cleanupError] : [cleanupError], cleanup,
    );
  }
  if (operationFailure) throw operationFailure.error;
  if (answerFailure) throw answerFailure.error;
}

export async function approveSyntheticRequest(request: AgentApprovalRequest): Promise<AgentApprovalResolution> {
  // Only the bundled credentialless peer uses this policy. Real hosts must obtain their own user/policy decision.
  const option = request.options.find((candidate) => candidate.decision === 'approved'
    && candidate.consequence.kind === 'scoped' && candidate.consequence.persistence === 'once'
    && candidate.consequence.scope.kind === 'exact_action');
  if (!option) throw new Error('The synthetic peer must offer a once-only exact-action approval.');
  return { requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId: option.optionId };
}
