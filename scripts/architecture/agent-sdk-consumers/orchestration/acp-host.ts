// ------------------------------------------------------------------------------------------------
//                acp-host.ts - Public registry, configuration, resource and inbox composition proof
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionId, type AgentSessionConfiguration } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderSession, type AgentSessionHostBinding, type AgentProviderRegistry, type MaterializedAgentProviderInstance } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver, type CreateNodeAcpProviderDriverOptions } from '@agen-ai/provider-acp/node';
import { AcpInstallationError, type AcpInstallationStore } from '@agen-ai/acp-registry/node';
import {
  createDelegationCoordinator, createInMemoryDelegationStore, DelegationOperationError,
  parseDelegationPolicySnapshot, parseDelegationTargetCatalog,
  type DelegationCompletionEnvelope, type DelegationHost, type DelegationParentScope,
} from '@agen-ai/agent-orchestration';
import { startDelegationMcpBridge } from '@agen-ai/agent-orchestration/mcp';
import type { InstalledFixture } from '../registry-provider/installation.js';
import { FixtureOwnership, ownCoordinator } from './acp-ownership.js';

export interface PeerReport {
  readonly pid: number;
  readonly mode: string;
  readonly cwd: string;
  readonly workingDirectory?: string;
  readonly methods: readonly string[];
  readonly toolNames: readonly string[];
  readonly toolCalls: readonly string[];
  readonly serverCount: number;
  readonly promptCount: number;
  readonly selectedModel: string;
  readonly exited: boolean;
  readonly failed?: boolean;
  readonly vendorRequests: number;
  readonly vendorMethodNotFoundReplies: number;
  readonly vendorRequestId?: string;
  readonly vendorReplyId?: string;
}

export async function peerReports(fixture: InstalledFixture): Promise<readonly PeerReport[]> {
  const prefix = basename(fixture.reportPath) + '.';
  const files = (await readdir(dirname(fixture.reportPath))).filter((file) => file.startsWith(prefix) && file.endsWith('.json'));
  assert.ok(files.length <= 16);
  return Promise.all(files.map(async (file) => {
    const bytes = await readFile(join(dirname(fixture.reportPath), file), 'utf8');
    assert.ok(Buffer.byteLength(bytes) <= 32_768);
    return JSON.parse(bytes) as PeerReport;
  }));
}

export const parentScope = (label: string): DelegationParentScope => ({ parentId: `synthetic-parent-${label}`, scopeId: 'synthetic-packed-host', revision: 1 });
export const initialConfiguration: AgentSessionConfiguration = { kind: 'selected',
  revision: parseAgentConfigurationRevisionId('synthetic-default-config'), catalogRevision: 1, selections: [] };

export async function createRetainedPeer(store: AcpInstallationStore, root: string, fixture: InstalledFixture, ownership: FixtureOwnership,
  options: Pick<CreateNodeAcpProviderDriverOptions, 'unknownExtensionPolicy'> = {}) {
  const reference = await store.acquire({ ...fixture.identity, ownerId: `managed-qualification-${fixture.mode}` });
  let registry: AgentProviderRegistry | undefined;
  let materialized: MaterializedAgentProviderInstance | undefined;
  let materializationEntered = false;
  let referenceReleased = false;
  let removeOnClose = false;
  let acquiredBindings = 0;
  let releasedBindings = 0;
  const owner = ownership.hold(`installation reference ${reference.ownerId}`, async () => {
    if (!referenceReleased) {
      if (registry) await registry.dispose();
      else if (materialized) await materialized.dispose();
      else if (materializationEntered) throw new Error('Materialization returned no native owner; process quiescence requires host investigation.');
      if (materializationEntered) {
        const reports = await peerReports(fixture);
        assert.ok(reports.length > 0 && reports.every((report) => report.exited), 'Every installed process must quiesce before reference release.');
        assert.equal(releasedBindings, acquiredBindings);
      }
      await store.release(reference);
      referenceReleased = true;
    }
    if (removeOnClose) await store.remove(fixture.identity);
  });
  try {
    const launch = await store.resolveLaunch(reference);
    const instanceId = parseAgentInstanceId(`synthetic-managed-${fixture.mode}`);
    const invocations: { sessionId: string; toolName: string }[] = [];
    const bridgeUrls = new Set<string>();
    const driver = createNodeAcpProviderDriver({ providerKey: `synthetic-managed-${fixture.mode}`,
      ...options,
      configuration: 'selectable', launch: { executable: launch.executable, args: launch.args,
        env: launch.env, cwd: root, shutdownTimeoutMs: 1_000 },
      limits: { initializationTimeoutMs: 5_000, cancellationTimeoutMs: 2_000 },
      sessionMcpBinding: { transport: 'http', async create(context) {
        acquiredBindings += 1;
        const facade = context.hostBinding;
        const bridge = await startDelegationMcpBridge({ signal: context.signal,
          requestTimeoutMs: 10_000, shutdownTimeoutMs: 1_000,
          binding: { ...facade, invoke(invocation) {
            invocations.push({ sessionId: context.sessionId, toolName: invocation.toolName });
            assert.ok(invocations.length <= 32);
            return facade.invoke(invocation);
          } } });
        assert.equal(bridgeUrls.has(bridge.server.url), false, 'Each session must receive an independent MCP endpoint.');
        bridgeUrls.add(bridge.server.url);
        return { mcpServers: [{ type: 'http' as const, name: bridge.server.name, url: bridge.server.url,
          headers: Object.entries(bridge.server.headers).map(([name, value]) => ({ name, value })) }],
        async release() { await bridge.release(); releasedBindings += 1; } };
      } },
    });
    const guardedDriver = { ...driver, async materialize(definition: Parameters<typeof driver.materialize>[0]) {
      materializationEntered = true;
      materialized = await driver.materialize(definition);
      return materialized;
    } };
    registry = await createAgentProviderRegistry({ drivers: [guardedDriver],
      definitions: [{ instanceId, providerKey: driver.providerKey, driverConfiguration: {} }] });
    const instance = registry.requireInstance(instanceId);
    removeOnClose = true;
    return { registry, instance, instanceId, fixture, launch, invocations, ownership,
      bindingCounts: () => ({ acquired: acquiredBindings, released: releasedBindings }),
      async assertRetained() {
        await assert.rejects(store.remove(fixture.identity), (error: unknown) => error instanceof AcpInstallationError && error.code === 'reference_active');
      },
      close: () => owner.release(),
    };
  } catch (error) { return ownership.unwind(owner, error); }
}
export type RetainedPeer = Awaited<ReturnType<typeof createRetainedPeer>>;

