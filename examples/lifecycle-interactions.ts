import assert from 'node:assert/strict';
import {
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentError,
  parseAgentInstanceId,
  parseAgentProviderConversationId,
  parseAgentSessionDecisionRequest,
  parseAgentSessionDecisionResponseFor,
  parseAgentSessionId,
} from '@agen-ai/agent-protocol';
import {
  createAgentProviderReadiness,
  createAgentProviderRegistry,
  type AgentProviderDriver,
  type AgentProviderDirectSessionInteraction,
  type AgentProviderSession,
  type AgentSessionInteraction,
  type AgentSessionInteractionTerminal,
} from '@agen-ai/agent-runtime';

// This consumer-owned adapter is a deterministic fixture with no native, network, or storage effect.
const capabilities = parseAgentCapabilities({
  protocolVersion: 13,
  providerKey: 'example-lifecycle-interactions',
  sessions: { create: true, resume: false, branch: { kind: 'unsupported' } },
  turns: { structuredOutput: { kind: 'unsupported' }, interactionModes: ['default'], interrupt: false, steer: { kind: 'unsupported' } },
  requests: { approval: { kind: 'unsupported' }, elicitation: { kind: 'unsupported' } },
  context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
  input: { text: true, images: { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
  output: { streaming: true, plans: false, fileChanges: 'none', artifactKinds: [] },
  configuration: { kind: 'managed' },
  operations: { kind: 'unsupported' },
  managedContent: { kind: 'unsupported' },
  integrations: { kind: 'unsupported' },
  environment: { instance: { kind: 'unsupported' }, session: { kind: 'unsupported' } },
  collaboration: { kind: 'unsupported' },
  generatedResources: { kind: 'unsupported' },
  authentication: { kind: 'unsupported' },
  versionReporting: false,
});
const statistics = { turns: 0, acceptedAnswers: 0, sessionCloses: 0, instanceDisposals: 0 };
const transcript: string[] = [];
const driver: AgentProviderDriver = {
  providerKey: capabilities.providerKey,
  supportsMultipleInstances: false,
  materialize(definition) {
    let closed = true;
    let disposed = false;
    return {
      instanceId: definition.instanceId,
      capabilities,
      accountQuota: { kind: 'unsupported' },
      environment: { kind: 'unsupported' },
      checkReadiness: () => createAgentProviderReadiness({ status: 'ready', checkedAt: new Date().toISOString() }),
      dispose() {
        assert.equal(closed, true, 'Close the session before disposing its instance.');
        if (!disposed) {
          disposed = true;
          statistics.instanceDisposals += 1;
          transcript.push('instance.disposed');
        }
      },
      adapter: {
        resumption: { kind: 'unsupported' },
        branching: { kind: 'unsupported' },
        authentication: { kind: 'unsupported' },
        // Support is separate from portable turn capabilities and applies only to this opening operation.
        sessionInteractions: { kind: 'supported', mappings: [{ openingOperation: 'create', requestKind: 'decision' }],
          producerOwnership: 'exclusive', humanWait: ['bounded'] },
        createSession(context): AgentProviderSession {
          context.signal?.throwIfAborted();
          if (!context.interactions) throw new Error('This controlled adapter requires a setup handler.');
          const binding = { conversationId: parseAgentProviderConversationId('example-lifecycle:conversation') };
          context.onBindingCreated(binding);
          const request = parseAgentSessionDecisionRequest({
            kind: 'decision', requestId: 'example-lifecycle:workspace', sessionId: context.sessionId,
            title: 'Allow workspace configuration?',
            description: 'Review the target and each choice before deciding.',
            target: { kind: 'workspace', path: context.workingDirectory },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            choices: [
              { choiceId: 'grant', label: 'Allow workspace configuration',
                description: 'Allow current and future configuration from the whole workspace.',
                consequence: { kind: 'grant', scope: 'workspace', persistence: {
                  kind: 'provider_managed', duration: 'persistent', mayAffectOtherSessions: true,
                } } },
              { choiceId: 'decline', label: 'Keep configuration gated',
                description: 'Decline this request; this does not revoke an earlier grant.',
                consequence: { kind: 'decline', configuration: 'remains_gated' } },
            ],
          });
          const lifetime = new AbortController();
          let result: AgentSessionInteractionTerminal | undefined;
          let finishTerminal!: (terminal: AgentSessionInteractionTerminal) => void;
          const terminal = new Promise<AgentSessionInteractionTerminal>((resolve) => { finishTerminal = resolve; });
          function finish(value: AgentSessionInteractionTerminal): void {
            if (result) return;
            result = value;
            finishTerminal(value);
            lifetime.abort();
          }
          const unavailable = parseAgentError({ category: 'unknown', code: 'example_request_unavailable',
            message: 'The controlled decision no longer accepts an answer.', recovery: { kind: 'none' } });
          const interaction: AgentProviderDirectSessionInteraction = {
            kind: 'direct', request, signal: lifetime.signal, terminal,
            async respond(input) {
              const { signal, ...value } = input;
              const response = parseAgentSessionDecisionResponseFor(request, value);
              signal?.throwIfAborted();
              if (result) return { status: 'rejected', requestState: 'unavailable', error: unavailable };
              statistics.acceptedAnswers += 1;
              finish({ kind: 'answered', response });
              // This receipt establishes acceptance by this handler; the fixture performs no effect.
              return { status: 'delivered' };
            },
          };
          closed = false;
          // Track actual callback completion, but do not await human/UI work before returning the session.
          let callback: Promise<void>;
          try { callback = Promise.resolve(context.interactions.onRequest(interaction)); }
          catch (error) { finish({ kind: 'failed', error: unavailable }); closed = true; throw error; }
          const callbackDrain = callback.catch(() => { finish({ kind: 'failed', error: unavailable }); });
          return {
            binding,
            interruption: { kind: 'unsupported' }, steering: { kind: 'unsupported' },
            configuration: { kind: 'managed' }, operations: { kind: 'unsupported' },
            managedContent: { kind: 'unsupported' }, environment: { kind: 'unsupported' },
            collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
            startTurn() {
              statistics.turns += 1;
              throw new Error('This example does not run a model turn.');
            },
            async close() {
              // Fence the producer before joining callbacks; signal abortion alone is not drain.
              finish({ kind: 'session_closed' });
              await callbackDrain;
              if (!closed) {
                closed = true;
                statistics.sessionCloses += 1;
                transcript.push('session.closed');
              }
            },
          };
        },
      },
    };
  },
};

// Host: install the handler before opening, then present and answer the bound request after return.
const instanceId = parseAgentInstanceId('example-lifecycle:instance');
const registry = await createAgentProviderRegistry({ drivers: [driver],
  definitions: [{ providerKey: driver.providerKey, instanceId, driverConfiguration: {} }] });
const offers: AgentSessionInteraction[] = [];
let session: AgentProviderSession | undefined;
let pendingAfterOpening = false;
let receiptStatus: string | undefined;
let terminalKind: string | undefined;
try {
  session = await registry.requireInstance(instanceId).adapter.createSession({
    sessionId: parseAgentSessionId('example-lifecycle:session'), workingDirectory: process.cwd(),
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('example-lifecycle:configuration') },
    onBindingCreated() {}, signal: AbortSignal.timeout(10_000),
    interactions: {
      onRequest(interaction) {
        offers.push(interaction);
        transcript.push('handler.offered');
        // Return immediately. A real UI can retain this handle and observe interaction.signal.
      },
    },
  });
  transcript.push('opening.returned');
  assert.equal(offers.length, 1);
  const interaction = offers[0];
  assert.ok(interaction);
  pendingAfterOpening = !interaction.signal.aborted && statistics.acceptedAnswers === 0;
  assert.equal(pendingAfterOpening, true, 'Opening must return with a still-answerable decision.');

  // Present request.title, request.target and every choice consequence to the user.
  // Only this synthetic walkthrough selects decline automatically; hosts own their decision policy.
  assert.ok(interaction.request.kind === 'decision', 'The workspace fixture must offer a decision.');
  const decline = interaction.request.choices.find((choice) => choice.consequence.kind === 'decline');
  assert.ok(decline);
  transcript.push(`host.selected:${decline.choiceId}`);
  const receipt = await interaction.respond({ kind: 'decision', choiceId: decline.choiceId });
  receiptStatus = receipt.status;
  assert.equal(receipt.status, 'delivered');
  transcript.push('answer.delivered');
  const terminal = await interaction.terminal;
  terminalKind = terminal.kind;
  assert.deepEqual(terminal, { kind: 'answered', response: { kind: 'decision', choiceId: decline.choiceId } });
  transcript.push('decision.answered');
  // Neither the receipt nor terminal proves native effect or persistence. There is no native provider here.
} finally {
  // If close rejects, retain the session and retry its cleanup before disposing the registry.
  // The packed failure fixture demonstrates that advanced ownership path separately.
  await session?.close({ reason: 'shutdown' });
  await registry.dispose();
}
assert.deepEqual(statistics, { turns: 0, acceptedAnswers: 1, sessionCloses: 1, instanceDisposals: 1 });
console.log(JSON.stringify({ example: 'lifecycle-interactions', evidence: 'synthetic', pendingAfterOpening,
  receipt: receiptStatus, terminal: terminalKind, effect: 'not_performed', ...statistics, cleanup: 'joined', transcript }));
