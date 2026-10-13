import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AcpRemoteError } from '@agen-ai/acp-transport';
import {
  parseAgentInstanceId, parseAgentSessionId, parseAgentTurnId,
  type AgentConfigurationCatalog, type AgentSessionConfiguration, type AgentItemSnapshot, type AgentRequest,
} from '@agen-ai/agent-protocol';
import {
  AgentProviderSessionCleanupError, createAgentProviderRegistry,
  type AgentProviderRegistry, type AgentProviderSession, type AgentProviderOutput, type AgentProviderTurnExecution, type AgentSessionHostBinding,
} from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import {
  createDelegationCoordinator, createDelegationHostBinding, createInMemoryDelegationStore,
  parseDelegationLimits, parseDelegationPolicySnapshot, parseDelegationTargetCatalog,
  type DelegationAdmissionReceipt, type DelegationClient, type DelegationCompletionEnvelope,
  type DelegationCoordinator, type DelegationHost, type DelegationParentDeliveryPort, type DelegationParentScope,
  type DelegationTargetReference,
} from '@agen-ai/agent-orchestration';
import { startDelegationMcpBridge } from '@agen-ai/agent-orchestration/mcp';
import {
  assertNativeOrdinaryResult, configureGrokSession, createGrokTarget, discoverGrokConfiguration,
  grokBootstrapConfiguration, grokOpeningConfiguration, nativeResultDigest, parseNativeToken,
  verifyGrokConfiguration, type GrokConfigurationSelection, NATIVE_CANCELLATION_PROMPT, NATIVE_CHILD_PROMPT, NATIVE_ORDINARY_PROMPT,
} from './grok.js';
import {
  NATIVE_QUALIFICATION_BUDGETS as B, NativeQualificationError,
  type DiscoverNativeConfigurationOptions, type NativeCleanupReceipt, type NativeDiscoveryResult,
  type NativeFailedGate, type NativeFailureReason, type NativeModeReport, type NativeModeResult,
  type NativeSessionObservation, type NativeToolObservation, type NativeTurnObservation, type NativeTurnPurpose, type NativeAdmissionObservation,
  type RunNativeQualificationModeOptions,
} from './host-contracts.js';
import type { NativeProcessAllocation } from './launch-contracts.js';
import { captureParentPermissionPolicy, selectManagedParentPermission, type NativeParentPermissionPolicy } from './permissions.js';
import type { NativeParentApprovalObservation } from './permission-contracts.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new NativeQualificationError('budget_exhausted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

