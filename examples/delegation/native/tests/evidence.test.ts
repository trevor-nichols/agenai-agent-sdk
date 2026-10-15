// ------------------------------------------------------------------------------------------------
//                evidence.test.ts - Offline qualification rejects uncorrelated or incomplete facts
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertQualifiedNativeMode, parseNativeDiscoveryReport, parseNativeMappingProof, parseNativeModeReport } from '../evidence.js';
import { parseNativeCandidate, parseNativeSelection, type NativeCandidate } from '../contracts.js';
import { SDK_PACKAGE_NAMES } from '../identity.js';
import { semanticDigest } from '../json.js';
import { assertNativeExecution, parseNativeEnvelope } from '../reports.js';
import { parseNativeParentPermissionProof } from '../permission-contracts.js';

const uid = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const tokenResult = '{"token":"ABCDEFGHIJKL"}';

function catalog(revision = 3, selected = true) {
  return { revision, fields: [
    { key: 'model', revision: selected ? 2 : 1, label: 'Model', scope: 'session', applicationTiming: 'immediate', mutable: true,
      fieldKind: 'single_select', currentValue: selected ? 'model-grok43' : 'model-default',
      options: [{ optionId: 'model-default', label: 'Default' }, { optionId: 'model-grok43', label: 'grok-4.3' }] },
    { key: 'reasoning', revision: revision === 3 ? 2 : 1, label: 'Reasoning Effort', scope: 'session', applicationTiming: 'immediate', mutable: true,
      fieldKind: 'single_select', currentValue: revision === 3 ? 'reasoning-low' : 'reasoning-high',
      options: [{ optionId: 'reasoning-high', label: 'High' }, { optionId: 'reasoning-low', label: 'Low' }] },
  ] };
}
function selection() {
  return { modelId: 'grok-4.3', reasoning: 'low', initial: catalog(1, false), afterModel: catalog(2), afterReasoning: catalog(),
    model: { key: 'model', expectedCatalogRevision: 1, expectedFieldRevision: 1, value: { fieldKind: 'single_select', optionId: 'model-grok43' } },
    reasoningSelection: { key: 'reasoning', expectedCatalogRevision: 2, expectedFieldRevision: 1, value: { fieldKind: 'single_select', optionId: 'reasoning-low' } } };
}
function cleanup() {
  return { status: 'closed', coordinatorClosed: true, sessionsClosed: true, registriesClosed: true, bridgesAcquired: 1, bridgesReleased: 1, elapsedMs: 10 };
}
function admission(number: number) {
  return { storeId: uid(1), operationId: uid(10 + number), taskId: uid(20 + number), runId: uid(30 + number),
    target: { catalogId: 'native-grok-catalog', catalogRevision: 1, targetId: 'grok-standard-low', targetRevision: 1, sourceId: 'fixture-mapping', sourceRevision: 1 },
    revision: number, status: 'queued', duplicate: false };
}
function turn(purpose: string, role: string, sessionId: string, enteredAt: number, providerStartedAt: number, terminalAt: number, settledAt: number, resultText?: string) {
  return { role, purpose, sessionId, turnId: `turn:${purpose}`, enteredAt, configurationCatalogRevision: 3, configurationVerifiedAt: enteredAt - 1,
    providerStartedAt, terminalAt, settledAt, outcome: purpose === 'cancellation_child' ? 'canceled' : 'completed', ...(resultText ? { resultText } : {}) };
}
function modeFixture() {
  const admitted = admission(1), canceled = admission(2), parentScope = { parentId: 'native-parent', scopeId: 'native:fixture', revision: 1 };
  const files = [{ location: '/etc/grok', kind: 'absent' }, { location: 'GROK_HOME/config.toml', kind: 'file', bytes: 28, sha256: 'a'.repeat(64) }];
  const tool = (purpose: string, name: string, at: number, entry?: ReturnType<typeof admission>) => ({
    parentSessionId: 'session:parent', parentTurnId: `turn:${purpose}`, invocationId: `invocation:${purpose}:${name}`, toolName: name,
    at, status: 'success', target: entry?.target ?? admitted.target, ...(entry ? { admission: entry } : {}),
  });
  return {
    version: 1, outcome: 'qualified', failedGates: [] as { gate: string; reason: string }[],
    budgets: { maxTurns: 6, modeMs: 300_000, delegationMs: 180_000, ordinaryMs: 90_000, cleanupMs: 30_000,
      discoveryMs: 30_000, maxResultBytes: 8_192, maxRetainedTextBytes: 65_536 },
    usage: { turns: 6, elapsedMs: 200, delegationElapsedMs: 160 },
    turns: [turn('ordinary', 'parent', 'session:parent', 10, 11, 19, 20, '{"ready":true}'),
      turn('admission', 'parent', 'session:parent', 30, 31, 49, 50),
      turn('child', 'child', 'session:child', 55, 60, 90, 95, tokenResult),
      turn('completion', 'parent', 'session:parent', 110, 111, 130, 131, tokenResult),
      turn('cancellation_admission', 'parent', 'session:parent', 140, 141, 150, 151),
      turn('cancellation_child', 'child', 'session:cancel-child', 155, 160, 180, 181)],
    sessions: [
      { sessionId: 'session:parent', role: 'parent', event: 'opening', at: 1 },
      { sessionId: 'session:parent', role: 'parent', event: 'opened', at: 2 },
      { sessionId: 'session:comparison-before', role: 'comparison', event: 'opening', at: 21 },
      { sessionId: 'session:comparison-before', role: 'comparison', event: 'opened', at: 22 },
      { sessionId: 'session:comparison-before', role: 'comparison', event: 'closed', at: 23 },
      { sessionId: 'session:child', role: 'child', event: 'opening', at: 51 },
      { sessionId: 'session:child', role: 'child', event: 'opened', at: 52 },
      { sessionId: 'session:child', role: 'child', event: 'closed', at: 96 },
      { sessionId: 'session:comparison-after', role: 'comparison', event: 'opening', at: 97 },
      { sessionId: 'session:comparison-after', role: 'comparison', event: 'opened', at: 98 },
      { sessionId: 'session:comparison-after', role: 'comparison', event: 'closed', at: 99 },
      { sessionId: 'session:cancel-child', role: 'child', event: 'opening', at: 152 },
      { sessionId: 'session:cancel-child', role: 'child', event: 'opened', at: 153 },
      { sessionId: 'session:cancel-child', role: 'child', event: 'closed', at: 182 },
      { sessionId: 'session:parent', role: 'parent', event: 'closed', at: 205 },
    ],
    tools: [tool('admission', 'delegation_targets', 40), tool('admission', 'delegate_task', 41, admitted),
      tool('cancellation_admission', 'delegation_targets', 145), tool('cancellation_admission', 'delegate_task', 146, canceled)],
    admissions: [admitted, canceled], configurationStarts: 3, parentScope, parentConfiguration: catalog(), childConfigurations: [catalog(), catalog()],
    scope: { verified: true, parentBeforeChild: catalog(), parentAfterChild: catalog(), comparisonBeforeChild: catalog(1, false), comparisonAfterChild: catalog(1, false),
      parentFilesBeforeChild: files, parentFilesAfterChild: structuredClone(files), comparisonFilesBeforeChild: structuredClone(files), comparisonFilesAfterChild: structuredClone(files) },
    dispatchGate: { parentTurnId: 'turn:admission', parentSettledAt: 50, releasedAt: 55, childProviderStartedAt: 60, verified: true },
    child: { taskId: admitted.taskId, runId: admitted.runId, sessionId: 'session:child', turnId: 'turn:child', token: 'ABCDEFGHIJKL', resultDigest: digest(tokenResult) },
    delivery: { parentSessionId: 'session:parent', parentTurnId: 'turn:completion', inboxId: uid(40), acceptedAt: 100, dispatchedAt: 109, acknowledgedAt: 132,
      token: 'ABCDEFGHIJKL', verified: true, envelope: { storeId: admitted.storeId, notificationId: uid(41), taskId: admitted.taskId, runId: admitted.runId, parent: parentScope,
        policy: 'automatic', settledAt: '2026-10-10T12:00:00.000Z', expiresAt: '2026-10-10T12:01:00.000Z',
        outcome: { kind: 'succeeded', result: { text: tokenResult, truncated: false, references: [] } } } },
    cancellation: { status: 'confirmed', taskId: canceled.taskId, runId: canceled.runId, providerStartedAt: 160, requestedAt: 170 }, cleanup: cleanup(),
  };
}
function discoveryFixture() {
  const unsupported = { kind: 'unsupported' };
  return { version: 1, outcome: 'qualified', failedGates: [], noPrompt: true, elapsedMs: 100, modelAcknowledged: true, reasoningAcknowledged: true,
    configurationStarts: 2, cleanup: { ...cleanup(), bridgesAcquired: 0, bridgesReleased: 0 }, configuration: selection(),
    capabilities: { protocolVersion: 11, providerKey: 'native-proof', sessions: { create: true, resume: false, branch: unsupported },
      turns: { interactionModes: ['default'], interrupt: true, steer: unsupported }, requests: { approval: unsupported, elicitation: unsupported },
      context: { usage: unsupported, compaction: unsupported }, input: { text: true, images: unsupported, contentReferences: unsupported },
      output: { streaming: true, plans: false, fileChanges: 'none', artifactKinds: [] }, configuration: { kind: 'selectable', fieldKinds: ['single_select'], maxFields: 2 },
      operations: unsupported, managedContent: unsupported, integrations: unsupported, environment: { instance: unsupported, session: unsupported },
      collaboration: unsupported, generatedResources: unsupported, authentication: unsupported, versionReporting: true } };
}
function mappingFixture() {
  const config = selection();
  return { format: 'grok-native-loopback-request-v1', scope: 'pinned_native_request_builder_with_fake_api_key', native: { bytes: 100, sha256: 'a'.repeat(64) },
    allocationId: uid(50), fixture: { id: 'grok-4.3', object: 'model', context_length: 1_000_000,
      capabilities: { reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'low' }, aliases: ['grok-4.3-latest'] },
    environmentOverrides: ['GROK_XAI_API_BASE_URL', 'XAI_API_KEY'], credential: 'constant_fake_key_no_account_authority', inferenceOrigin: 'explicit_loopback_fixture',
    realModelInference: false, modelsRequests: 1, nonInference404Responses: 0,
    requests: [{ endpoint: 'chat_completions', requestKeys: ['messages', 'model', 'reasoning_effort', 'stream'], model: 'grok-4.3', reasoning_effort: 'low' }],
    inferenceRequestLimit: 4, explicitSdkTurns: 1, selections: [config.model, config.reasoningSelection], providerExecutionStarted: true,
    terminalCompleted: true, fixtureResponseMatched: true, observedResultText: 'NATIVE_LOOPBACK_MAPPING_OK', standardMapping: 'verified_request_default',
    documentation: 'https://docs.x.ai/developers/advanced-api-usage/priority-processing', productionBackendBillingCertified: false, cleanup: 'closed' };
}

