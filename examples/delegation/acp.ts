// ------------------------------------------------------------------------------------------------
//                acp.ts - Real ACP parent tools and child lifetime independent of a parent turn
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionId, parseAgentTurnId,
  type AgentSessionConfiguration,
} from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, isAgentProviderSessionCleanupErrorFor,
  type AgentCreateSessionInput, type AgentProviderDriver, type AgentProviderSession, type AgentProviderSessionCleanupError } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import {
  createDelegationCoordinator, createDelegationHostBinding, createInMemoryDelegationStore, parseDelegationLimits,
  parseDelegationPolicySnapshot, type DelegationAdmissionReceipt, type DelegationCompletionEnvelope,
  type DelegationHostRequest, type DelegationParentDeliveryPort,
} from '@agen-ai/agent-orchestration';
import { startDelegationMcpBridge } from '@agen-ai/agent-orchestration/mcp';
import { approveSyntheticRequest, ExampleSessionCleanupError } from '../run-session.js';
import { createExampleHost } from './host.js';
import type { ExampleInvocation, ExampleProvider } from './provider.js';

async function settleDispatch(work: Promise<void>): Promise<{ error: unknown } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.then(() => undefined, (error: unknown) => ({ error })),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The parent dispatch producer did not quiesce.')), 15_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

const initial: AgentSessionConfiguration = { kind: 'selected', revision: parseAgentConfigurationRevisionId('example-acp:initial'),
  catalogRevision: 1, selections: [] };

