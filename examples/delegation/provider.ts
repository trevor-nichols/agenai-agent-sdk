// ------------------------------------------------------------------------------------------------
//                provider.ts - Deterministic native behavior for the public delegation example
// ------------------------------------------------------------------------------------------------

import {
  parseAgentConfigurationCatalog, parseAgentConfigurationSelectionFor, parseAgentIsoDateTime,
  type AgentConfigurationCatalog, type AgentConfigurationSelectionInput, type AgentInstanceId,
  type AgentProviderKey,
} from '@agen-ai/agent-protocol';
import {
  createAgentEventOutput, createAgentProviderRegistry,
  type AgentProviderOutput, type AgentProviderRegistry, type AgentProviderStartTurnInput, type AgentProviderSession,
  type AgentProviderSessionContext, type AgentProviderTurnExecution, type MaybePromise,
} from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';

export interface ExampleInvocation {
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: string;
  readonly speed: string;
  readonly reasoning: string;
}

export interface ExampleProvider {
  readonly registry: AgentProviderRegistry;
  readonly instanceId: AgentInstanceId;
  readonly providerKey: AgentProviderKey;
  readonly configurationCatalog: AgentConfigurationCatalog;
  readonly supportsResume: boolean;
  readonly invocations: readonly ExampleInvocation[];
  readonly statistics?: () => Readonly<{ steeringMessages: number; resumedSessions: number; interruptions: number; resolvedRequests: number }>;
}

export const exampleConfiguration = (): AgentConfigurationCatalog => parseAgentConfigurationCatalog({
  revision: 1,
  fields: [
    { key: 'model', label: 'Model', currentValue: 'unselected', options: [
      { optionId: 'unselected', label: 'Unselected' }, { optionId: 'example-model', label: 'Example model' },
    ] },
    { key: 'speed', label: 'Speed', currentValue: 'fast', options: [
      { optionId: 'standard', label: 'Standard' }, { optionId: 'fast', label: 'Fast' },
    ] },
    { key: 'reasoning', label: 'Reasoning', currentValue: 'low', options: [
      { optionId: 'low', label: 'Low' }, { optionId: 'max', label: 'Max' },
    ] },
  ].map((field) => ({ ...field, options: field.options.sort((left, right) => left.optionId < right.optionId ? -1 : 1),
    revision: 1, fieldKind: 'single_select', scope: 'session', applicationTiming: 'immediate', mutable: true }))
    .sort((left, right) => left.key < right.key ? -1 : 1),
});

function configurationState() {
  let catalog = exampleConfiguration();
  const select = (selection: AgentConfigurationSelectionInput) => {
    const parsed = parseAgentConfigurationSelectionFor(catalog, selection);
    if (parsed.value.fieldKind !== 'single_select') throw new TypeError('The example accepts selectable values only.');
    const selected = parsed.value.optionId;
    const revision = catalog.revision + 1;
    catalog = parseAgentConfigurationCatalog({ revision, fields: catalog.fields.map((field) =>
      field.key === parsed.key ? { ...field, revision, currentValue: selected } : field) });
  };
  return { list: () => catalog, select };
}