function candidateFixture() {
  const files = [{ path: 'index.js', bytes: 0, sha256: digest('') }], tree = semanticDigest(files);
  const rootSnapshot = '@modelcontextprotocol/sdk@1.29.0';
  const graph = { [rootSnapshot]: { integrity: null, dependencies: {}, optionalDependencies: {} } };
  const runnerFiles = [{ path: 'runner.ts', bytes: 0, sha256: digest('') }];
  return parseNativeCandidate({ schemaVersion: 1, candidateId: 'independent-offline-fixture',
    native: { version: '1.0.50', target: 'linux-x86_64', installedCommandPath: '/fixture/grok', inspectedExecutablePath: '/fixture/grok-real', bytes: 100, sha256: 'a'.repeat(64) },
    launch: { args: ['agent', '--no-leader', 'stdio'] },
    upstreamArtifact: { bytes: 80, sha256: 'b'.repeat(64), url: 'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.50-linux-x86_64.gz',
      decoded: { bytes: 100, sha256: 'a'.repeat(64), magicHex: '7f454c46' } },
    transformation: { recipe: 'gzip-single-member-stream-v1', decoderExecutable: '/fixture/python', decoderExecutableSha256: 'c'.repeat(64),
      pythonVersion: '3.13.0', zlibCompileVersion: '1.3', zlibRuntimeVersion: '1.3', inputChunkBytes: 1_048_576, outputChunkBytes: 1_048_576,
      maxInputBytes: 104_857_600, maxOutputBytes: 268_435_456, plannedTimeoutMs: 30_000 },
    sdk: { sourceRevision: 'd'.repeat(40), nodeVersion: '22.23.2', nodeSha256: digest('fixture-node'), pnpmVersion: '11.7.0', pnpmSha256: digest('fixture-pnpm'),
      lockfileSha256: digest('fixture-lock'), packages: SDK_PACKAGE_NAMES.map((name) => ({ name, version: '0.4.1', sourceGitTree: 'e'.repeat(40),
        manifestSha256: digest('fixture-manifest'), runtimeFiles: files, runtimeTreeSha256: tree })),
      mcp: { version: '1.29.0', rootSnapshot, graph, graphSha256: semanticDigest(graph), runtimeFiles: files, runtimeTreeSha256: tree } },
    runnerFiles, runnerDigest: semanticDigest(runnerFiles), choice: { modelId: 'grok-4.3', reasoning: 'low' },
    credential: { kind: 'dotenv', path: '/fixture/credential.env', key: 'XAI_API_KEY', sourceId: 'fixture-account-route' } });
}
function seal<T extends { evidenceDigest: string }>(value: T): void {
  const body = { ...value }; Reflect.deleteProperty(body, 'evidenceDigest'); value.evidenceDigest = semanticDigest(body);
}
function envelope<T>(report: T, kind: 'discovery' | 'execution', launch: 'direct' | 'registry', candidate: NativeCandidate, candidateFileDigest: string) {
  const processProof = launch === 'registry'
    ? { format: 'native-process-ownership-v1', composition: 'registry-fresh-process', launcherProcessId: 100, freshProcessReopened: true,
      installer: { processId: 101, spawnedAt: 0, readyAt: 1, settledAt: 4, exitedAt: 5, exitCode: 0 },
      run: { processId: 102, spawnedAt: 6, readyAt: 7, settledAt: 250, exitedAt: 251, exitCode: 0 } }
    : { format: 'native-process-ownership-v1', composition: 'direct-local', launcherProcessId: 100, freshProcessReopened: false,
      run: { processId: 100, spawnedAt: 0, readyAt: 0, settledAt: 250 } };
  const result = { format: 'agenai-native-qualification-v1', kind, runId: uid(kind === 'discovery' ? 60 : 61),
    startedAt: '2026-10-10T12:00:00.000Z', endedAt: '2026-10-10T12:00:01.000Z', launch, candidateFileDigest, candidateDigest: semanticDigest(candidate),
    sdk: structuredClone(candidate.sdk), runnerDigest: candidate.runnerDigest, credentialMechanism: 'explicit_api_key_environment',
    operation: { report, cleanup: 'closed', allocations: (kind === 'discovery' ? ['discovery'] : ['parent', 'child', 'comparison']).map((role, index) => ({
      allocationId: uid(70 + index), role, environmentKeys: ['HOME', 'GROK_HOME', 'XAI_API_KEY'] })),
    executable: { mode: launch, identity: { bytes: candidate.native.bytes, sha256: candidate.native.sha256 }, allocationId: uid(80),
      ...(launch === 'registry' ? { registry: { snapshotDigest: digest('snapshot'), planDigest: digest('plan'), installationId: 'fixture-installation',
        receiptDigest: digest('receipt'), referenceId: 'fixture-reference', ownerId: 'fixture-owner', reopenedFromFreshProcess: true } } : {}) }, processProof }, evidenceDigest: '' };
  seal(result); return result;
}
function wrapperFixture(launch: 'direct' | 'registry' = 'registry') {
  const candidate = candidateFixture(), candidateFileDigest = digest(JSON.stringify(candidate));
  const discovery = envelope(discoveryFixture(), 'discovery', launch, candidate, candidateFileDigest), mappingProof = mappingFixture();
  const selected = { schemaVersion: 1, candidateDigest: semanticDigest(candidate), discoveryDigest: semanticDigest(discovery), nativeSha256: candidate.native.sha256,
    sdkDigest: semanticDigest(candidate.sdk), configuration: selection(), mapping: { mappingId: 'fixture-mapping', mappingRevision: 1,
      modelId: 'grok-4.3', reasoning: 'low', executionMode: 'standard', proofDigest: semanticDigest(mappingProof) }, mappingProof };
  const hashes = { discovery: digest(JSON.stringify(discovery)), selection: digest(JSON.stringify(selected)) };
  const execution = { ...envelope(modeFixture(), 'execution', launch, candidate, candidateFileDigest), discoveryFileDigest: hashes.discovery,
    discoveryDigest: semanticDigest(discovery), selectionFileDigest: hashes.selection, selectionDigest: semanticDigest(selected) };
  seal(execution); return { candidate, candidateFileDigest, discovery, selected, execution, hashes };
}
function refreshSelection(value: ReturnType<typeof wrapperFixture>): void {
  value.selected.mapping.proofDigest = semanticDigest(value.selected.mappingProof);
  value.hashes.selection = digest(JSON.stringify(value.selected));
  value.execution.selectionFileDigest = value.hashes.selection; value.execution.selectionDigest = semanticDigest(value.selected);
}
function acceptWrapper(value: ReturnType<typeof wrapperFixture>): void {
  const selected = parseNativeSelection(value.selected);
  const discovery = parseNativeEnvelope(value.discovery, value.candidate, value.candidateFileDigest, 'discovery');
  const execution = parseNativeEnvelope(value.execution, value.candidate, value.candidateFileDigest, 'execution');
  assertNativeExecution(value.candidate, selected, discovery, execution, value.hashes);
}