export async function createManagedHost(peer: RetainedPeer, installationStore: AcpInstallationStore, root: string) {
  const bootstrap = await peer.instance.adapter.createSession({ sessionId: parseAgentSessionId('synthetic-catalog-probe'),
    workingDirectory: root, configuration: initialConfiguration, onBindingCreated() {} });
  let field: { key: string; revision: number; initialOptionId: string; selectedOptionId: string };
  try {
    assert.equal(bootstrap.configuration.kind, 'selectable');
    if (bootstrap.configuration.kind !== 'selectable') throw new Error('The synthetic peer must expose session configuration.');
    const catalog = await bootstrap.configuration.listConfiguration();
    assert.equal(catalog.revision, 1);
    const model = catalog.fields.find((candidate) => candidate.label === 'Model');
    assert.ok(model && model.fieldKind === 'single_select' && model.scope === 'session' && model.applicationTiming === 'immediate');
    const selected = model.options.find((option) => option.label === 'Certified fixture model');
    assert.ok(selected);
    field = { key: model.key, revision: model.revision, initialOptionId: model.currentValue, selectedOptionId: selected.optionId };
  } finally { await bootstrap.close({ reason: 'shutdown' }); }
  const configuration: AgentSessionConfiguration = { kind: 'selected', revision: parseAgentConfigurationRevisionId('synthetic-certified-config'),
    catalogRevision: 1, selections: [{ key: field.key, fieldRevision: field.revision,
      value: { fieldKind: 'single_select', optionId: field.selectedOptionId } }] };
  const catalog = parseDelegationTargetCatalog({ catalogId: 'synthetic-acp-catalog', revision: 1,
    targets: [{ reference: { catalogId: 'synthetic-acp-catalog', catalogRevision: 1, targetId: 'certified-child', targetRevision: 1,
      sourceId: 'synthetic-approved-installation', sourceRevision: 1 }, instanceId: peer.instanceId,
      providerKey: peer.instance.capabilities.providerKey, modelId: 'synthetic-certified-model', label: 'Certified fixture model',
      options: [{ key: field.key, optionId: field.selectedOptionId }], reasoning: { kind: 'unknown' },
      executionMode: { kind: 'certified', value: 'standard' }, certification: { mappingId: 'synthetic-native-model-map', mappingRevision: 1 },
      availability: { kind: 'available' }, limitations: ['This fixture certifies model selection only; reasoning semantics remain unknown.'],
      application: { configuration, beforeFirstTurn: [] } }] });
  const policy = parseDelegationPolicySnapshot({ revision: 1, user: { enabled: true } });
  const envelopes = new Map<string, { envelope: DelegationCompletionEnvelope; inboxId: string; acceptedAt: string }>();
  let resourcesAcquired = 0;
  let resourcesReleased = 0;
  let grantsReleased = 0;
  const childResourceReleases = new Map<string, Promise<void>>();
  let referenceTail = Promise.resolve();
  function referenceOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = referenceTail.then(operation);
    referenceTail = result.then(() => undefined, () => undefined);
    return result;
  }
  const authorize = (scope: DelegationParentScope) => {
    if (!['A', 'B'].some((label) => JSON.stringify(parentScope(label)) === JSON.stringify(scope))) {
      throw new DelegationOperationError('policy_denied', 'The synthetic host does not authorize this parent scope.');
    }
  };
  const host: DelegationHost = {
    registry: peer.registry,
    currentPolicy(scope) { authorize(scope); return { scope, catalog, policy }; },
    assertResultAccess({ scope, task }) {
      authorize(scope);
      if (task && JSON.stringify(task.parent) !== JSON.stringify(scope)) throw new DelegationOperationError('policy_denied', 'The synthetic task belongs to another parent.');
    },
    assertControl({ scope, task }) { this.assertResultAccess({ scope, task }); },
    assertRequestAccess() { throw new Error('The synthetic peer exposes no requests.'); },
    acquireExecution({ scope, signal }) {
      authorize(scope); signal.throwIfAborted();
      let released = false;
      return { signal: new AbortController().signal, assertCurrent() { assert.equal(released, false); },
        release() { if (!released) { released = true; grantsReleased += 1; } } };
    },
    async acquireChildResources({ run, signal }) {
      signal.throwIfAborted();
      return referenceOperation(async () => {
        const ref = await installationStore.acquire({ ...peer.fixture.identity, ownerId: `managed-child-${run.runId}` });
        const directory = join(root, 'children', run.runId);
        let recordRelease!: () => void;
        const releaseReceipt = new Promise<void>((resolve) => { recordRelease = resolve; });
        let published = false;
        const owner = peer.ownership.hold(`child installation reference ${run.runId}`, async () => {
          const reports = (await peerReports(peer.fixture)).filter((report) => report.workingDirectory === directory);
          assert.ok(reports.every((report) => report.exited), 'A child installation reference cannot release before native process exit.');
          await installationStore.release(ref);
          if (published) resourcesReleased += 1;
        });
        try {
          assert.deepEqual(await installationStore.resolveLaunch(ref), peer.launch);
          await mkdir(directory, { recursive: true });
          signal.throwIfAborted();
          published = true;
          resourcesAcquired += 1;
          childResourceReleases.set(run.runId, releaseReceipt);
          return { workingDirectory: { policy: 'isolated' as const, authorizedRef: run.runId, path: directory },
            release: () => referenceOperation(async () => { await owner.release(); recordRelease(); }) };
        } catch (error) { return peer.ownership.unwind(owner, error); }
      });
    },
    verifyAppliedConfiguration({ target, observedConfiguration }) {
      const observed = observedConfiguration?.fields.find((candidate) => candidate.key === field.key);
      assert.ok(observed && observed.fieldKind === 'single_select');
      assert.equal(observed.currentValue, field.selectedOptionId);
      assert.equal(observed.scope, 'session');
      return { target: target.reference, configuration: target.application.configuration };
    },
    onRequest() { throw new Error('Unexpected synthetic native request.'); },
  };
  const store = createInMemoryDelegationStore({ limits: { runTimeoutMs: 10_000, queuedStartTimeoutMs: 10_000, maxWaitMs: 5_000, controlTimeoutMs: 2_000 } });
  const coordinator = await createDelegationCoordinator({ host, store, limits: store.limits, parentDelivery: {
    persistence: 'volatile',
    async accept({ envelope, signal }) {
      signal.throwIfAborted(); authorize(envelope.parent);
      const key = `${envelope.storeId}:${envelope.notificationId}`;
      const entry = envelopes.get(key) ?? { envelope, inboxId: randomUUID(), acceptedAt: new Date().toISOString() };
      envelopes.set(key, entry);
      return { status: 'accepted', inboxId: entry.inboxId, acceptedAt: entry.acceptedAt };
    },
    async inspect({ storeId, notificationId, parent, signal }) {
      signal.throwIfAborted(); authorize(parent);
      const entry = envelopes.get(`${storeId}:${notificationId}`);
      return entry ? { status: 'accepted', inboxId: entry.inboxId, acceptedAt: entry.acceptedAt } : { status: 'absent' };
    },
  } });
  const coordinatorOwner = ownCoordinator(peer.ownership, coordinator);
  return { coordinator, catalog, envelopes, field, close: () => coordinatorOwner.release(),
    waitForChildResourceRelease(runId: string): Promise<void> {
      const receipt = childResourceReleases.get(runId);
      assert.ok(receipt, 'The managed child must have an acquired resource receipt.');
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The managed child resource release did not settle.')), 5_000);
        void receipt.then(() => { clearTimeout(timer); resolve(); });
      });
    },
    counts: () => ({ acquired: resourcesAcquired, released: resourcesReleased, grantsReleased }) };
}

export async function openParent(peer: RetainedPeer, label: string, hostBinding: AgentSessionHostBinding): Promise<AgentProviderSession> {
  const session = await peer.instance.adapter.createSession({ sessionId: parseAgentSessionId(`synthetic-parent-session-${label}`),
    workingDirectory: dirname(peer.fixture.reportPath), configuration: initialConfiguration,
    hostBinding, onBindingCreated() {}, signal: AbortSignal.timeout(10_000) });
  const owner = peer.ownership.hold(`parent session ${label}`, async () => { await session.close({ reason: 'shutdown' }); });
  return { ...session, close: () => owner.release() };
}