export async function createExampleProvider(options: Readonly<{
  onChildInvoke?: (context: AgentProviderSessionContext, turn: AgentProviderStartTurnInput) => MaybePromise<void>;
  outputs?: (context: AgentProviderSessionContext, turn: AgentProviderStartTurnInput) => AsyncIterable<AgentProviderOutput>;
}> = {}): Promise<ExampleProvider> {
  const fake = createFakeAgentProvider({ providerKey: 'example-fake', instanceId: 'example-fake:primary' });
  const invocations: ExampleInvocation[] = [];
  function wrap(session: AgentProviderSession, context: AgentProviderSessionContext): AgentProviderSession {
    const configuration = configurationState();
    if (context.configuration.kind === 'selected') {
      const initial = configuration.list();
      for (const selection of context.configuration.selections) parseAgentConfigurationSelectionFor(initial,
        { key: selection.key, expectedCatalogRevision: context.configuration.catalogRevision,
          expectedFieldRevision: selection.fieldRevision, value: selection.value });
      for (const selection of context.configuration.selections) configuration.select({ key: selection.key,
        expectedCatalogRevision: configuration.list().revision, expectedFieldRevision: selection.fieldRevision, value: selection.value });
    }
    let releaseActive: (() => void) | undefined;
    let canceled = false;
    const nativeSteering = session.steering;
    const nativeInterruption = session.interruption;
    return {
      ...session,
      configuration: {
        kind: 'selectable', listConfiguration: () => configuration.list(),
        applyConfigurationSelection(input) {
          input.signal?.throwIfAborted();
          input.onProviderExecutionStarted?.();
          configuration.select(input.selection);
          return { status: 'completed' };
        },
      },
      startTurn(turn) {
        let approval: AgentProviderTurnExecution | undefined;
        return { turnId: turn.turnId,
          async resolveRequest(input) {
            if (!approval) throw new Error('The example has no answerable approval.');
            return approval.resolveRequest(input);
          },
          outputs: (async function* () {
            turn.signal?.throwIfAborted();
            const values = Object.fromEntries(configuration.list().fields.map((field) => [field.label.toLowerCase(), field.currentValue]));
            if (values.model !== 'example-model' || !['standard', 'fast'].includes(String(values.speed)) || values.reasoning !== 'max') {
              throw new Error('The example child did not receive its certified configuration before prompting.');
            }
            invocations.push({ sessionId: context.sessionId, turnId: turn.turnId,
              model: String(values.model), speed: String(values.speed), reasoning: String(values.reasoning) });
            await options.onChildInvoke?.(context, turn);
            if (options.outputs) { yield* options.outputs(context, turn); return; }
            const text = turn.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
            if (text.startsWith('[approve]')) { approval = session.startTurn(turn); yield* approval.outputs; return; }
            const wait = text.startsWith('[steer]') || text.startsWith('[cancel]')
              ? new Promise<void>((resolve) => { releaseActive = resolve; }) : undefined;
            const base = { protocolVersion: 12 as const, sessionId: context.sessionId, turnId: turn.turnId,
              occurredAt: parseAgentIsoDateTime(new Date().toISOString()) };
            yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
            yield createAgentEventOutput({ ...base, type: 'item.started', payload: {
              itemId: 'example-answer', itemKind: 'assistant_message', status: 'in_progress',
            } });
            yield createAgentEventOutput({ ...base, type: 'content.delta', payload: {
              itemId: 'example-answer', streamKind: 'assistant_text', delta: 'Configured child is working.',
            } });
            if (wait) {
              const abort = () => releaseActive?.();
              turn.signal?.addEventListener('abort', abort, { once: true });
              try { await wait; turn.signal?.throwIfAborted(); }
              finally { turn.signal?.removeEventListener('abort', abort); releaseActive = undefined; }
            }
            yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: { outcome: canceled ? 'canceled' : 'completed' } });
          })(),
        };
      },
      steering: nativeSteering.kind === 'supported' ? { kind: 'supported', async steerTurn(input) {
        const receipt = await nativeSteering.steerTurn(input);
        releaseActive?.();
        return receipt;
      } } : nativeSteering,
      interruption: nativeInterruption.kind === 'supported' ? { kind: 'supported', async interruptTurn(input) {
        const receipt = await nativeInterruption.interruptTurn(input);
        canceled = true;
        releaseActive?.();
        return receipt;
      } } : nativeInterruption,
    };
  }
  const driver = { ...fake.driver, async materialize(definition: Parameters<typeof fake.driver.materialize>[0]) {
    const instance = await fake.driver.materialize(definition);
    const adapter = instance.adapter;
    const resumption = adapter.resumption;
    return { ...instance, adapter: { ...adapter,
      async createSession(context: Parameters<typeof adapter.createSession>[0]) { return wrap(await adapter.createSession(context), context); },
      resumption: resumption.kind === 'supported' ? { kind: 'supported' as const,
        async resumeSession(context: Parameters<typeof resumption.resumeSession>[0]) { return wrap(await resumption.resumeSession(context), context); },
      } : resumption,
    } };
  } };
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [fake.definition] });
  return { registry, instanceId: fake.definition.instanceId, providerKey: fake.definition.providerKey,
    configurationCatalog: exampleConfiguration(), supportsResume: true, invocations,
    statistics() {
      const snapshot = fake.snapshot();
      return { steeringMessages: snapshot.steeringInputs.length, resumedSessions: snapshot.resumedSessionIds.length,
        interruptions: snapshot.interruptedTurnIds.length, resolvedRequests: snapshot.resolutions.length };
    },
  };
}