function permissionProofFixture() {
  const request = (toolName: string, index: number) => {
    const title = `agenai_delegation__${toolName}`, requestId = `request:${index}`, itemId = `item:${index}`;
    return { at: index * 10, turnId: 'permission-proof:turn', request: { requestKind: 'approval', requestId, prompt: title, subject: { kind: 'tool', title, itemId },
      options: [{ optionId: 'allow', label: 'allow once', decision: 'approved', consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } },
        { optionId: 'reject', label: 'reject once', decision: 'denied', consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } }] },
    item: { itemId, itemKind: 'dynamic_tool_call', status: 'in_progress', title, toolNamePresent: false },
    selected: { requestKind: 'approval', requestId, disposition: 'selected', optionId: 'allow' },
    running: { at: index * 10 + 1, turnId: 'permission-proof:turn', state: 'running', resolutionIndex: index },
    callback: { at: index * 10 + 2, invocationId: `invocation:${index}`, toolName } };
  };
  return { profile: 'grok-1.0.50-managed-mcp-once-v1', artifactDigest: digest('retained-independent-permission-artifact'), executableSha256: 'a'.repeat(64), executableBytes: 100,
    sdkDigest: semanticDigest(candidateFixture().sdk), allocationId: uid(90), turnId: 'permission-proof:turn', originalRunTurnCount: 1,
    requests: [request('delegation_targets', 1), request('delegate_task', 2)], resolutionStreamsSettled: 2,
    terminal: { at: 30, turnId: 'permission-proof:turn', outcome: 'completed' }, observedAssistantText: 'NATIVE_PERMISSION_CONTINUATION_OK', cleanup: 'closed',
    cleanupFacts: { sessionClosed: true, registryClosed: true, bridgeClosed: true, allocationReleased: true, executableReleased: true, rootRemoved: true } };
}
function permissionModeFixture(proof = permissionProofFixture()) {
  const mode = modeFixture(); mode.tools[1]!.at = 47; mode.tools[3]!.at = 148;
  const approval = (purpose: string, toolName: string, index: number, times: readonly number[], boundary: string) => ({
    parentSessionId: 'session:parent', parentTurnId: `turn:${purpose}`, purpose, requestId: `request:${index}`, itemId: `item:${index}`, toolName,
    title: `agenai_delegation__${toolName}`, itemKind: 'dynamic_tool_call', itemStatus: 'in_progress', itemObservedAt: times[0]!, openedAt: times[1]!, pendingSettledAt: times[2]!,
    offeredOption: { optionId: 'allow', label: 'allow once', decision: 'approved', persistence: 'once', scopeKind: 'exact_action' }, selectedOptionId: 'allow',
    resolutionStartedAt: times[3]!, runningAt: times[4]!, continuationSettledAt: times[5]!, continuationBoundary: boundary, invocationId: `invocation:${purpose}:${toolName}` });
  return { ...mode, parentPermissionProofDigest: semanticDigest(proof), approvals: [
    approval('admission', 'delegation_targets', 1, [32, 33, 34, 35, 36, 44], 'pending_request'), approval('admission', 'delegate_task', 2, [41, 42, 44, 45, 46, 50], 'completed'),
    approval('cancellation_admission', 'delegation_targets', 3, [142, 142.2, 142.3, 142.4, 142.5, 146.1], 'pending_request'),
    approval('cancellation_admission', 'delegate_task', 4, [145.2, 146, 146.1, 146.2, 146.3, 151], 'completed')] };
}
function currentPermissionModeFixture() {
  const historical = permissionModeFixture();
  return { ...historical, version: 2, approvals: historical.approvals.map((approval, index) => {
    const { pendingSettledAt, resolutionStartedAt, continuationSettledAt: _settled, continuationBoundary, ...common } = approval;
    const turn = historical.turns.find((candidate) => candidate.turnId === approval.parentTurnId)!;
    return { ...common, requestObservedAt: pendingSettledAt, deliveryStartedAt: resolutionStartedAt,
      deliverySettledAt: resolutionStartedAt + 0.1, deliveryStatus: 'delivered',
      nextBoundaryAt: index % 2 === 0 ? historical.approvals[index + 1]!.openedAt : turn.terminalAt!,
      nextBoundary: continuationBoundary };
  }) };
}