// The caller owns this temporary root; the runner owns every session and registry it opens within it.
export async function runAcpDelegationExample(driver: AgentProviderDriver, root: string) {
  const nativeInvocations: ExampleInvocation[] = [];
  const observedDriver = { ...driver, async materialize(definition: Parameters<typeof driver.materialize>[0]) {
    const instance = await driver.materialize(definition);
    const adapter = instance.adapter;
    return { ...instance, adapter: { ...adapter, async createSession(context: Parameters<typeof adapter.createSession>[0]) {
      const session = await adapter.createSession(context);
      return { ...session, startTurn(input: Parameters<typeof session.startTurn>[0]) {
        const execution = session.startTurn(input);
        return { ...execution, outputs: (async function* () {
          if (!context.hostBinding) {
            assert.equal(session.configuration.kind, 'selectable');
            if (session.configuration.kind !== 'selectable') throw new Error('The example ACP configuration is not selectable.');
            const catalog = await session.configuration.listConfiguration();
            const value = (label: string) => {
              const field = catalog.fields.find((candidate) => candidate.label === label);
              assert.ok(field?.fieldKind === 'single_select');
              return field.options.find((option) => option.optionId === field.currentValue)!.label;
            };
            assert.equal(value('Speed'), 'Standard');
            nativeInvocations.push({ sessionId: context.sessionId, turnId: input.turnId,
              model: value('Model'), speed: value('Speed'), reasoning: value('Reasoning') });
          }
          yield* execution.outputs;
        })() };
      } };
    } } };
  } };
  const instanceId = parseAgentInstanceId('example-acp:primary');
  const registry = await createAgentProviderRegistry({ drivers: [observedDriver],
    definitions: [{ instanceId, providerKey: driver.providerKey, driverConfiguration: {} }] });
  let bootstrap: AgentProviderSession | undefined;
  let parentSession: AgentProviderSession | undefined;
  let openingCleanup: AgentProviderSessionCleanupError | undefined;
  let coordinator: Awaited<ReturnType<typeof createDelegationCoordinator>> | undefined;
  let delivery: Promise<void> | undefined;
  const parentLifetime = new AbortController();
  let cleanupAttempted = false;
  let dispatchFailure: { error: unknown } | undefined;
  const openSession = async (input: AgentCreateSessionInput): Promise<AgentProviderSession> => {
    try { return await registry.requireInstance(instanceId).adapter.createSession(input); }
    catch (error) {
      if (isAgentProviderSessionCleanupErrorFor(error, input)) openingCleanup = error;
      throw error;
    }
  };
  const cleanup = async (mode: 'drain' | 'cancel' = 'cancel'): Promise<void> => {
    parentLifetime.abort();
    const receipt = await coordinator?.dispose({ mode, timeoutMs: 5_000 });
    if (receipt && receipt.status !== 'closed') throw new Error('The example coordinator did not quiesce.');
    dispatchFailure = delivery ? await settleDispatch(delivery) : undefined;
    if (openingCleanup) { await openingCleanup.retryCleanup(); openingCleanup = undefined; }
    if (bootstrap) { await bootstrap.close({ reason: 'shutdown' }); bootstrap = undefined; }
    if (parentSession) { await parentSession.close({ reason: 'shutdown' }); parentSession = undefined; }
    await registry.dispose();
  };
  try {
    bootstrap = await openSession({ sessionId: parseAgentSessionId('example-acp:catalog'),
      workingDirectory: root, configuration: initial, onBindingCreated() {}, signal: AbortSignal.timeout(5_000) });
    assert.equal(bootstrap.configuration.kind, 'selectable');
    if (bootstrap.configuration.kind !== 'selectable') throw new Error('The example ACP peer did not expose configuration.');
    const configurationCatalog = await bootstrap.configuration.listConfiguration();
    cleanupAttempted = true;
    await bootstrap.close({ reason: 'shutdown' });
    bootstrap = undefined;
    cleanupAttempted = false;
    const provider: ExampleProvider = { registry, instanceId, providerKey: driver.providerKey,
      configurationCatalog, supportsResume: false, invocations: nativeInvocations };
    let receiveRequest!: (request: DelegationHostRequest) => void;
    const requested = new Promise<DelegationHostRequest>((resolve) => { receiveRequest = resolve; });
    const example = await createExampleHost({ root, provider, onRequest: receiveRequest });
    example.setPolicy(parseDelegationPolicySnapshot({ revision: 2, user: { enabled: true } }));
    let parentRunning = false;
    let parentEnded = false;
    let completionReceived = false;
    let receiveDelivery!: (work: Promise<void>) => void;
    const deliveryFinished = new Promise<void>((resolve) => { receiveDelivery = resolve; });
    void deliveryFinished.catch(() => undefined);
    let retained: { envelope: DelegationCompletionEnvelope; inboxId: string; acceptedAt: string } | undefined;
    const runParent = async (command: object): Promise<string> => {
      assert.ok(parentSession);
      assert.equal(parentRunning, false, 'Ordinary parent turns and completion dispatch share one exclusion.');
      parentRunning = true;
      let output = '';
      let ended = false;
      const assertCurrent = () => {
        const current = example.readAuthority();
        assert.ok(parentRunning && current.resultAccess && current.executionAllowed
          && current.revision === example.parent.revision && current.lifecycle === 'idle');
      };
      try {
        assertCurrent();
        for await (const part of parentSession.startTurn({ turnId: parseAgentTurnId(`example-parent:${randomUUID()}`),
          interactionMode: 'default', parts: [{ type: 'text', text: JSON.stringify(command) }], signal: AbortSignal.any([parentLifetime.signal, AbortSignal.timeout(10_000)]),
          onProviderExecutionStarted: assertCurrent }).outputs) {
          if (part.kind !== 'event') continue;
          if (part.event.type === 'content.delta') output += part.event.payload.delta;
          if (part.event.type === 'turn.completed') { assert.equal(part.event.payload.outcome, 'completed'); ended = true; }
        }
        assert.equal(ended, true, 'The parent must produce a terminal end-turn output.');
        return output;
      } finally { parentRunning = false; }
    };
    const parentDelivery: DelegationParentDeliveryPort = {
      persistence: 'volatile',
      async accept({ envelope, signal }) {
        signal.throwIfAborted();
        assert.equal(envelope.parent.parentId, example.parent.parentId);
        assert.equal(envelope.parent.scopeId, example.parent.scopeId);
        if (retained) {
          assert.equal(retained.envelope.storeId, envelope.storeId);
          assert.equal(retained.envelope.notificationId, envelope.notificationId);
        } else {
          retained = { envelope, inboxId: randomUUID(), acceptedAt: new Date().toISOString() };
          delivery = Promise.resolve().then(async () => {
            const authority = example.readAuthority();
            assert.ok(authority.resultAccess && authority.executionAllowed && authority.revision === envelope.parent.revision);
            assert.equal(authority.lifecycle, 'idle');
            assert.equal(parentEnded, true);
            const response = JSON.parse(await runParent({ action: 'completion', envelope })) as { completionReceived: boolean };
            assert.equal(response.completionReceived, true);
            completionReceived = true;
          });
          // Keep the actual dispatch producer observed until shutdown even when native dispatch fails.
          void delivery.catch(() => undefined);
          receiveDelivery(delivery);
        }
        return { status: 'accepted', inboxId: retained.inboxId, acceptedAt: retained.acceptedAt };
      },
      async inspect({ storeId, notificationId, signal }) {
        signal.throwIfAborted();
        return retained?.envelope.storeId === storeId && retained.envelope.notificationId === notificationId
          ? { status: 'accepted', inboxId: retained.inboxId, acceptedAt: retained.acceptedAt } : { status: 'absent' };
      },
    };
    const limits = parseDelegationLimits({ runTimeoutMs: 20_000, maxWaitMs: 5_000 });
    coordinator = await createDelegationCoordinator({ host: example.host, store: createInMemoryDelegationStore({ limits }), limits, parentDelivery });
    const client = await coordinator.bindParent({ scope: example.parent });
    const hostBinding = await createDelegationHostBinding({ client });
    assert.ok(hostBinding);
    parentSession = await openSession({ sessionId: parseAgentSessionId('example-acp:parent'),
      workingDirectory: root, configuration: initial, onBindingCreated() {}, hostBinding, signal: AbortSignal.timeout(5_000) });
    const parentResult = JSON.parse(await runParent({ action: 'delegate', operationId: randomUUID() })) as { admission: DelegationAdmissionReceipt };
    parentEnded = true;
    const request = await Promise.race([requested, client.wait({ taskId: parentResult.admission.taskId, timeoutMs: 5_000 })
      .then(() => { throw new Error('The child did not reach its live host approval.'); })]);
    assert.equal(request.request.requestKind, 'approval');
    assert.equal((await client.inspect({ taskId: parentResult.admission.taskId })).runs.items[0]!.phase, 'waiting');
    assert.equal(completionReceived, false);
    assert.deepEqual(nativeInvocations.map(({ model, speed, reasoning }) => ({ model, speed, reasoning })),
      [{ model: 'Example model', speed: 'Standard', reasoning: 'Max' }]);
    assert.equal(registry.requireInstance(instanceId).capabilities.turns.steer.kind, 'unsupported');
    if (request.request.requestKind !== 'approval') throw new Error('The example child requested an unsupported decision.');
    await coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution: await approveSyntheticRequest(request.request) });
    const completed = await client.wait({ taskId: parentResult.admission.taskId, timeoutMs: 5_000 });
    assert.equal(completed.status, 'settled');
    assert.equal(completed.task.runs.items[0]!.outcome?.kind, 'succeeded');
    // Keep delivery admission open until the separately owned parent dispatch producer has settled.
    const finishedDispatch = await settleDispatch(deliveryFinished);
    if (finishedDispatch) throw finishedDispatch.error;
    cleanupAttempted = true;
    await cleanup('drain');
    cleanupAttempted = false;
    return { example: 'delegation-acp',
      parentEndedBeforeChildCompletion: parentEnded, childOutcome: 'succeeded', approval: 'resolved',
      appliedModel: nativeInvocations[0]!.model, appliedSpeed: nativeInvocations[0]!.speed,
      appliedReasoning: nativeInvocations[0]!.reasoning, completionDelivered: completionReceived,
      nativeSteering: 'unsupported', cleanup: 'closed' };
  } catch (error) {
    // An opening or close failure already owns pending cleanup; propagation cannot retry it.
    if (openingCleanup || cleanupAttempted) throw new ExampleSessionCleanupError([error], cleanup);
    try { await cleanup(); }
    catch (cleanupError) { throw new ExampleSessionCleanupError([error, cleanupError], cleanup); }
    if (dispatchFailure && dispatchFailure.error !== error) {
      throw new AggregateError([error, dispatchFailure.error], 'The example and its parent dispatch both failed.');
    }
    throw error;
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'agent-sdk-delegation-acp-'));
  let bridgeAcquired = 0;
  let bridgeReleased = 0;
  const invokedTools: string[] = [];
  try {
    const driver = createNodeAcpProviderDriver({ providerKey: 'example-acp', configuration: 'selectable',
      launch: { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/delegation-peer.mjs', import.meta.url))],
        env: {}, cwd: root, shutdownTimeoutMs: 1_000 },
      limits: { initializationTimeoutMs: 5_000, promptTimeoutMs: 15_000, cancellationTimeoutMs: 2_000 },
      sessionMcpBinding: { transport: 'http', async create(context) {
        const facade = context.hostBinding;
        const bridge = await startDelegationMcpBridge({ signal: context.signal, shutdownTimeoutMs: 2_000,
          binding: { ...facade, invoke(input) { invokedTools.push(input.toolName); return facade.invoke(input); } } });
        bridgeAcquired += 1;
        return { mcpServers: [{ type: 'http', name: bridge.server.name, url: bridge.server.url,
          headers: Object.entries(bridge.server.headers).map(([name, value]) => ({ name, value })) }],
        async release() { await bridge.release(); bridgeReleased += 1; } };
      } },
    });
    const summary = await runAcpDelegationExample(driver, root);
    assert.equal(bridgeAcquired, 1);
    assert.equal(bridgeReleased, 1);
    try { await rm(root, { recursive: true, force: true }); }
    catch (cleanupError) {
      throw new ExampleSessionCleanupError([cleanupError], () => rm(root, { recursive: true, force: true }));
    }
    console.log(JSON.stringify({ ...summary, toolsInvoked: invokedTools, bridgeAcquired, bridgeReleased }));
  } catch (error) {
    if (error instanceof ExampleSessionCleanupError) {
      console.error(`ACP delegation cleanup remains owned at ${root}; retain the returned retry handle.`);
      throw new ExampleSessionCleanupError([error], async () => {
        await error.retryCleanup();
        await rm(root, { recursive: true, force: true });
      });
    }
    console.error(`ACP delegation failed; inspect the retained root at ${root} before cleanup.`);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
