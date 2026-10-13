// ------------------------------------------------------------------------------------------------
//                host.ts - Shared explicit host authority and certified target composition
// ------------------------------------------------------------------------------------------------

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgentConfigurationRevisionId, type AgentConfigurationCatalog } from '@agen-ai/agent-protocol';
import type { MaybePromise } from '@agen-ai/agent-runtime';
import {
  parseDelegationPolicySnapshot, parseDelegationTargetCatalog,
  type DelegationHost, type DelegationHostRequest, type DelegationParentScope,
  type DelegationPolicySnapshot, type DelegationTarget,
} from '@agen-ai/agent-orchestration';
import { createExampleProvider, type ExampleProvider } from './provider.js';

export interface ExampleParentAuthority {
  readonly revision: number;
  readonly lifecycle: 'idle' | 'running' | 'busy' | 'waiting' | 'stopped' | 'paused' | 'retired';
  readonly resultAccess: boolean;
  readonly executionAllowed: boolean;
}

function field(catalog: AgentConfigurationCatalog, label: string, value: string) {
  const found = catalog.fields.find((candidate) => candidate.label === label);
  if (!found || found.fieldKind !== 'single_select' || found.scope !== 'session' || found.applicationTiming !== 'immediate') {
    throw new Error(`The example provider has no immediate session ${label} selection.`);
  }
  const option = found.options.find((candidate) => candidate.label === value);
  if (!option) throw new Error(`The example provider has no certified ${label} ${value} option.`);
  return { key: found.key, fieldRevision: found.revision, value: { fieldKind: 'single_select' as const, optionId: option.optionId } };
}

export async function createExampleHost(options: Readonly<{
  root: string;
  provider?: ExampleProvider;
  readAuthority?: () => ExampleParentAuthority;
  onChildInvoke?: NonNullable<Parameters<typeof createExampleProvider>[0]>['onChildInvoke'];
  onRequest?: (request: DelegationHostRequest) => MaybePromise<void>;
}>) {
  const provider = options.provider ?? await createExampleProvider({
    ...(options.onChildInvoke ? { onChildInvoke: options.onChildInvoke } : {}),
  });
  const parent: DelegationParentScope = { parentId: 'example-parent', scopeId: 'example-host', revision: 1 };
  let authority: ExampleParentAuthority = { revision: 1, lifecycle: 'idle', resultAccess: true, executionAllowed: true };
  const readAuthority = () => options.readAuthority?.() ?? authority;
  let policy = parseDelegationPolicySnapshot({ revision: 1 });
  let sourceRevision = 1;
  const requests: DelegationHostRequest[] = [];
  const configurations: Readonly<{ model: string; speed: string; reasoning: string }>[] = [];
  const targets = (): DelegationTarget[] => ['standard', 'fast'].map((speed) => {
    const selections = [field(provider.configurationCatalog, 'Model', 'Example model'),
      field(provider.configurationCatalog, 'Speed', speed === 'standard' ? 'Standard' : 'Fast'),
      field(provider.configurationCatalog, 'Reasoning', 'Max')].sort((left, right) => left.key < right.key ? -1 : 1);
    return { reference: { catalogId: 'example-catalog', catalogRevision: sourceRevision,
      targetId: `${speed}-max`, targetRevision: 1, sourceId: 'example-certified-source', sourceRevision },
    instanceId: provider.instanceId, providerKey: provider.providerKey, modelId: 'example-model',
    label: `Example model, ${speed}, max`, options: selections.map((selection) => ({ key: selection.key, optionId: selection.value.optionId })),
    reasoning: { kind: 'certified', value: 'max' }, executionMode: { kind: 'certified', value: speed as 'standard' | 'fast' },
    certification: { mappingId: 'example-native-configuration', mappingRevision: 1 },
    availability: { kind: 'available' }, limitations: ['Synthetic example semantics; this mapping makes no claims about other providers.'],
    application: { configuration: { kind: 'selected', revision: parseAgentConfigurationRevisionId(`example-config:${speed}:max`),
      catalogRevision: provider.configurationCatalog.revision, selections }, beforeFirstTurn: [] } };
  });
  const catalog = () => parseDelegationTargetCatalog({ catalogId: 'example-catalog', revision: sourceRevision, targets: targets() });
  function assertParent(scope: DelegationParentScope) {
    const current = readAuthority();
    if (scope.parentId !== parent.parentId || scope.scopeId !== parent.scopeId || scope.revision !== current.revision || !current.resultAccess) {
      throw new Error('The example parent no longer has current result/control authority.');
    }
  }
  const host: DelegationHost = {
    registry: provider.registry,
    currentPolicy(scope) { assertParent(scope); return { scope, catalog: catalog(), policy }; },
    assertResultAccess({ scope }) { assertParent(scope); },
    assertControl({ scope }) { assertParent(scope); },
    assertRequestAccess({ task }) { assertParent(task.parent); },
    acquireExecution({ scope, signal }) {
      assertParent(scope);
      // Parent turn scheduling does not revoke a child execution lease already granted by this host.
      return { signal, assertCurrent() { signal.throwIfAborted(); }, release() {} };
    },
    async acquireChildResources({ task, continuation }) {
      const path = join(options.root, 'children', task.taskId);
      await mkdir(path, { recursive: true, mode: 0o700 });
      if (continuation && !provider.supportsResume) throw new Error('This example executor cannot resume the exact child conversation.');
      return { workingDirectory: { policy: 'isolated', authorizedRef: `example-child:${task.taskId}`, path },
        ...(provider.supportsResume ? { continuation: { kind: 'resume' as const, allowTargetChange: false } } : {}), release() {} };
    },
    verifyAppliedConfiguration({ target, observedConfiguration }) {
      if (!observedConfiguration) throw new Error('The example requires observed native session configuration.');
      const values: Record<string, string> = {};
      for (const selected of target.options) {
        const actual = observedConfiguration.fields.find((candidate) => candidate.key === selected.key);
        if (!actual || actual.fieldKind !== 'single_select' || actual.scope !== 'session'
          || actual.applicationTiming !== 'immediate' || actual.currentValue !== selected.optionId) {
          throw new Error('The native child did not apply the exact certified configuration.');
        }
        values[actual.label.toLowerCase()] = actual.options.find((option) => option.optionId === actual.currentValue)!.label;
      }
      configurations.push({ model: values.model!, speed: values.speed!, reasoning: values.reasoning! });
      return { target: target.reference, configuration: target.application.configuration };
    },
    async onRequest(request) { requests.push(request); await options.onRequest?.(request); },
  };
  return { host, registry: provider.registry, provider, parent, requests, configurations,
    get catalog() { return catalog(); }, get target() { return catalog().targets[0]!; },
    get policy() { return policy; }, readAuthority,
    setAuthority(value: ExampleParentAuthority) { authority = value; },
    setPolicy(value: DelegationPolicySnapshot) { policy = parseDelegationPolicySnapshot(value); },
    setSourceRevision(value: number) {
      if (!Number.isSafeInteger(value) || value <= sourceRevision) throw new RangeError('The source revision must advance.');
      sourceRevision = value;
    },
  };
}

export type ExampleHost = Awaited<ReturnType<typeof createExampleHost>>;