function permissionWrapperFixture() {
  const value = wrapperFixture(), parentPermissionProof = permissionProofFixture();
  const result = { ...value, selected: { ...value.selected, parentPermissionProof }, execution: { ...value.execution,
    operation: { ...value.execution.operation, report: permissionModeFixture(parentPermissionProof) } } };
  refreshSelection(result); seal(result.execution); return result;
}

test('offline qualification accepts correlated harmless results, real gate ordering and closed session lifetimes', () => {
  const parsed = parseNativeModeReport(modeFixture());
  assert.doesNotThrow(() => assertQualifiedNativeMode(parsed));
  assert.equal(parsed.delivery?.envelope.outcome.kind, 'succeeded');
  const interruptionAfterStream = modeFixture();
  interruptionAfterStream.turns[5]!.terminalAt = 183;
  interruptionAfterStream.sessions[13]!.at = 184;
  assert.doesNotThrow(() => assertQualifiedNativeMode(parseNativeModeReport(interruptionAfterStream)));
});

test('offline qualification derives acceptance from observations instead of qualified or verified claims', async (t) => {
  const cases: readonly [string, (value: ReturnType<typeof modeFixture>) => void][] = [
    ['actual successful targets call missing', (value) => { value.tools[0]!.status = 'error'; }],
    ['listed target differs from admitted source', (value) => { value.tools[0]!.target = { ...value.admissions[0]!.target, sourceRevision: 2 }; }],
    ['targets call has no observed offered reference', (value) => { Reflect.deleteProperty(value.tools[0]!, 'target'); }],
    ['delegate admission belongs to another task', (value) => { value.tools[1]!.admission = admission(9); }],
    ['delegate target source changed', (value) => { value.tools[1]!.target = { ...value.admissions[0]!.target, sourceRevision: 2 }; }],
    ['tool runs in another parent turn', (value) => { value.tools[1]!.parentTurnId = 'turn:ordinary'; }],
    ['tool result arrives after its parent settled', (value) => { value.tools[1]!.at = 51; }],
    ['extra successful delegate unaccounted for', (value) => { value.tools.push({ ...value.tools[1]!, invocationId: 'extra' }); }],
    ['child starts before settled parent', (value) => { value.turns[2]!.providerStartedAt = 49; }],
    ['claimed gate differs from actual start', (value) => { value.dispatchGate.childProviderStartedAt = 61; }],
    ['claimed digest differs from actual child text', (value) => { value.child.resultDigest = digest('other'); }],
    ['claimed token differs from actual child text', (value) => { value.child.token = 'XXXXXXXXXXXX'; }],
    ['delivery envelope belongs to another parent', (value) => { value.delivery.envelope.parent = { ...value.parentScope, parentId: 'other' }; }],
    ['completion comes from another session', (value) => { value.delivery.parentSessionId = 'other'; }],
    ['completion result is altered', (value) => { value.delivery.envelope.outcome.result.text = '{"token":"XXXXXXXXXXXX"}'; }],
    ['parent echoed a different token', (value) => { value.turns[3]!.resultText = '{"token":"XXXXXXXXXXXX"}'; }],
    ['scope comparison changed despite verified claim', (value) => { value.scope.comparisonAfterChild.revision++; }],
    ['configuration files changed despite verified claim', (value) => { value.scope.parentFilesAfterChild[1]!.sha256 = 'b'.repeat(64); }],
    ['no configuration files actually inspected', (value) => { value.scope.parentFilesBeforeChild = []; value.scope.parentFilesAfterChild = []; }],
    ['selected model is not qualified choice', (value) => { for (const catalog of [value.parentConfiguration, ...value.childConfigurations, value.scope.parentBeforeChild, value.scope.parentAfterChild]) catalog.fields[0]!.options[1]!.label = 'other-model'; }],
    ['configuration not read before prompt', (value) => { value.turns[0]!.configurationVerifiedAt = 12; }],
    ['configuration revision differs from applied state', (value) => { value.turns[2]!.configurationCatalogRevision = 4; }],
    ['cancellation requested before actual child start', (value) => { value.cancellation.requestedAt = 159; }],
    ['cancellation completed naturally', (value) => { value.turns[5]!.outcome = 'completed'; }],
    ['closure claim lacks actual close', (value) => { value.sessions.pop(); }],
    ['native close before observed terminal', (value) => { value.sessions[13]!.at = 179; }],
    ['three simultaneous session owners', (value) => { value.sessions.splice(7, 0, { sessionId: 'third', role: 'child', event: 'opening', at: 53 }); }],
    ['bridge not released', (value) => { value.cleanup.bridgesReleased = 0; }],
    ['cleanup exceeds bound', (value) => { value.cleanup.elapsedMs = 30_001; }],
    ['execution exceeds bound', (value) => { value.usage.elapsedMs = 300_001; }],
    ['delegation exceeds bound', (value) => { value.usage.delegationElapsedMs = 180_001; value.usage.elapsedMs = 200_000; }],
    ['extra actual turn beyond claimed usage', (value) => { value.turns.push({ ...value.turns[0]!, turnId: 'extra' }); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = modeFixture(); mutate(value);
    assert.throws(() => assertQualifiedNativeMode(parseNativeModeReport(value)));
  });
  const blocked = { ...modeFixture(), outcome: 'blocked', reason: 'parent_did_not_delegate', failedGates: [{ gate: 'delegation', reason: 'parent_did_not_delegate' }] };
  assert.equal(parseNativeModeReport(blocked).outcome, 'blocked');
  assert.throws(() => assertQualifiedNativeMode(parseNativeModeReport(blocked)));
});

test('reports reject unknown nested fields, accessors, sparse lists and retained output overflow', async (t) => {
  const cases: readonly [string, (value: ReturnType<typeof modeFixture>) => void][] = [
    ['top level', (value) => { Object.assign(value, { extra: true }); }],
    ['public catalog field', (value) => { Object.assign(value.parentConfiguration.fields[0]!, { extra: true }); }],
    ['public catalog option', (value) => { Object.assign(value.childConfigurations[0]!.fields[0]!.options[0]!, { extra: true }); }],
    ['public envelope outcome', (value) => { Object.assign(value.delivery.envelope.outcome, { extra: true }); }],
    ['admission target', (value) => { Object.assign(value.admissions[0]!.target, { extra: true }); }],
    ['session observation', (value) => { Object.assign(value.sessions[0]!, { extra: true }); }],
    ['oversize tool list', (value) => { value.tools = Array.from({ length: 65 }, () => value.tools[0]!); }],
    ['oversize observation list', (value) => { value.sessions = Array.from({ length: 513 }, () => value.sessions[0]!); }],
    ['oversize retained text', (value) => { value.turns[0]!.resultText = 'x'.repeat(8_193); }],
    ['aggregate retained strings exceed budget', (value) => { value.parentConfiguration.fields = Array.from({ length: 40 }, (_, index) => ({
      ...value.parentConfiguration.fields[0]!, key: `field${index.toString().padStart(2, '0')}`, description: 'x'.repeat(2_000),
    })); }],
    ['oversize token', (value) => { value.child.token = 'A'.repeat(33); }],
    ['sparse list', (value) => { Reflect.deleteProperty(value.sessions, '0'); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = modeFixture(); mutate(value); assert.throws(() => parseNativeModeReport(value)); });
  let accessorCalls = 0;
  const accessor = modeFixture();
  Object.defineProperty(accessor, 'outcome', { enumerable: true, get() { accessorCalls++; return 'qualified'; } });
  assert.throws(() => parseNativeModeReport(accessor));
  assert.equal(accessorCalls, 0);
});

test('admission diagnostics stay bounded and cannot replace actual managed callbacks', async (t) => {
  const fixture = () => {
    const value = modeFixture();
    const observation = { assistantTextBytes: 17, assistantTextDeltas: 1, textCapped: false, requestCount: 2,
      toolItems: { search_tool: 0, use_tool: 0, managed_targets: 1, managed_delegate: 1, other: 0 }, response: 'admitted_true' };
    Object.assign(value.turns[1]!, { admissionObservation: observation });
    return { value, observation };
  };
  assert.doesNotThrow(() => assertQualifiedNativeMode(parseNativeModeReport(fixture().value)));
  const cases: readonly [string, (value: ReturnType<typeof fixture>) => void][] = [
    ['raw output retained', ({ observation }) => { Object.assign(observation, { assistantText: 'private model output' }); }],
    ['unknown tool category', ({ observation }) => { Object.assign(observation.toolItems, { vendor: 1 }); }],
    ['byte count overflow', ({ observation }) => { observation.assistantTextBytes = 8_193; }],
    ['delta count overflow', ({ observation }) => { observation.assistantTextDeltas = 513; }],
    ['request count overflow', ({ observation }) => { observation.requestCount = 65; }],
    ['fractional item count', ({ observation }) => { observation.toolItems.other = 0.5; }],
    ['distinct category total overflow', ({ observation }) => { observation.toolItems.search_tool = 64; }],
    ['capped before either limit', ({ observation }) => { observation.textCapped = true; }],
    ['none despite observed text', ({ observation }) => { observation.response = 'none'; }],
    ['text without a nonempty delta', ({ observation }) => { observation.assistantTextDeltas = 0; }],
    ['admitted JSON shorter than literal', ({ observation }) => { observation.assistantTextBytes = 16; }],
    ['unrecognized response class', ({ observation }) => { observation.response = 'approved'; }],
    ['diagnostics on ordinary turn', ({ value, observation }) => { Reflect.deleteProperty(value.turns[1]!, 'admissionObservation'); Object.assign(value.turns[0]!, { admissionObservation: observation }); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = fixture(); mutate(value); assert.throws(() => parseNativeModeReport(value.value)); });
  const capped = fixture(); Object.assign(capped.observation, { assistantTextBytes: 8_192, assistantTextDeltas: 512, textCapped: true });
  assert.equal(parseNativeModeReport(capped.value).turns[1]?.admissionObservation?.response, 'admitted_true');
  const missing = fixture(); missing.value.tools = [];
  assert.throws(() => assertQualifiedNativeMode(parseNativeModeReport(missing.value)));
});

test('discovery requires acknowledged observed selections and closes its no-prompt ownership', () => {
  assert.equal(parseNativeDiscoveryReport(discoveryFixture()).outcome, 'qualified');
  for (const mutate of [
    (value: ReturnType<typeof discoveryFixture>) => { value.modelAcknowledged = false; },
    (value: ReturnType<typeof discoveryFixture>) => { value.configuration.afterReasoning.fields[1]!.currentValue = 'reasoning-high'; },
    (value: ReturnType<typeof discoveryFixture>) => { Object.assign(value.configuration.reasoningSelection.value, { extra: true }); },
    (value: ReturnType<typeof discoveryFixture>) => { Object.assign(value.capabilities.configuration, { extra: true }); },
    (value: ReturnType<typeof discoveryFixture>) => { value.cleanup.sessionsClosed = false; },
  ]) { const value = discoveryFixture(); mutate(value); assert.throws(() => parseNativeDiscoveryReport(value)); }
});

test('mapping accepts only bounded low/default request observations against the fake-credential loopback fixture', async (t) => {
  const valid = parseNativeMappingProof(mappingFixture());
  assert.equal(valid.productionBackendBillingCertified, false);
  const explicitDefault = mappingFixture();
  Object.assign(explicitDefault.requests[0]!, { service_tier: 'default', requestKeys: ['messages', 'model', 'reasoning_effort', 'service_tier', 'stream'] });
  assert.equal(parseNativeMappingProof(explicitDefault).requests.length, 1);
  const cases: readonly [string, (value: ReturnType<typeof mappingFixture>) => void][] = [
    ['second request chooses priority', (value) => { value.requests.push({ ...value.requests[0]! }); Object.assign(value.requests[1]!, { service_tier: 'priority', requestKeys: ['messages', 'model', 'reasoning_effort', 'service_tier', 'stream'] }); }],
    ['contradictory nested reasoning', (value) => { Object.assign(value.requests[0]!, { reasoning: { effort: 'high' }, requestKeys: ['messages', 'model', 'reasoning', 'reasoning_effort', 'stream'] }); }],
    ['implicit reasoning not observed', (value) => { Reflect.deleteProperty(value.requests[0]!, 'reasoning_effort'); value.requests[0]!.requestKeys = ['messages', 'model', 'stream']; }],
    ['different model', (value) => { value.requests[0]!.model = 'grok-other'; }],
    ['too many inference requests', (value) => { value.requests = Array.from({ length: 5 }, () => value.requests[0]!); }],
    ['too many total native HTTP requests', (value) => { value.modelsRequests = 8; }],
    ['model fixture metadata altered', (value) => { value.fixture.context_length = 1; }],
    ['private credential authority', (value) => { value.credential = 'account-key'; }],
    ['production inference claimed', (value) => { value.realModelInference = true; }],
    ['billing certified without backend evidence', (value) => { value.productionBackendBillingCertified = true; }],
    ['incomplete terminal', (value) => { value.terminalCompleted = false; }],
    ['native reply did not match fixture', (value) => { value.fixtureResponseMatched = false; }],
    ['claimed fixture match lacks observed reply', (value) => { value.observedResultText = 'other'; }],
    ['unclosed owner', (value) => { value.cleanup = 'pending'; }],
    ['failed native mapping', (value) => { Object.assign(value, { failureCode: 'mapping_native_failed' }); }],
    ['unknown nested request field', (value) => { Object.assign(value.requests[0]!, { temperature: 1 }); }],
    ['unknown public selection field', (value) => { Object.assign(value.selections[0]!.value, { extra: true }); }],
    ['projection omitted present request key', (value) => { value.requests[0]!.requestKeys.push('service_tier'); value.requests[0]!.requestKeys.sort(); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = mappingFixture(); mutate(value); assert.throws(() => parseNativeMappingProof(value)); });
});

test('outer qualification accepts coherent independent direct and fresh-process registry evidence', () => {
  assert.doesNotThrow(() => acceptWrapper(wrapperFixture('direct')));
  assert.doesNotThrow(() => acceptWrapper(wrapperFixture('registry')));
});

test('outer qualification budgets the whole attempt and permits only the measured separate cleanup time', async (t) => {
  for (const launch of ['direct', 'registry'] as const) await t.test(launch, () => {
    const timed = (settledAt: number, cleanupElapsedMs: number) => {
      const value = wrapperFixture(launch);
      value.execution.operation.report.cleanup.elapsedMs = cleanupElapsedMs;
      value.execution.operation.report.usage.elapsedMs = settledAt - 100_002;
      Object.assign(value.execution.operation.processProof.run, { settledAt,
        ...(launch === 'registry' ? { spawnedAt: 100_001, readyAt: 100_002, exitedAt: settledAt + 1 } : {}) });
      if (launch === 'registry') Object.assign(value.execution.operation.processProof.installer!, { settledAt: 99_999, exitedAt: 100_000 });
      value.execution.endedAt = new Date(Date.parse(value.execution.startedAt) + settledAt + 1).toISOString();
      seal(value.execution);
      return value;
    };
    assert.doesNotThrow(() => acceptWrapper(timed(320_000, 20_000)));
    assert.doesNotThrow(() => acceptWrapper(timed(330_000, 30_000)));
    for (const value of [timed(320_001, 20_000), timed(330_001, 30_000), timed(350_000, 10)]) {
      assert.doesNotThrow(() => assertQualifiedNativeMode(parseNativeModeReport(value.execution.operation.report)));
      assert.throws(() => acceptWrapper(value), { code: 'budget_exhausted' });
    }
  });
});

test('native mapping identities remain valid across independently revised discovery sessions', () => {
  const value = wrapperFixture('direct');
  value.selected.mappingProof.selections[1]!.expectedCatalogRevision = 1;
  value.selected.mappingProof.selections[1]!.expectedFieldRevision = 1;
  refreshSelection(value);
  seal(value.execution);
  assert.doesNotThrow(() => acceptWrapper(value));
});

test('outer qualification rejects cross-candidate, SDK, selection and source substitutions with valid inner reports', async (t) => {
  const cases: readonly [string, (value: ReturnType<typeof wrapperFixture>) => void][] = [
    ['selection native identity', (value) => { value.selected.nativeSha256 = 'b'.repeat(64); refreshSelection(value); }],
    ['selection SDK identity', (value) => { value.selected.sdkDigest = digest('other-sdk'); refreshSelection(value); }],
    ['selection candidate identity', (value) => { value.selected.candidateDigest = digest('other-candidate'); refreshSelection(value); }],
    ['selection discovery identity', (value) => { value.selected.discoveryDigest = digest('other-discovery'); refreshSelection(value); }],
    ['envelope candidate file', (value) => { value.execution.candidateFileDigest = digest('other-file'); }],
    ['envelope SDK manifest', (value) => { Object.assign(value.execution.sdk, { pnpmVersion: '11.7.1' }); }],
    ['envelope runner identity', (value) => { value.execution.runnerDigest = digest('other-runner'); }],
    ['mapping proof native identity', (value) => { value.selected.mappingProof.native.sha256 = 'b'.repeat(64); refreshSelection(value); }],
    ['mapping proof selected native option', (value) => { value.selected.mappingProof.selections[0]!.value.optionId = 'different-option'; refreshSelection(value); }],
    ['selection observed configuration', (value) => { Object.assign(value.selected.configuration.afterReasoning.fields[0]!, { description: 'other observation' }); refreshSelection(value); }],
    ['execution configuration differs from selection', (value) => { const report = value.execution.operation.report;
      for (const catalog of [report.parentConfiguration, ...report.childConfigurations, report.scope.parentBeforeChild, report.scope.parentAfterChild]) {
        Object.assign(catalog.fields[0]!, { description: 'independently valid but unselected catalog' });
      } }],
    ['admitted source identity differs from mapping', (value) => { const report = value.execution.operation.report;
      for (const target of [...report.admissions.map((item) => item.target), ...report.tools.map((item) => item.target)]) target.sourceId = 'other-mapping'; }],
    ['admitted source revision differs from mapping', (value) => { const report = value.execution.operation.report;
      for (const target of [...report.admissions.map((item) => item.target), ...report.tools.map((item) => item.target)]) target.sourceRevision = 2; }],
    ['execution selection file hash', (value) => { value.execution.selectionFileDigest = digest('other-selection-file'); }],
    ['execution discovery file hash', (value) => { value.execution.discoveryFileDigest = digest('other-discovery-file'); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = wrapperFixture(); mutate(value); seal(value.execution);
    assert.doesNotThrow(() => assertQualifiedNativeMode(parseNativeModeReport(value.execution.operation.report)));
    assert.throws(() => acceptWrapper(value));
  });
});

test('outer registry evidence requires observed installer exit before a separately observed run and final close', async (t) => {
  const cases: readonly [string, (value: ReturnType<typeof wrapperFixture>) => void][] = [
    ['process proof missing', (value) => { Reflect.deleteProperty(value.execution.operation, 'processProof'); }],
    ['fresh claim supported only by different process IDs', (value) => { Object.assign(value.execution.operation.processProof, {
      installer: { processId: 101, spawnedAt: 0 }, run: { processId: 102, spawnedAt: 1 }, freshProcessReopened: true }); }],
    ['run starts before installer exits', (value) => { value.execution.operation.processProof.run.spawnedAt = 4; }],
    ['installer exit unsuccessful', (value) => { value.execution.operation.processProof.installer!.exitCode = 1; }],
    ['run not closed', (value) => { Reflect.deleteProperty(value.execution.operation.processProof.run, 'exitedAt'); Reflect.deleteProperty(value.execution.operation.processProof.run, 'exitCode'); }],
    ['run shares launcher process', (value) => { value.execution.operation.processProof.run.processId = 100; }],
    ['fresh reopen not observed', (value) => { value.execution.operation.processProof.freshProcessReopened = false; }],
    ['unknown process observation field', (value) => { Object.assign(value.execution.operation.processProof.installer!, { claimedClosed: true }); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = wrapperFixture(); mutate(value); seal(value.execution);
    assert.doesNotThrow(() => assertQualifiedNativeMode(parseNativeModeReport(value.execution.operation.report)));
    assert.throws(() => acceptWrapper(value));
  });
});

test('a checksum-valid blocked execution remains blocked at final acceptance', () => {
  const value = wrapperFixture();
  Object.assign(value.execution.operation.report, { outcome: 'blocked', reason: 'parent_did_not_delegate', failedGates: [{ gate: 'delegation', reason: 'parent_did_not_delegate' }] });
  seal(value.execution);
  const parsed = parseNativeEnvelope(value.execution, value.candidate, value.candidateFileDigest, 'execution');
  assert.equal(parsed.report.outcome, 'blocked');
  assert.throws(() => acceptWrapper(value), { code: 'qualification_evidence_invalid' });
});

test('the selected pinned permission proof requires actual once choices, live items and two same-turn callbacks', async (t) => {
  assert.equal(parseNativeParentPermissionProof(permissionProofFixture()).resolutionStreamsSettled, 2);
  const cases: readonly [string, (value: ReturnType<typeof permissionProofFixture>) => void][] = [
    ['wrong owned server title', (value) => { value.requests[0]!.request.subject.title = 'other__delegation_targets'; }],
    ['item is already terminal', (value) => { value.requests[0]!.item.status = 'completed'; }],
    ['item identity differs from request', (value) => { value.requests[0]!.item.itemId = 'other'; }],
    ['native tool name present outside pinned shape', (value) => { value.requests[0]!.item.toolNamePresent = true; }],
    ['persistent approval', (value) => { value.requests[0]!.request.options[0]!.consequence.persistence = 'session'; }],
    ['broader approval scope', (value) => { value.requests[0]!.request.options[0]!.consequence.scope.kind = 'workspace'; }],
    ['unoffered selected option', (value) => { value.requests[0]!.selected.optionId = 'unknown'; }],
    ['different request resolved', (value) => { value.requests[0]!.selected.requestId = 'other'; }],
    ['running belongs to another turn', (value) => { value.requests[0]!.running.turnId = 'other'; }],
    ['additional original runTurn', (value) => { value.originalRunTurnCount = 2; }],
    ['missing second continuation boundary', (value) => { value.resolutionStreamsSettled = 1; }],
    ['delegate request before actual targets callback', (value) => { value.requests[1]!.at = 11.5; }],
    ['duplicate callback', (value) => { value.requests[1]!.callback.invocationId = value.requests[0]!.callback.invocationId; }],
    ['terminal not completed', (value) => { value.terminal.outcome = 'canceled'; }],
    ['fixture response merely claimed', (value) => { value.observedAssistantText = 'different'; }],
    ['cleanup closure unproven', (value) => { value.cleanupFacts.sessionClosed = false; }],
    ['unknown nested request field', (value) => { Object.assign(value.requests[0]!.request.subject, { nativeArguments: {} }); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = permissionProofFixture(); mutate(value); assert.throws(() => parseNativeParentPermissionProof(value)); });
});

test('approval evidence requires original-turn boundaries and exact successful callbacks before qualification', async (t) => {
  assert.doesNotThrow(() => assertQualifiedNativeMode(parseNativeModeReport(permissionModeFixture())));
  const cases: readonly [string, (value: ReturnType<typeof permissionModeFixture>) => void][] = [
    ['proof digest absent', (value) => { Reflect.deleteProperty(value, 'parentPermissionProofDigest'); }],
    ['approval belongs to another session', (value) => { value.approvals[0]!.parentSessionId = 'other'; }],
    ['approval belongs to ordinary turn', (value) => { value.approvals[0]!.parentTurnId = 'turn:ordinary'; }],
    ['item observed after request', (value) => { value.approvals[0]!.itemObservedAt = 34; }],
    ['resolution before stable pending boundary', (value) => { value.approvals[0]!.resolutionStartedAt = 33.5; }],
    ['once choice not actually selected', (value) => { value.approvals[0]!.selectedOptionId = 'reject'; }],
    ['running acknowledgment absent', (value) => { Reflect.deleteProperty(value.approvals[0]!, 'runningAt'); }],
    ['callback occurred before resolution', (value) => { value.approvals[0]!.resolutionStartedAt = 41; value.approvals[0]!.runningAt = 41; }],
    ['callback invocation unrelated', (value) => { value.approvals[0]!.invocationId = 'other'; }],
    ['delegate approved before targets callback', (value) => { value.approvals[1]!.openedAt = 39; value.approvals[1]!.itemObservedAt = 38; }],
    ['overlapping continuation streams', (value) => { value.approvals[1]!.pendingSettledAt = 42; value.approvals[1]!.resolutionStartedAt = 43; }],
    ['last continuation remains pending', (value) => { value.approvals[1]!.continuationBoundary = 'pending_request'; }],
    ['continuation settled before its actual callback', (value) => { value.approvals[1]!.continuationSettledAt = 46.5; }],
    ['continuation outside original turn', (value) => { value.approvals[1]!.continuationSettledAt = 51; }],
    ['duplicate request', (value) => { value.approvals[1]!.requestId = value.approvals[0]!.requestId; }],
    ['too many approvals', (value) => { value.approvals.push({ ...value.approvals[0]! }); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => { const value = permissionModeFixture(); mutate(value); assert.throws(() => assertQualifiedNativeMode(parseNativeModeReport(value))); });
  const blocked = permissionModeFixture();
  Object.assign(blocked, { outcome: 'blocked', reason: 'native_extension_required', failedGates: [{ gate: 'delegation', reason: 'native_extension_required' }] });
  for (const key of ['pendingSettledAt', 'selectedOptionId', 'resolutionStartedAt', 'runningAt', 'continuationSettledAt', 'continuationBoundary', 'invocationId']) Reflect.deleteProperty(blocked.approvals[0]!, key);
  assert.equal(parseNativeModeReport(blocked).approvals?.[0]?.requestId, 'request:1');
  await t.test('uncertain continuation retains running and settlement observations without claiming a boundary', () => {
    const uncertain = permissionModeFixture();
    Object.assign(uncertain, { outcome: 'blocked', reason: 'dispatch_uncertain', failedGates: [{ gate: 'delegation', reason: 'dispatch_uncertain' }] });
    Reflect.deleteProperty(uncertain.approvals[0]!, 'continuationBoundary');
    const parsed = parseNativeModeReport(uncertain);
    assert.ok(parsed.version === 1);
    assert.equal(parsed.approvals?.[0]?.runningAt, 36);
    assert.equal(parsed.approvals?.[0]?.continuationSettledAt, 44);
    assert.equal(parsed.approvals?.[0]?.continuationBoundary, undefined);
    assert.throws(() => assertQualifiedNativeMode(parsed));
    Object.assign(uncertain, { outcome: 'qualified', failedGates: [] }); Reflect.deleteProperty(uncertain, 'reason');
    assert.throws(() => assertQualifiedNativeMode(parseNativeModeReport(uncertain)));
  });
  const historical = modeFixture();
  Object.assign(historical, { outcome: 'blocked', reason: 'native_extension_required', failedGates: [{ gate: 'delegation', reason: 'native_extension_required' }] });
  assert.equal(parseNativeModeReport(historical).approvals, undefined);
});

test('outer selection binds the permission projection to exact native, SDK and report identities', async (t) => {
  assert.doesNotThrow(() => acceptWrapper(permissionWrapperFixture()));
  const cases: readonly [string, (value: ReturnType<typeof permissionWrapperFixture>) => void][] = [
    ['proof native hash', (value) => { value.selected.parentPermissionProof.executableSha256 = 'b'.repeat(64);
      value.execution.operation.report.parentPermissionProofDigest = semanticDigest(value.selected.parentPermissionProof); }],
    ['proof native bytes', (value) => { value.selected.parentPermissionProof.executableBytes++;
      value.execution.operation.report.parentPermissionProofDigest = semanticDigest(value.selected.parentPermissionProof); }],
    ['proof SDK digest', (value) => { value.selected.parentPermissionProof.sdkDigest = digest('other-sdk');
      value.execution.operation.report.parentPermissionProofDigest = semanticDigest(value.selected.parentPermissionProof); }],
    ['report proof digest missing', (value) => { Reflect.deleteProperty(value.execution.operation.report, 'parentPermissionProofDigest'); }],
    ['report proof digest mismatched', (value) => { value.execution.operation.report.parentPermissionProofDigest = digest('other-proof'); }],
    ['proof not selected', (value) => { Reflect.deleteProperty(value.selected, 'parentPermissionProof'); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = permissionWrapperFixture(); mutate(value); refreshSelection(value); seal(value.execution);
    assert.throws(() => acceptWrapper(value));
  });
});


test('version 2 approvals distinguish delivered answers from later original-stream boundaries and preserve version 1 evidence', async (t) => {
  const current = currentPermissionModeFixture();
  const parsed = parseNativeModeReport(current);
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed, current);
  assert.doesNotThrow(() => assertQualifiedNativeMode(parsed));
  assert.ok(current.approvals[0]!.deliverySettledAt < current.approvals[0]!.runningAt);
  assert.ok(current.approvals[1]!.deliverySettledAt < current.turns[1]!.terminalAt!);
  const historical = permissionModeFixture();
  assert.deepEqual(parseNativeModeReport(historical), historical);
  assert.doesNotThrow(() => assertQualifiedNativeMode(parseNativeModeReport(historical)));
  const cases: readonly [string, (value: ReturnType<typeof currentPermissionModeFixture>) => void][] = [
    ['delivered receipt absent', (value) => { Reflect.deleteProperty(value.approvals[0]!, 'deliveryStatus'); }],
    ['delivery uncertain', (value) => { value.approvals[0]!.deliveryStatus = 'delivery_uncertain'; }],
    ['rejected still pending', (value) => { Object.assign(value.approvals[0]!, { deliveryStatus: 'rejected', requestState: 'pending' }); }],
    ['unrelated successor boundary', (value) => { value.approvals[0]!.nextBoundaryAt += 0.1; }],
    ['receipt after successor', (value) => { value.approvals[0]!.deliverySettledAt = value.approvals[0]!.nextBoundaryAt + 0.1; }],
    ['terminal boundary invented at delivery', (value) => { value.approvals[1]!.nextBoundaryAt = value.approvals[1]!.deliverySettledAt; }],
    ['historical exhaustion field in current report', (value) => { Object.assign(value.approvals[0]!, { pendingSettledAt: value.approvals[0]!.requestObservedAt }); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const value = currentPermissionModeFixture(); mutate(value);
    assert.throws(() => assertQualifiedNativeMode(parseNativeModeReport(value)));
  });
  const mislabeled = { ...currentPermissionModeFixture(), version: 1 };
  assert.throws(() => parseNativeModeReport(mislabeled));
  const promoted = { ...historical, version: 2 };
  assert.throws(() => parseNativeModeReport(promoted));
});