function deadline(ms: number, outer?: AbortSignal): AbortSignal {
  return outer ? AbortSignal.any([outer, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

function reason(error: unknown, signal: AbortSignal): NativeFailureReason {
  if (error instanceof NativeQualificationError) return error.reason;
  // The pinned stable schema identifies authentication-required as -32000; it has no expired code.
  if (error instanceof AcpRemoteError && error.code === -32000) return 'authentication_failed';
  return signal.aborted ? 'budget_exhausted' : 'native_protocol_incompatible';
}

type MutableTurn = { -readonly [Key in keyof NativeTurnObservation]: NativeTurnObservation[Key] };
type MutableApproval = { -readonly [Key in keyof NativeParentApprovalObservation]: NativeParentApprovalObservation[Key] };
type MutableAdmission = { -readonly [Key in keyof NativeAdmissionObservation]: NativeAdmissionObservation[Key] };
type ToolCategory = keyof NativeAdmissionObservation['toolItems'];
const admissionClaimParts = ['{', '"admitted"', ':', 'true', '}'] as const;

function observedToolCategory(item: AgentItemSnapshot): ToolCategory | undefined {
  if (item.itemKind !== 'dynamic_tool_call' && item.itemKind !== 'mcp_tool_call') return undefined;
  switch (item.details?.toolName ?? item.title) {
    case 'search_tool': return 'search_tool';
    case 'use_tool': return 'use_tool';
    case 'agenai_delegation__delegation_targets': return 'managed_targets';
    case 'agenai_delegation__delegate_task': return 'managed_delegate';
    default: return 'other';
  }
}
interface PendingParentRequest {
  readonly request: AgentRequest;
  readonly turn: MutableTurn;
  readonly openedAt: number;
  readonly item?: Readonly<{ snapshot: AgentItemSnapshot; at: number }>;
}
interface HostState {
  readonly started: number;
  readonly registries: AgentProviderRegistry[];
  readonly sessions: Set<AgentProviderSession>;
  readonly bindings: Set<AgentSessionHostBinding>;
  readonly operations: Set<Promise<unknown>>;
  readonly lifetime: AbortController;
  readonly openingCleanup: Set<AgentProviderSessionCleanupError>;
  readonly failedOpenings: Map<AgentProviderSessionCleanupError, { sessionId: string; role: NativeSessionObservation['role'] }>;
  readonly lifecycle: NativeSessionObservation[];
  readonly turns: MutableTurn[];
  readonly childStarted: ReturnType<typeof deferred<MutableTurn>>;
  readonly cancellationStarted: ReturnType<typeof deferred<MutableTurn>>;
  readonly childResults: Map<string, string>;
  readonly approvals: MutableApproval[];
  readonly toolObservations: NativeToolObservation[];
  parentPermissionPolicy?: NativeParentPermissionPolicy;
  parentMcpServerName?: string;
  parentPending?: PendingParentRequest;
  resolvingApproval?: MutableApproval;
  coordinator?: DelegationCoordinator;
  selection?: GrokConfigurationSelection;
  parentPurpose: NativeTurnPurpose;
  childPurpose: 'child' | 'cancellation_child';
  configurationStarts: number;
  bridgesAcquired: number;
  bridgesReleased: number;
  admissionOpen: boolean;
  deliveryOpen: boolean;
  parentRunning: boolean;
  parentIdentity?: { sessionId: string; turnId: string };
  authority: boolean;
  retainedTextBytes: number;
  blockedRequest: boolean;
  cleanupWork?: Promise<NativeCleanupReceipt>;
}

function state(): HostState {
  return { started: performance.now(), registries: [], sessions: new Set(), bindings: new Set(), operations: new Set(), lifetime: new AbortController(), openingCleanup: new Set(), failedOpenings: new Map(), lifecycle: [], turns: [],
    childStarted: deferred(), cancellationStarted: deferred(), childResults: new Map(), approvals: [], toolObservations: [],
    parentPurpose: 'ordinary', childPurpose: 'child', configurationStarts: 0, bridgesAcquired: 0,
    bridgesReleased: 0, admissionOpen: true, deliveryOpen: true, parentRunning: false,
    authority: true, retainedTextBytes: 0, blockedRequest: false };
}

function now(owner: HostState): number { return performance.now() - owner.started; }

function track<T>(owner: HostState, work: Promise<T>): Promise<T> {
  owner.operations.add(work);
  void work.then(() => owner.operations.delete(work), () => owner.operations.delete(work));
  return work;
}

function assertAuthority(owner: HostState, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (!owner.authority) throw new NativeQualificationError('dispatch_uncertain');
}

async function createRegistry(owner: HostState, allocation: NativeProcessAllocation, role: 'parent' | 'child' | 'comparison' | 'discovery') {
  const driver = createNodeAcpProviderDriver({ providerKey: `native-grok-${role}`, configuration: 'selectable',
    launch: allocation.launch,
    limits: { initializationTimeoutMs: B.discoveryMs, promptTimeoutMs: B.delegationMs, cancellationTimeoutMs: 10_000 },
    ...(role !== 'parent' ? {} : { sessionMcpBinding: { transport: 'http' as const, async create(context) {
      const bridge = await startDelegationMcpBridge({ binding: context.hostBinding, signal: context.signal, shutdownTimeoutMs: 5_000 });
      owner.parentMcpServerName = bridge.server.name;
      owner.bridgesAcquired++;
      let released = false;
      return { mcpServers: [{ type: 'http' as const, name: bridge.server.name, url: bridge.server.url,
        headers: Object.entries(bridge.server.headers).map(([name, value]) => ({ name, value })) }],
      async release() { await bridge.release(); if (!released) { released = true; owner.bridgesReleased++; } } };
    } } }),
  });
  const observed = { ...driver, async materialize(definition: Parameters<typeof driver.materialize>[0]) {
    const instance = await driver.materialize(definition);
    const adapter = instance.adapter;
    return { ...instance, adapter: { ...adapter, async createSession(context: Parameters<typeof adapter.createSession>[0]) {
      if (owner.lifecycle.length > 509) throw new NativeQualificationError('budget_exhausted');
      if (role !== 'discovery') owner.lifecycle.push({ sessionId: context.sessionId, role, event: 'opening', at: now(owner) });
      let native: AgentProviderSession;
      try { native = await adapter.createSession(context); }
      catch (error) {
        if (error instanceof AgentProviderSessionCleanupError) {
          owner.openingCleanup.add(error);
          if (role !== 'discovery') owner.failedOpenings.set(error, { sessionId: context.sessionId, role });
        }
        throw error;
      }
      if (role !== 'discovery') owner.lifecycle.push({ sessionId: context.sessionId, role, event: 'opened', at: now(owner) });
      const configuration = native.configuration;
      let observation: { turn: MutableTurn; text: string; items: Map<string, { snapshot: AgentItemSnapshot; at: number; categories: Set<ToolCategory> }>;
        admission?: { summary: MutableAdmission; claimPart: number; claimOffset: number; claimMatches: boolean } } | undefined;
      async function* observe(outputs: AsyncIterable<AgentProviderOutput>): AsyncGenerator<AgentProviderOutput> {
        if (!observation) throw new NativeQualificationError('dispatch_uncertain');
        const current = observation;
        const { turn } = current;
        try {
          for await (const output of outputs) {
            if (output.kind === 'event') {
              const event = output.event;
              const approval = role === 'parent' ? owner.resolvingApproval : undefined;
              if (event.sessionId !== turn.sessionId || ('turnId' in event && event.turnId !== undefined && event.turnId !== turn.turnId)) {
                throw new NativeQualificationError('dispatch_uncertain');
              }
              if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
                if (!current.items.has(event.payload.itemId) && current.items.size >= 64) throw new NativeQualificationError('budget_exhausted');
                const categories = current.items.get(event.payload.itemId)?.categories ?? new Set<ToolCategory>();
                const category = observedToolCategory(event.payload);
                if (category && category !== 'other') categories.add(category);
                current.items.set(event.payload.itemId, { snapshot: event.payload, at: now(owner), categories });
              }
              if (event.type === 'content.delta' && event.payload.streamKind === 'assistant_text' && current.admission && event.payload.delta.length) {
                const admission = current.admission, summary = admission.summary;
                const bytes = summary.assistantTextBytes + Buffer.byteLength(event.payload.delta);
                const deltas = summary.assistantTextDeltas + 1;
                summary.textCapped ||= bytes > 8_192 || deltas > 512;
                summary.assistantTextBytes = Math.min(bytes, 8_192);
                summary.assistantTextDeltas = Math.min(deltas, 512);
                // Match the fixed claim without retaining arbitrary admission text, including across continuations.
                if (admission.claimMatches) for (const character of event.payload.delta) {
                  if (admission.claimOffset === 0 && (character === ' ' || character === '\t' || character === '\r' || character === '\n')) continue;
                  const part = admissionClaimParts[admission.claimPart];
                  if (character !== part?.[admission.claimOffset]) { admission.claimMatches = false; break; }
                  if (++admission.claimOffset === part!.length) { admission.claimPart++; admission.claimOffset = 0; }
                }
              }
              if (event.type === 'content.delta' && event.payload.streamKind === 'assistant_text'
                && (turn.purpose === 'ordinary' || turn.purpose === 'child' || turn.purpose === 'completion')) {
                current.text += event.payload.delta;
                if (Buffer.byteLength(current.text) > B.maxResultBytes) throw new NativeQualificationError('child_result_unavailable');
              }
              if (event.type === 'request.opened') {
                if (current.admission) current.admission.summary.requestCount = Math.min(current.admission.summary.requestCount + 1, 64);
                turn.outcome = 'pending_request';
                if (role === 'parent') {
                  if (owner.parentPending) throw new NativeQualificationError('approval_not_authorized');
                  const request = event.payload.request;
                  const item = request.requestKind === 'approval' && request.subject.kind !== 'plan'
                    ? current.items.get(request.subject.itemId) : undefined;
                  const openedAt = now(owner);
                  if (approval) {
                    approval.nextBoundaryAt = openedAt;
                    approval.nextBoundary = 'pending_request';
                    delete owner.resolvingApproval;
                  }
                  owner.parentPending = { request, turn, openedAt, ...(item ? { item } : {}) };
                } else owner.blockedRequest = true;
              }
              if (approval && event.type === 'turn.state_changed' && event.payload.state === 'running') {
                if (approval.runningAt !== undefined) throw new NativeQualificationError('approval_not_authorized');
                approval.runningAt = now(owner);
                turn.outcome = 'uncertain';
              }
              if (event.type === 'turn.completed') {
                turn.terminalAt = now(owner);
                turn.outcome = event.payload.outcome === 'completed' ? 'completed' : event.payload.outcome === 'canceled' ? 'canceled' : 'failed';
                if (approval) {
                  approval.nextBoundaryAt = turn.terminalAt;
                  approval.nextBoundary = turn.outcome;
                  delete owner.resolvingApproval;
                }
              }
            }
            yield output;
          }
          if (turn.outcome === 'completed' && (turn.purpose === 'ordinary' || turn.purpose === 'child' || turn.purpose === 'completion')) {
            if (turn.purpose === 'ordinary') assertNativeOrdinaryResult(current.text); else parseNativeToken(current.text);
            owner.retainedTextBytes += Buffer.byteLength(current.text);
            if (owner.retainedTextBytes > B.maxRetainedTextBytes) throw new NativeQualificationError('budget_exhausted');
            turn.resultText = current.text;
            if (role === 'child') owner.childResults.set(context.sessionId, current.text);
          }
        } finally {
          turn.settledAt = now(owner);
          if (current.admission) {
            const { summary, claimMatches, claimPart } = current.admission;
            const counts: { -readonly [Key in ToolCategory]: number } = { search_tool: 0, use_tool: 0, managed_targets: 0, managed_delegate: 0, other: 0 };
            for (const item of current.items.values()) if (observedToolCategory(item.snapshot)) {
              const category = item.categories.size === 1 ? item.categories.values().next().value! : 'other';
              counts[category]++;
            }
            summary.toolItems = counts;
            summary.response = summary.assistantTextBytes === 0 ? 'none'
              : claimMatches && claimPart === admissionClaimParts.length ? 'admitted_true' : 'other_text';
          }
        }
      }
      const wrapped: AgentProviderSession = { ...native,
        ...(configuration.kind !== 'selectable' ? {} : { configuration: { ...configuration,
          applyConfigurationSelection(input) { return configuration.applyConfigurationSelection({ ...input,
            onProviderExecutionStarted() { input.onProviderExecutionStarted?.(); owner.configurationStarts++; } }); },
        } }),
        startTurn(input) {
          assertAuthority(owner, input.signal);
          if (owner.turns.length >= B.maxTurns || (role !== 'parent' && role !== 'child')) throw new NativeQualificationError('budget_exhausted');
          if (!owner.selection || native.configuration.kind !== 'selectable') throw new NativeQualificationError('configuration_unknown');
          const selection = owner.selection;
          let execution: AgentProviderTurnExecution | undefined;
          return { turnId: input.turnId,
            outputs: (async function* () {
              const currentConfiguration = await readConfiguration(native, input.signal ?? owner.lifetime.signal);
              verifyGrokConfiguration(currentConfiguration, selection);
              const configurationVerifiedAt = now(owner);
              const purpose = role === 'parent' ? owner.parentPurpose : owner.childPurpose;
              const turn: MutableTurn = { role, purpose, sessionId: context.sessionId, turnId: input.turnId,
                enteredAt: now(owner), configurationCatalogRevision: currentConfiguration.revision,
                configurationVerifiedAt, settledAt: now(owner), outcome: 'uncertain' };
              owner.turns.push(turn);
              if (role === 'parent') owner.parentIdentity = { sessionId: context.sessionId, turnId: input.turnId };
              const admission = purpose === 'admission' || purpose === 'cancellation_admission' ? {
                summary: { assistantTextBytes: 0, assistantTextDeltas: 0, textCapped: false, requestCount: 0,
                  toolItems: { search_tool: 0, use_tool: 0, managed_targets: 0, managed_delegate: 0, other: 0 }, response: 'none' as const },
                claimPart: 0, claimOffset: 0, claimMatches: true } : undefined;
              if (admission) turn.admissionObservation = admission.summary;
              observation = { turn, text: '', items: new Map(), ...(admission ? { admission } : {}) };
              execution = native.startTurn({ ...input, onProviderExecutionStarted() {
                input.onProviderExecutionStarted?.();
                assertAuthority(owner, input.signal);
                if (role === 'child' && owner.parentRunning) throw new NativeQualificationError('dispatch_uncertain');
                turn.providerStartedAt = now(owner);
                if (role === 'child') (purpose === 'child' ? owner.childStarted : owner.cancellationStarted).resolve(turn);
              } });
              yield* observe(execution.outputs);
            })(),
            async resolveRequest(response) {
              assertAuthority(owner, response.signal);
              const approval = role === 'parent' ? owner.resolvingApproval : undefined;
              if (!execution || role === 'parent' && (!approval || !owner.parentRunning || !observation
                || approval.parentTurnId !== observation.turn.turnId || approval.parentSessionId !== context.sessionId)) {
                throw new NativeQualificationError('approval_not_authorized');
              }
              if (approval) {
                if (response.resolution.requestKind !== 'approval' || response.resolution.disposition !== 'selected'
                  || response.resolution.requestId !== approval.requestId || response.resolution.optionId !== approval.offeredOption.optionId) {
                  throw new NativeQualificationError('approval_not_authorized');
                }
                approval.selectedOptionId = response.resolution.optionId;
                approval.deliveryStartedAt = now(owner);
              }
              const receipt = await execution.resolveRequest(response);
              if (approval) {
                approval.deliverySettledAt = now(owner);
                approval.deliveryStatus = receipt.status;
                if (receipt.status === 'rejected') approval.requestState = receipt.requestState;
              }
              return receipt;
            },
          };
        },
        async close(input) {
          await native.close(input);
          if (owner.sessions.delete(wrapped) && role !== 'discovery') owner.lifecycle.push({ sessionId: context.sessionId, role, event: 'closed', at: now(owner) });
        },
      };
      owner.sessions.add(wrapped);
      return wrapped;
    } } };
  } };
  const instanceId = parseAgentInstanceId(`native-grok:${role}`);
  const registry = await createAgentProviderRegistry({ drivers: [observed],
    definitions: [{ instanceId, providerKey: driver.providerKey, driverConfiguration: {} }] });
  owner.registries.push(registry);
  return { registry, instance: registry.requireInstance(instanceId), instanceId, providerKey: driver.providerKey };
}

async function openSession(owner: HostState, provider: Awaited<ReturnType<typeof createRegistry>>, allocation: NativeProcessAllocation,
  configuration: AgentSessionConfiguration, signal: AbortSignal, hostBinding?: AgentSessionHostBinding) {
  const sessionId = parseAgentSessionId(`native:${allocation.role}:${randomUUID()}`);
  const work = Promise.resolve().then(() => provider.instance.adapter.createSession({ sessionId,
    workingDirectory: allocation.workingDirectory, configuration, onBindingCreated() {}, signal,
    ...(hostBinding ? { hostBinding } : {}) })).catch((error: unknown) => {
      if (error instanceof AgentProviderSessionCleanupError) {
        owner.openingCleanup.add(error);
        if (allocation.role !== 'discovery') owner.failedOpenings.set(error, { sessionId, role: allocation.role });
      }
      throw error;
    });
  return track(owner, work);
}

async function verifyExecutable(options: Pick<DiscoverNativeConfigurationOptions, 'executable'>): Promise<void> {
  try { await options.executable.assertUnchanged(); }
  catch { throw new NativeQualificationError('artifact_identity_drift'); }
}

async function cleanup(owner: HostState): Promise<NativeCleanupReceipt> {
  const started = performance.now();
  const pendingReceipt = (): NativeCleanupReceipt => ({ status: 'pending', coordinatorClosed: false, sessionsClosed: false,
    registriesClosed: false, bridgesAcquired: owner.bridgesAcquired, bridgesReleased: owner.bridgesReleased,
    elapsedMs: performance.now() - started });
  if (owner.cleanupWork) return bounded(owner.cleanupWork, deadline(B.cleanupMs)).catch(pendingReceipt);
  owner.admissionOpen = false;
  owner.deliveryOpen = false;
  owner.authority = false;
  owner.lifetime.abort(new NativeQualificationError('budget_exhausted'));
  const work = async (): Promise<NativeCleanupReceipt> => {
    // Do not report quiescence while a timed-out opening/configuration producer can still publish an owner.
    await Promise.allSettled([...owner.operations]);
    let coordinatorClosed = !owner.coordinator;
    if (owner.coordinator) coordinatorClosed = (await owner.coordinator.dispose({ mode: 'cancel', timeoutMs: B.cleanupMs })).status === 'closed';
    if (!coordinatorClosed) return { status: 'pending', coordinatorClosed, sessionsClosed: false, registriesClosed: false,
      bridgesAcquired: owner.bridgesAcquired, bridgesReleased: owner.bridgesReleased, elapsedMs: performance.now() - started };
    const sessionResults = await Promise.allSettled([...owner.sessions].map((session) => session.close({ reason: 'shutdown' })));
    const openingResults = await Promise.allSettled([...owner.openingCleanup].map(async (error) => {
      await error.retryCleanup(); owner.openingCleanup.delete(error);
      const opening = owner.failedOpenings.get(error);
      if (opening) { owner.lifecycle.push({ ...opening, event: 'closed', at: now(owner) }); owner.failedOpenings.delete(error); }
    }));
    const sessionsClosed = sessionResults.every((result) => result.status === 'fulfilled') && openingResults.every((result) => result.status === 'fulfilled');
    let bindingsClosed = false;
    if (sessionsClosed) bindingsClosed = (await Promise.allSettled([...owner.bindings].map(async (binding) => { await binding.release(); owner.bindings.delete(binding); }))).every((result) => result.status === 'fulfilled');
    let registriesClosed = false;
    if (sessionsClosed && bindingsClosed) registriesClosed = (await Promise.allSettled(owner.registries.map((registry) => registry.dispose()))).every((result) => result.status === 'fulfilled');
    return { status: sessionsClosed && bindingsClosed && registriesClosed && owner.bridgesAcquired === owner.bridgesReleased ? 'closed' : 'pending',
      coordinatorClosed, sessionsClosed, registriesClosed, bridgesAcquired: owner.bridgesAcquired,
      bridgesReleased: owner.bridgesReleased, elapsedMs: performance.now() - started };
  };
  owner.cleanupWork = work().catch(pendingReceipt).then((receipt) => { if (receipt.status === 'pending') delete owner.cleanupWork; return receipt; });
  return bounded(owner.cleanupWork, deadline(B.cleanupMs)).catch(pendingReceipt);
}

function retry(owner: HostState): () => Promise<void> {
  return async () => { if ((await cleanup(owner)).status !== 'closed') throw new NativeQualificationError('cleanup_pending'); };
}

export async function discoverNativeConfiguration(options: DiscoverNativeConfigurationOptions): Promise<NativeDiscoveryResult> {
  const owner = state();
  const signal = deadline(B.discoveryMs, options.signal ? AbortSignal.any([options.signal, owner.lifetime.signal]) : owner.lifetime.signal);
  let configuration;
  let capabilities;
  let failure: NativeFailureReason | undefined;
  try {
    await verifyExecutable(options);
    if (!options.allocation.environmentKeys.includes('XAI_API_KEY')) throw new NativeQualificationError('credential_unavailable');
    const provider = await bounded(track(owner, createRegistry(owner, options.allocation, 'discovery')), signal);
    capabilities = provider.instance.capabilities;
    const session = await bounded(openSession(owner, provider, options.allocation, grokBootstrapConfiguration, signal), signal);
    configuration = await bounded(track(owner, discoverGrokConfiguration({ session, choice: options.choice, signal, onConfigurationStart() {} })), signal);
  } catch (error) { failure = reason(error, signal); }
  const receipt = await cleanup(owner);
  if (receipt.status !== 'closed') failure = 'cleanup_pending';
  return { report: { version: 1, outcome: failure ? failure === 'cleanup_pending' ? 'cleanup_pending' : 'blocked' : 'qualified',
    ...(failure ? { reason: failure } : {}), failedGates: failure ? [{ gate: failure === 'cleanup_pending' ? 'cleanup' : 'configuration', reason: failure }] : [],
    noPrompt: true, elapsedMs: now(owner), ...(capabilities ? { capabilities: structuredClone(capabilities) } : {}), ...(configuration ? { configuration: structuredClone(configuration) } : {}),
    modelAcknowledged: !!configuration, reasoningAcknowledged: !!configuration, configurationStarts: owner.configurationStarts, cleanup: receipt },
    ...(receipt.status === 'closed' ? {} : { retryCleanup: retry(owner) }) };
}

async function readConfiguration(session: AgentProviderSession, signal: AbortSignal): Promise<AgentConfigurationCatalog> {
  if (session.configuration.kind !== 'selectable') throw new NativeQualificationError('configuration_unknown');
  return session.configuration.listConfiguration({ signal });
}

async function runParent(owner: HostState, session: AgentProviderSession, purpose: NativeTurnPurpose, prompt: string, signal: AbortSignal): Promise<MutableTurn> {
  assertAuthority(owner, signal);
  if (owner.parentRunning) throw new NativeQualificationError('dispatch_uncertain');
  owner.parentRunning = true;
  owner.parentPurpose = purpose;
  const turnId = parseAgentTurnId(`native-parent:${randomUUID()}`);
  try {
    const execution = session.startTurn({ turnId, interactionMode: 'default', parts: [{ type: 'text', text: prompt }], signal,
      deadlineAt: new Date(Date.now() + Math.min(B.ordinaryMs, B.modeMs - now(owner))).toISOString(),
      onProviderExecutionStarted() { assertAuthority(owner, signal); if (!owner.parentRunning) throw new NativeQualificationError('dispatch_uncertain'); } });
    for await (const output of execution.outputs) {
      if (output.kind !== 'event' || output.event.type !== 'request.opened') continue;
      const pending = owner.parentPending;
      try {
        assertAuthority(owner, signal);
        if (!pending || !owner.parentPermissionPolicy || owner.parentMcpServerName !== 'agenai_delegation' || !owner.admissionOpen || owner.approvals.length >= 4
          || (purpose !== 'admission' && purpose !== 'cancellation_admission') || pending.turn.turnId !== turnId
          || owner.parentIdentity?.sessionId !== pending.turn.sessionId || owner.parentIdentity.turnId !== turnId
          || pending.request.requestKind !== 'approval' || !pending.item) throw new NativeQualificationError('approval_not_authorized');
        const selected = selectManagedParentPermission(pending.request, pending.item.snapshot);
        const sameTurn = (tool: { parentSessionId: string; parentTurnId: string }) => tool.parentSessionId === pending.turn.sessionId && tool.parentTurnId === turnId;
        if (owner.approvals.some((approval) => sameTurn(approval) && approval.toolName === selected.toolName)
          || owner.toolObservations.some((tool) => sameTurn(tool) && tool.toolName === selected.toolName)
          || (selected.toolName === 'delegate_task' && !owner.toolObservations.some((tool) => sameTurn(tool)
            && tool.toolName === 'delegation_targets' && tool.status === 'success'))) throw new NativeQualificationError('approval_not_authorized');
        const approval: MutableApproval = { parentSessionId: pending.turn.sessionId, parentTurnId: turnId, purpose,
          requestId: pending.request.requestId, itemId: selected.item.itemId, toolName: selected.toolName,
          title: pending.request.subject.title, itemKind: 'dynamic_tool_call', itemStatus: selected.itemStatus,
          itemObservedAt: pending.item.at, openedAt: pending.openedAt, requestObservedAt: now(owner),
          offeredOption: { optionId: selected.option.optionId, label: 'allow once', decision: 'approved', persistence: 'once', scopeKind: 'exact_action' } };
        owner.approvals.push(approval);
        delete owner.parentPending;
        owner.resolvingApproval = approval;
        const receipt = await execution.resolveRequest({ resolution: { requestKind: 'approval', requestId: pending.request.requestId,
          disposition: 'selected', optionId: selected.option.optionId }, signal });
        if (receipt.status !== 'delivered') throw new NativeQualificationError('approval_not_authorized');
      } catch (error) { owner.blockedRequest = true; throw error; }
    }
    if (owner.approvals.some((approval) => approval.parentTurnId === turnId
      && (approval.runningAt === undefined || !approval.invocationId))) throw new NativeQualificationError('approval_not_authorized');
    const turn = owner.turns.find((item) => item.turnId === turnId);
    if (!turn || turn.outcome !== 'completed' || turn.providerStartedAt === undefined || turn.terminalAt === undefined || owner.blockedRequest) {
      throw new NativeQualificationError(owner.blockedRequest ? 'approval_not_authorized' : 'dispatch_uncertain');
    }
    return turn;
  } finally { owner.parentRunning = false; delete owner.parentIdentity; delete owner.resolvingApproval; }
}

function admissionPrompt(operationId: string, cancel: boolean): string {
  return `Use the managed MCP tools on this session's agenai_delegation server. You may use your native MCP search, schema-discovery and invocation wrappers to find and call those tools. Your first managed-tool call must be delegation_targets; choose its exact standard, low reasoning target. Then call delegate_task exactly once using operationId ${JSON.stringify(operationId)}, the returned exact target reference and expectedPolicyRevision, completionPolicy ${JSON.stringify(cancel ? 'collect' : 'automatic')}, timeoutMs ${B.delegationMs}, and this exact prompt string: ${JSON.stringify(cancel ? NATIVE_CANCELLATION_PROMPT : NATIVE_CHILD_PROMPT)}. Do not supply context or invoke other managed tools, filesystem, shell, web, or native-subagent tools. End this parent turn immediately after the real admission result; the host dispatches the child after your turn ends. Report the taskId and runId returned by delegate_task. If you cannot invoke the tools, explain the obstacle instead of claiming admission. Do not simulate tool execution or invent a receipt.`;
}

export async function runNativeQualificationMode(options: RunNativeQualificationModeOptions): Promise<NativeModeResult> {
  const owner = state();
  owner.selection = options.selection;
  const signal = deadline(B.modeMs, options.signal ? AbortSignal.any([options.signal, owner.lifetime.signal]) : owner.lifetime.signal);
  const tools = owner.toolObservations;
  const admissions: DelegationAdmissionReceipt[] = [];
  const childConfigurations: AgentConfigurationCatalog[] = [];
  const failedGates: NativeFailedGate[] = [];
  let gate: NativeFailedGate['gate'] = 'opening';
  let parentConfiguration: AgentConfigurationCatalog | undefined;
  let boundParentScope: DelegationParentScope | undefined;
  let scope: NativeModeReport['scope'];
  let dispatchGate: NativeModeReport['dispatchGate'];
  let child: NativeModeReport['child'];
  let delivery: NativeModeReport['delivery'];
  let cancellation: NativeModeReport['cancellation'] = { status: 'not_started' };
  let failure: NativeFailureReason | undefined;
  let delegationStartedAt: number | undefined;
  let dispatch = deferred<void>();
  let gateReleasedAt = 0;
  let retained: { envelope: DelegationCompletionEnvelope; inboxId: string; acceptedAt: string; at: number } | undefined;
  const accepted = deferred<void>();
  let activeOperation = '';
  let admissionPending = false;
  let toolInvocations = 0;
  let phaseAdmission: DelegationAdmissionReceipt | undefined;
  let client: DelegationClient | undefined;
  try {
    const parentPermissionPolicy = captureParentPermissionPolicy(options.parentPermissionPolicy, options.executable.identity.sha256);
    if (parentPermissionPolicy) owner.parentPermissionPolicy = parentPermissionPolicy;
    await verifyExecutable(options);
    const allocations = Object.values(options.allocations);
    if (new Set(allocations.map((allocation) => allocation.allocationId)).size !== 3
      || new Set(allocations.map((allocation) => allocation.workingDirectory)).size !== 3
      || options.allocations.parent.role !== 'parent' || options.allocations.child.role !== 'child'
      || options.allocations.comparison.role !== 'comparison') throw new NativeQualificationError('configuration_scope_unverified');
    if (allocations.some((allocation) => !allocation.environmentKeys.includes('XAI_API_KEY'))) throw new NativeQualificationError('credential_unavailable');
    const parentProvider = await bounded(track(owner, createRegistry(owner, options.allocations.parent, 'parent')), signal);
    const childProvider = await bounded(track(owner, createRegistry(owner, options.allocations.child, 'child')), signal);
    const comparisonProvider = await bounded(track(owner, createRegistry(owner, options.allocations.comparison, 'comparison')), signal);
    const target = createGrokTarget({ instanceId: childProvider.instanceId, providerKey: childProvider.providerKey,
      selection: options.selection, mapping: options.mapping });
    const parentScope = { parentId: 'native-parent', scopeId: `native:${randomUUID()}`, revision: 1 };
    boundParentScope = parentScope;
    const policy = parseDelegationPolicySnapshot({ revision: 1, user: { enabled: true } });
    const catalog = parseDelegationTargetCatalog({ catalogId: target.reference.catalogId, revision: target.reference.catalogRevision, targets: [target] });
    const assertScope = (candidate: typeof parentScope) => { assertAuthority(owner); if (!isDeepStrictEqual(candidate, parentScope)) throw new NativeQualificationError('dispatch_uncertain'); };
    const host: DelegationHost = {
      registry: childProvider.registry,
      currentPolicy(current) { assertScope(current); return { scope: parentScope, policy, catalog }; },
      assertResultAccess({ scope: current }) { assertScope(current); },
      assertControl({ scope: current }) { assertScope(current); },
      assertRequestAccess({ task }) { assertScope(task.parent); },
      async acquireExecution(input) {
        assertScope(input.scope);
        await bounded(dispatch.promise, AbortSignal.any([signal, input.signal]));
        if (owner.parentRunning) throw new NativeQualificationError('dispatch_uncertain');
        return { signal, assertCurrent() { assertScope(input.scope); signal.throwIfAborted(); }, release() {} };
      },
      acquireChildResources(input) { assertScope(input.scope); return { workingDirectory: { policy: 'isolated',
        authorizedRef: options.allocations.child.allocationId, path: options.allocations.child.workingDirectory }, release() {} }; },
      verifyAppliedConfiguration(input) {
        assertScope(input.task.parent);
        if (!input.observedConfiguration) throw new NativeQualificationError('configuration_unknown');
        verifyGrokConfiguration(input.observedConfiguration, options.selection);
        childConfigurations.push(input.observedConfiguration);
        return { target: target.reference, configuration: target.application.configuration };
      },
      async onRequest(input) {
        owner.blockedRequest = true;
        if (!owner.coordinator) throw new NativeQualificationError('approval_not_authorized');
        await owner.coordinator.resolveRequest({ handle: input.handle, operationId: randomUUID(),
          resolution: { requestKind: input.request.requestKind, requestId: input.request.requestId, disposition: 'canceled' } });
      },
    };
    const parentDelivery: DelegationParentDeliveryPort = {
      persistence: 'volatile',
      async accept({ envelope, signal: incoming }) {
        incoming.throwIfAborted(); assertScope(envelope.parent);
        if (!owner.deliveryOpen) return { status: 'rejected', reason: 'parent_retired' };
        if (retained && !isDeepStrictEqual(retained.envelope, envelope)) return { status: 'rejected', reason: 'dismissed' };
        if (envelope.outcome.kind !== 'succeeded' || envelope.outcome.result.truncated || envelope.outcome.result.references.length) {
          return { status: 'rejected', reason: 'dismissed' };
        }
        parseNativeToken(envelope.outcome.result.text);
        retained ??= { envelope, inboxId: randomUUID(), acceptedAt: new Date().toISOString(), at: now(owner) };
        accepted.resolve();
        return { status: 'accepted', inboxId: retained.inboxId, acceptedAt: retained.acceptedAt };
      },
      async inspect(input) { input.signal.throwIfAborted(); assertScope(input.parent);
        return retained?.envelope.storeId === input.storeId && retained.envelope.notificationId === input.notificationId
          ? { status: 'accepted', inboxId: retained.inboxId, acceptedAt: retained.acceptedAt } : { status: 'absent' }; },
    };
    const limits = parseDelegationLimits({ maxActiveRuns: 1, maxQueuedRuns: 1, maxDepth: 1, maxTasks: 2, maxRuns: 2,
      maxRunsPerTask: 1, runTimeoutMs: B.delegationMs, queuedStartTimeoutMs: B.ordinaryMs, maxWaitMs: 30_000 });
    owner.coordinator = await createDelegationCoordinator({ host, limits, store: createInMemoryDelegationStore({ limits }), parentDelivery });
    client = await owner.coordinator.bindParent({ scope: parentScope });
    const actualClient = client;
    const binding = await createDelegationHostBinding({ client: { ...actualClient, async spawn(input) {
      assertAuthority(owner, signal);
      const expected = owner.childPurpose === 'child' ? NATIVE_CHILD_PROMPT : NATIVE_CANCELLATION_PROMPT;
      if (!owner.admissionOpen || !owner.parentRunning || phaseAdmission || admissionPending || input.operationId !== activeOperation
        || input.expectedPolicyRevision !== policy.revision || !isDeepStrictEqual(input.target, target.reference)
        || input.input.parts.length !== 1 || input.input.parts[0]?.type !== 'text' || input.input.parts[0].text !== expected
        || input.completionPolicy !== (owner.childPurpose === 'child' ? 'automatic' : 'collect') || input.timeoutMs !== B.delegationMs) {
        throw new NativeQualificationError('parent_did_not_delegate');
      }
      admissionPending = true;
      try { phaseAdmission = await actualClient.spawn(input); admissions.push(phaseAdmission); return phaseAdmission; }
      finally { admissionPending = false; }
    } } });
    if (!binding) throw new NativeQualificationError('mcp_tools_unexposed');
    owner.bindings.add(binding);
    const observedBinding: AgentSessionHostBinding = { ...binding, async invoke(input) {
      if (toolInvocations >= 64) {
        owner.lifetime.abort(new NativeQualificationError('budget_exhausted'));
        return { kind: 'error', error: { category: 'unknown', code: 'capacity_exceeded', message: 'The qualification observation limit was reached.', recovery: { kind: 'unknown' } } };
      }
      toolInvocations++;
      const parentIdentity = owner.parentIdentity;
      const allowed = input.toolName === 'delegation_targets' || input.toolName === 'delegate_task';
      const result: Awaited<ReturnType<AgentSessionHostBinding['invoke']>> = allowed && owner.admissionOpen && owner.parentRunning ? await binding.invoke(input)
        : { kind: 'error', error: { category: 'unknown', code: 'policy_denied', message: 'This qualification permits target discovery and one exact admission per phase.', recovery: { kind: 'unknown' } } };
      let offeredTarget: DelegationTargetReference | undefined;
      if (input.toolName === 'delegation_targets' && result.kind === 'success') {
        const page = result.value;
        if (!page || typeof page !== 'object' || Array.isArray(page) || !('targets' in page)) {
          throw new NativeQualificationError('parent_did_not_delegate');
        }
        const targets = page.targets;
        if (!Array.isArray(targets) || targets.length !== 1) throw new NativeQualificationError('parent_did_not_delegate');
        const offered: unknown = targets[0];
        if (!offered || typeof offered !== 'object' || Array.isArray(offered) || !('reference' in offered)) throw new NativeQualificationError('parent_did_not_delegate');
        offeredTarget = parseDelegationTargetCatalog({ ...catalog, targets: [{ ...target, reference: offered.reference }] }).targets[0]!.reference;
        if (!isDeepStrictEqual(offeredTarget, target.reference)) throw new NativeQualificationError('parent_did_not_delegate');
      }
      if (parentIdentity && binding.tools.some((tool) => tool.name === input.toolName)) tools.push({
        parentSessionId: parentIdentity.sessionId, parentTurnId: parentIdentity.turnId, invocationId: input.invocationId,
        toolName: input.toolName as NativeToolObservation['toolName'], at: now(owner), status: result.kind,
        ...(offeredTarget ? { target: offeredTarget } : {}),
        ...(input.toolName === 'delegate_task' && result.kind === 'success' && phaseAdmission ? { admission: phaseAdmission, target: target.reference } : {}) });
      const approval = owner.resolvingApproval;
      if (approval && parentIdentity && approval.parentSessionId === parentIdentity.sessionId
        && approval.parentTurnId === parentIdentity.turnId && approval.toolName === input.toolName && result.kind === 'success') {
        if (approval.invocationId) throw new NativeQualificationError('approval_not_authorized');
        approval.invocationId = input.invocationId;
      }
      return result;
    } };
    const parent = await bounded(openSession(owner, parentProvider, options.allocations.parent,
      grokOpeningConfiguration(options.selection), signal, observedBinding), signal);
    gate = 'configuration';
    parentConfiguration = await bounded(track(owner, configureGrokSession({ session: parent, selection: options.selection, signal, onConfigurationStart() {} })), signal);
    gate = 'ordinary';
    await runParent(owner, parent, 'ordinary', NATIVE_ORDINARY_PROMPT, deadline(B.ordinaryMs, signal));
    gate = 'scope';
    const parentBeforeChild = await readConfiguration(parent, signal);
    const parentFilesBeforeChild = await options.allocations.parent.configurationFilesSnapshot();
    const comparisonBefore = await bounded(openSession(owner, comparisonProvider, options.allocations.comparison, grokBootstrapConfiguration, signal), signal);
    const comparisonBeforeChild = await readConfiguration(comparisonBefore, signal);
    const comparisonFilesBeforeChild = await options.allocations.comparison.configurationFilesSnapshot();
    await comparisonBefore.close({ reason: 'shutdown' });
    if (!isDeepStrictEqual(comparisonBeforeChild, options.selection.initial)) throw new NativeQualificationError('configuration_scope_unverified');
    gate = 'delegation';
    delegationStartedAt = now(owner);
    const delegationSignal = deadline(B.delegationMs, signal);
    activeOperation = randomUUID();
    const admissionTurn = await runParent(owner, parent, 'admission', admissionPrompt(activeOperation, false), deadline(B.ordinaryMs, delegationSignal));
    if (!phaseAdmission || !tools.some((tool) => tool.toolName === 'delegation_targets' && tool.status === 'success')
      || !tools.some((tool) => tool.toolName === 'delegate_task' && tool.status === 'success')) throw new NativeQualificationError('parent_did_not_delegate');
    owner.admissionOpen = false;
    gateReleasedAt = now(owner); dispatch.resolve();
    const started = await bounded(owner.childStarted.promise, delegationSignal);
    dispatchGate = { parentTurnId: admissionTurn.turnId, parentSettledAt: admissionTurn.settledAt, releasedAt: gateReleasedAt,
      childProviderStartedAt: started.providerStartedAt!, verified: admissionTurn.settledAt <= gateReleasedAt && gateReleasedAt <= started.providerStartedAt! };
    if (!dispatchGate.verified) throw new NativeQualificationError('dispatch_uncertain');
    let settled = await bounded(client.wait({ taskId: phaseAdmission.taskId, timeoutMs: 30_000, signal: delegationSignal }), delegationSignal);
    while (settled.status === 'timeout') settled = await bounded(client.wait({ taskId: phaseAdmission.taskId, timeoutMs: 30_000, signal: delegationSignal }), delegationSignal);
    const outcome = settled.task.runs.items.find((run) => run.runId === phaseAdmission!.runId)?.outcome;
    const text = owner.childResults.get(started.sessionId);
    if (owner.blockedRequest) throw new NativeQualificationError('approval_not_authorized');
    if (outcome?.kind !== 'succeeded' || outcome.result.truncated || outcome.result.references.length
      || !text || outcome.result.text !== text || started.outcome !== 'completed') throw new NativeQualificationError('child_result_unavailable');
    const token = parseNativeToken(text);
    child = { taskId: phaseAdmission.taskId, runId: phaseAdmission.runId, sessionId: started.sessionId, turnId: started.turnId,
      token, resultDigest: nativeResultDigest(text) };
    gate = 'scope';
    const parentAfterChild = await readConfiguration(parent, signal);
    const parentFilesAfterChild = await options.allocations.parent.configurationFilesSnapshot();
    const comparisonAfter = await bounded(openSession(owner, comparisonProvider, options.allocations.comparison, grokBootstrapConfiguration, signal), signal);
    const comparisonAfterChild = await readConfiguration(comparisonAfter, signal);
    const comparisonFilesAfterChild = await options.allocations.comparison.configurationFilesSnapshot();
    await comparisonAfter.close({ reason: 'shutdown' });
    const verified = isDeepStrictEqual(parentBeforeChild, parentAfterChild) && isDeepStrictEqual(comparisonBeforeChild, comparisonAfterChild)
      && isDeepStrictEqual(parentFilesBeforeChild, parentFilesAfterChild) && isDeepStrictEqual(comparisonFilesBeforeChild, comparisonFilesAfterChild);
    scope = { verified, parentBeforeChild, parentAfterChild, comparisonBeforeChild, comparisonAfterChild, parentFilesBeforeChild,
      parentFilesAfterChild, comparisonFilesBeforeChild, comparisonFilesAfterChild };
    if (!verified) throw new NativeQualificationError('configuration_scope_unverified');
    gate = 'delivery';
    await bounded(accepted.promise, delegationSignal);
    if (!retained || retained.envelope.taskId !== child.taskId || retained.envelope.runId !== child.runId
      || retained.envelope.outcome.kind !== 'succeeded' || retained.envelope.outcome.result.text !== text) throw new NativeQualificationError('parent_completion_mismatch');
    const dispatchedAt = now(owner);
    const completion = await runParent(owner, parent, 'completion',
      `The host accepted this volatile completion envelope after your admission turn ended: ${JSON.stringify(retained.envelope)}. Do not call tools. Read its child result and return only the exact JSON object with its token.`, deadline(B.ordinaryMs, delegationSignal));
    if (!completion.resultText || parseNativeToken(completion.resultText) !== token) throw new NativeQualificationError('parent_completion_mismatch');
    delivery = { parentSessionId: completion.sessionId, parentTurnId: completion.turnId, inboxId: retained.inboxId,
      acceptedAt: retained.at, dispatchedAt, acknowledgedAt: now(owner), envelope: retained.envelope, token, verified: true };
    gate = 'cancellation';
    owner.childPurpose = 'cancellation_child'; owner.admissionOpen = true; phaseAdmission = undefined;
    dispatch = deferred<void>(); activeOperation = randomUUID();
    await runParent(owner, parent, 'cancellation_admission', admissionPrompt(activeOperation, true), deadline(B.ordinaryMs, delegationSignal));
    const cancellationAdmission = admissions[1];
    if (!cancellationAdmission) throw new NativeQualificationError('parent_did_not_delegate');
    owner.admissionOpen = false; dispatch.resolve();
    const cancelStarted = await bounded(owner.cancellationStarted.promise, delegationSignal);
    const cancellationProviderStartedAt = cancelStarted.providerStartedAt;
    if (cancellationProviderStartedAt === undefined) throw new NativeQualificationError('dispatch_uncertain');
    const requestedAt = now(owner);
    const cancelReceipt = await bounded(client.cancel({ operationId: randomUUID(), taskId: cancellationAdmission.taskId }), delegationSignal);
    let canceled = await bounded(client.wait({ taskId: cancellationAdmission.taskId, timeoutMs: 30_000, signal: delegationSignal }), delegationSignal);
    while (canceled.status === 'timeout') canceled = await bounded(client.wait({ taskId: cancellationAdmission.taskId, timeoutMs: 30_000, signal: delegationSignal }), delegationSignal);
    const canceledOutcome = canceled.task.runs.items.find((run) => run.runId === cancellationAdmission.runId)?.outcome;
    cancellation = { status: canceledOutcome?.kind === 'succeeded' ? 'completed_before_cancellation'
      : canceledOutcome?.kind === 'canceled' && canceledOutcome.confirmation === 'provider_terminal' && cancelReceipt.status !== 'recovery_required' ? 'confirmed' : 'uncertain',
    taskId: cancellationAdmission.taskId, runId: cancellationAdmission.runId, providerStartedAt: cancellationProviderStartedAt, requestedAt };
    if (cancellation.status !== 'confirmed') throw new NativeQualificationError(cancellation.status === 'completed_before_cancellation' ? 'completed_before_cancellation' : 'cancellation_unsupported');
    if (owner.blockedRequest) throw new NativeQualificationError('approval_not_authorized');
    await verifyExecutable(options);
  } catch (error) { failure = reason(error, signal); failedGates.push({ gate, reason: failure }); }
  const elapsedMs = now(owner);
  const delegationElapsedMs = delegationStartedAt === undefined ? undefined : elapsedMs - delegationStartedAt;
  const receipt = await cleanup(owner);
  if (receipt.status !== 'closed') { failure = 'cleanup_pending'; failedGates.push({ gate: 'cleanup', reason: failure }); }
  const report: NativeModeReport = { version: 2,
    outcome: !failure ? 'qualified' : failure === 'cleanup_pending' ? 'cleanup_pending'
      : failure === 'dispatch_uncertain' ? 'uncertain' : 'blocked',
    ...(failure ? { reason: failure } : {}), failedGates, budgets: B,
    usage: { turns: owner.turns.length, elapsedMs, ...(delegationElapsedMs === undefined ? {} : { delegationElapsedMs }) },
    turns: owner.turns.map((turn) => ({ ...turn })), sessions: owner.lifecycle.map((observation) => ({ ...observation })),
    tools, admissions, ...(owner.parentPermissionPolicy ? { parentPermissionProofDigest: owner.parentPermissionPolicy.proofDigest, approvals: owner.approvals } : {}),
    ...(boundParentScope ? { parentScope: boundParentScope } : {}), configurationStarts: owner.configurationStarts,
    ...(parentConfiguration ? { parentConfiguration } : {}), childConfigurations, ...(scope ? { scope } : {}),
    ...(dispatchGate ? { dispatchGate } : {}), ...(child ? { child } : {}), ...(delivery ? { delivery } : {}), cancellation, cleanup: receipt };
  return { report: structuredClone(report), ...(receipt.status === 'closed' ? {} : { retryCleanup: retry(owner) }) };
}
