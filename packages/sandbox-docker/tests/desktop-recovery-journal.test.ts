import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { reconcileSandboxRecovery } from '@agen-ai/sandbox/backend';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';
import { inspectPath, inspectResource } from '../src/resources/inspect.js';
import { desktopObserverContainerBody } from '../src/policy/desktopObserver.js';
import { parseCoordinatedDockerCleanupConfig, parseDockerConfig } from '../src/policy/config.js';
import { desktopSharedAuthorityDigest } from '../src/policy/coordination.js';
import { newRecoveryRecord, resourceLabels } from '../src/recovery/identity.js';
import { beginCoordinatorGeneration, createInitialCoordinatorSnapshot, planCoordinatorTransition } from '../src/network/desktop/coordinator/journal/plans.js';
import type { CoordinatorEvent } from '../src/network/desktop/coordinator/journal/plans.js';
import { coordinatorDigest, coordinatorEngineKey, encodeCoordinatorSnapshot, parseCoordinatorSnapshot } from '../src/network/desktop/coordinator/journal/schema.js';
import type { ResourceRole } from '../src/network/desktop/coordinator/journal/schema.js';
import { DESKTOP_COORDINATOR_POLICY_DIGEST } from '../src/network/desktop/coordinator/policy.js';
import { RecoveryCleanupJournalAdapter } from '../src/network/desktop/coordinator/administrativeRecovery/cleanupAdapter.js';
import { createFinalInventoryDecision, createGenerationTerminalDecision } from '../src/network/desktop/coordinator/administrativeRecovery/decisions.js';
import { createRecoveryEnvelope, planCleanHandback, planCleanupTransition, planFinalInventory, transitionRecovery } from '../src/network/desktop/coordinator/administrativeRecovery/plans.js';
import { validateRecoveryEvidence } from '../src/network/desktop/coordinator/administrativeRecovery/evidence.js';
import { RecoveryPublicationOwner } from '../src/network/desktop/coordinator/administrativeRecovery/publication.js';
import { encodeRecoveryEnvelope, parseRecoveryEnvelope } from '../src/network/desktop/coordinator/administrativeRecovery/schema.js';
import type { RecoveryEnvelope } from '../src/network/desktop/coordinator/administrativeRecovery/schema.js';
import { originalFrameDigest } from '../src/network/desktop/coordinator/administrativeRecovery/validation.js';
import { rawDigest } from '../src/network/desktop/coordinator/administrativeRecovery/scalars.js';
import { parseSdkDecision, recoveryDecisionBinding, sdkDecisionReceipt, terminalDecisionMember, encodeSdkDecision, sdkDecisionScope, wireSdkDecision } from '../src/network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import type { BarrierAcceptanceDecision, SdkDecision } from '../src/network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import type { ReceiptRef, TypedReceiptScope } from '../src/network/desktop/coordinator/administrativeRecovery/receipts.js';
import { restorationEventsDigest, restorationSpansDigest } from '../src/network/desktop/coordinator/administrativeRecovery/restoration.js';
import type { RestorationEvent } from '../src/network/desktop/coordinator/administrativeRecovery/restoration.js';
import { desktopResourcesFixture } from './fixtures/desktopResources.js';
import { identifiedRecoveryJournalFixture } from './fixtures/desktopRecoveryJournal.js';
import { sandboxRequest } from './fixtures/engine.js';

const digest = `sha256:${'a'.repeat(64)}`;
const claim = { rootDevice: '1', rootInode: '2', lockDevice: '1', lockInode: '3' };
const originalHelper = { protocol: 'agenai.desktop-coordinator.v1' as const, sourceDigest: digest,
  executable: { path: '/prepared/original-holder', sha256: 'b'.repeat(64) } };
const recoveryHelper = { protocol: 'agenai.desktop-recovery-observer.v1' as const, sourceDigest: digest,
  executable: { path: '/prepared/recovery-holder', sha256: 'c'.repeat(64) } };

async function journalFixture(unknownRole: 'compute' | 'network' = 'compute') {
  const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64');
  const options = fixture.options(); assert(options.egress);
  const configuration = { ...options, egress: { ...options.egress, control: { heartbeatMs: 1000, leaseTimeoutMs: 60_000 } } };
  const legacy = parseDockerConfig(configuration); assert(legacy.egressAuthority?.kind === 'local_docker_desktop');
  const sharedDigest = desktopSharedAuthorityDigest(legacy.egressAuthority.identity);
  const daemonId = fixture.descriptor.engine.id;
  const generation = { generationId: '00000000-0000-4000-8000-000000000002', ordinal: 1,
    coordinationRevision: 'desktop-coordination-v1' as const, coordinationPolicyDigest: DESKTOP_COORDINATOR_POLICY_DIGEST,
    engineBindingDigest: coordinatorDigest('agenai.desktop-coordinator.engine-binding.v1', JSON.stringify({ daemonId, shared: sharedDigest })),
    endpointBindingDigest: digest, hostPreparationDigest: sharedDigest,
    nativeAssetDigest: coordinatorDigest('agenai.desktop-coordinator.native-asset.v1', JSON.stringify(originalHelper)) };
  const authorityId = '00000000-0000-4000-8000-000000000001';
  const initial = createInitialCoordinatorSnapshot({ authorityId, daemonId });
  const began = beginCoordinatorGeneration(initial, { identity: generation, basis: { kind: 'host_engine_only', hostDigest: digest,
    engineDigest: digest, exclusionDigest: coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(claim)), atSequence: 1 } });
  if (began.kind === 'rejected') assert.fail(began.reason);
  let snapshot = began.snapshot;
  const config = parseCoordinatedDockerCleanupConfig(configuration, { endpoint: fixture.endpoint, configurationDigest: sharedDigest,
    identity: { protocol: 'agenai.desktop-coordinator.v1', authorityId, engineKey: coordinatorEngineKey(daemonId), daemonId, generation } });
  const original = newRecoveryRecord(config, sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }));
  const apply = (event: CoordinatorEvent) => {
    const plan = planCoordinatorTransition(snapshot, event);
    if (plan.kind === 'rejected') assert.fail(plan.reason);
    snapshot = plan.snapshot;
  };
  const member = () => {
    assert.equal(snapshot.generation.kind, 'dirty');
    if (snapshot.generation.kind !== 'dirty' || !snapshot.generation.members[0]) assert.fail('Expected original member');
    return snapshot.generation.members[0];
  };
  assert(original.backendRevision === 'engine-1.52-v7-desktop-apple-virtualization-native-arm64');
  apply({ kind: 'register', record: original, slot: 0, binding: { profile: 'desktop-apple-virtualization-native-arm64',
    backendRevision: original.backendRevision, configurationIdentityDigest: original.configurationDigest } });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 2000);
  const armCreate = (role: ResourceRole) => {
    const current = member().checkpoint.record;
    apply({ kind: 'checkpoint', memberId: original.operationId, mode: 'caller_persisted', record: parseSandboxRecoveryRecord({ ...current,
      phase: 'starting', authority: { kind: 'verified', backendIdentity: daemonId }, resources: current.resources.map((resource) => resource.role === role
        ? { ...resource, identity: { kind: 'creating' } } : resource) }) });
    apply({ kind: 'queue', memberId: original.operationId, role, action: 'create' });
    if (snapshot.generation.kind !== 'dirty') assert.fail('Expected dirty create');
    const effect = snapshot.generation.queue.find((entry) => entry.role === role); assert(effect);
    apply({ kind: 'arm', effectSequence: effect.effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest });
    return effect.effectSequence;
  };
  const observerEffect = armCreate('route_observer');
  let record = member().checkpoint.record;
  const observer = record.resources.find((resource) => resource.role === 'route_observer'); assert(observer);
  await api.request('POST', `/v1.52/containers/create?name=${encodeURIComponent(observer.name)}`,
    { body: Buffer.from(JSON.stringify(desktopObserverContainerBody(config, record))), contentType: 'application/json' });
  const inspection = await inspectResource(api, config, record, observer, observer.name); assert(inspection);
  apply({ kind: 'returned', effectSequence: observerEffect, id: inspection.id });
  record = parseSandboxRecoveryRecord({ ...record, resources: record.resources.map((resource) => resource.role === 'route_observer'
    ? { ...resource, identity: { kind: 'identified', id: inspection.id, fingerprint: inspection.fingerprint } } : resource) });
  apply({ kind: 'settle', effectSequence: observerEffect, outcome: 'present', receiptDigest: digest, record,
    presence: { kind: 'present', id: inspection.id, fingerprint: inspection.fingerprint, inspectionDigest: digest, runtime: 'created' } });
  apply({ kind: 'queue', memberId: original.operationId, role: 'route_observer', action: 'start' });
  if (snapshot.generation.kind !== 'dirty') assert.fail('Expected queued start');
  const start = snapshot.generation.queue[0]; assert(start);
  apply({ kind: 'arm', effectSequence: start.effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest });
  apply({ kind: 'settle', effectSequence: start.effectSequence, outcome: 'started', receiptDigest: digest,
    presence: { kind: 'present', id: inspection.id, fingerprint: inspection.fingerprint, inspectionDigest: digest, runtime: 'running' } });
  apply({ kind: 'full_basis', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest: digest,
    externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(claim)),
    projectionDigest: digest, atSequence: snapshot.sequence + 1 } });
  const storageEffect = armCreate('storage');
  record = member().checkpoint.record;
  const storage = record.resources.find((resource) => resource.role === 'storage'); assert(storage);
  await api.request('POST', '/v1.52/volumes/create', { body: Buffer.from(JSON.stringify({ Name: storage.name, Driver: 'local', Labels: resourceLabels(record, 'storage') })), contentType: 'application/json' });
  const volume = await inspectResource(api, config, record, storage, storage.name); assert(volume);
  apply({ kind: 'returned', effectSequence: storageEffect, id: volume.id });
  record = parseSandboxRecoveryRecord({ ...record, resources: record.resources.map((resource) => resource.role === 'storage'
    ? { ...resource, identity: { kind: 'identified', id: volume.id, fingerprint: volume.fingerprint } } : resource) });
  apply({ kind: 'settle', effectSequence: storageEffect, outcome: 'present', receiptDigest: digest, record,
    presence: { kind: 'present', id: volume.id, fingerprint: volume.fingerprint, inspectionDigest: digest, runtime: 'not_applicable' } });
  armCreate(unknownRole);
  const pendingOriginal = snapshot;
  apply({ kind: 'reopen_cleanup' });
  const text = encodeCoordinatorSnapshot(snapshot);
  const conversion = { claim, archive: { scope: 'transaction' as const, slot: 'origin_archive' as const,
    digest: originalFrameDigest(text, snapshot), bytes: Buffer.byteLength(text) + 148 },
  preparation: { configuredEndpoint: fixture.endpoint, sharedDigest, originalHelper, recoveryHelper },
  transport: { kind: 'sdk-current-transport.v1' as const, admittedAtSequence: snapshot.sequence + 1,
    endpointDigest: digest, nativeFactsDigest: digest, engineFactsDigest: digest } };
  return { fixture, api, config, original: snapshot, pendingOriginal, text, conversion, memberId: original.operationId,
    close: () => fixture.close() };
}
function acceptBarrier(envelope: RecoveryEnvelope): { envelope: RecoveryEnvelope; decision: SdkDecision } {
  envelope = transitionRecovery(envelope, { kind: 'prepare_attempt' });
  assert.equal(envelope.phase.kind, 'attempt_prepared');
  if (envelope.phase.kind !== 'attempt_prepared') assert.fail('Expected prepared observation');
  const attempt = envelope.phase.ordinal;
  const preparedRawDigest = rawDigest(encodeRecoveryEnvelope(envelope));
  const ref = (slot: 'admission' | 'armed' | 'stopped' | 'finished') => ({ scope: 'attempt' as const, attempt, slot, digest, bytes: 512 });
  envelope = transitionRecovery(envelope, { kind: 'armed', preparedRawDigest, armed: ref('armed') });
  envelope = transitionRecovery(envelope, { kind: 'stopped', stopped: ref('stopped') });
  const spans = [{ source: 'init' as const, sourceIdentity: 'original-native-source', start: '0', end: '1', sequence: 1, sha256: digest }];
  const range = { spanStart: 0, spanEnd: 0 };
  const events: RestorationEvent[] = [{ kind: 'linux_boot', ...range }, { kind: 'vm_identity', vmId: '00000000-0000-4000-8000-000000000003', ...range },
    { kind: 'containerd_ready', ...range }, { kind: 'dockerd_process', pid: 1, ...range }, { kind: 'dockerd_start', ...range },
    { kind: 'load_start', ...range }, { kind: 'restore_start', ...range }, { kind: 'load_complete', ...range },
    { kind: 'initialization_complete', ...range }, { kind: 'api_listen', ...range }];
  const decision = parseSdkDecision(JSON.stringify({ format: 'agenai.desktop-recovery.sdk-decision.v1', kind: 'barrier_acceptance',
    binding: recoveryDecisionBinding(envelope), attempt, previousHistory: envelope.historyHead, preparedRawDigest,
    native: { admission: ref('admission'), armed: ref('armed'), stopped: ref('stopped'), finished: ref('finished') },
    transport: { ...envelope.transport, admittedAtSequence: envelope.sequence + 1 },
    restoration: { kind: 'accepted', profile: 'stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1',
      spans, events, warnings: [], diagnostics: [], sourceSpanDigest: restorationSpansDigest(spans),
      classifiedEventsDigest: restorationEventsDigest({ events, warnings: [], diagnostics: [] }),
      engineIdentityDigest: digest, storeIdentityDigest: digest } }));
  assert(decision.kind === 'barrier_acceptance');
  const receipt = sdkDecisionReceipt(decision); assert(receipt.scope === 'decision');
  return { envelope: transitionRecovery(envelope, { kind: 'accept_barrier', decision, receipt }), decision };
}

test('migration preserves exact original bytes and uncertainty while older readers reject the administrative format', async () => {
  const owned = await journalFixture();
  try {
    const originalText = ` ${owned.text}\n`;
    const archive = { ...owned.conversion.archive, digest: originalFrameDigest(originalText, owned.original), bytes: Buffer.byteLength(originalText) + 148 };
    const recovery = createRecoveryEnvelope(originalText, { ...owned.conversion, archive });
    assert.equal(Buffer.from(recovery.origin.payloadBase64, 'base64').toString(), originalText);
    assert.equal(recovery.sequence, owned.original.sequence + 1);
    assert.equal(recovery.projection.snapshot.generation.kind, 'dirty');
    assert.throws(() => parseCoordinatorSnapshot(encodeRecoveryEnvelope(recovery)));
    const reloaded = parseRecoveryEnvelope(encodeRecoveryEnvelope(recovery));
    assert.equal(reloaded.origin.rawDigest, rawDigest(originalText));
    const pendingText = encodeCoordinatorSnapshot(owned.pendingOriginal);
    const normalized = createRecoveryEnvelope(pendingText, { ...owned.conversion, archive: { ...archive,
      digest: originalFrameDigest(pendingText, owned.pendingOriginal), bytes: Buffer.byteLength(pendingText) + 148 } });
    const normalizedGeneration = normalized.projection.snapshot.generation; assert(normalizedGeneration.kind === 'dirty');
    assert.equal(normalizedGeneration.members[0]?.roles.find((role) => role.role === 'compute')?.create.kind, 'uncertain');
    const generation = recovery.projection.snapshot.generation; assert(generation.kind === 'dirty');
    for (const forgery of ['erase_uncertain', 'replace_settled'] as const) {
      const forgedSnapshot = parseCoordinatorSnapshot(encodeCoordinatorSnapshot({ ...recovery.projection.snapshot,
        generation: { ...generation, members: generation.members.map((member) => ({ ...member,
          roles: member.roles.map((role) => forgery === 'erase_uncertain' && role.role === 'compute'
            ? { ...role, create: { kind: 'not_entered' as const }, presence: { kind: 'not_entered' as const, provedAtSequence: recovery.sequence } }
            : forgery === 'replace_settled' && role.role === 'route_observer' && role.create.kind === 'settled'
              ? { ...role, create: { ...role.create, receiptDigest: `sha256:${'d'.repeat(64)}` } } : role) })) } }));
      assert.throws(() => encodeRecoveryEnvelope({ ...recovery, projection: { ...recovery.projection, snapshot: forgedSnapshot } }), { reason: 'invalid' });
    }
    const wire: unknown = JSON.parse(encodeRecoveryEnvelope(recovery)); assert(wire && typeof wire === 'object');
    Reflect.set(wire, 'origin', { ...recovery.origin, payloadBase64: Buffer.from(owned.text).toString('base64') });
    assert.throws(() => parseRecoveryEnvelope(JSON.stringify(wire)));
    assert.equal(encodeCoordinatorSnapshot(owned.original), owned.text);
  } finally { await owned.close(); }
});

test('unknown-ID non-container refusal leaves its original canonical authority unchanged before takeover', async () => {
  const owned = await journalFixture('network');
  try {
    assert.throws(() => createRecoveryEnvelope(owned.text, owned.conversion), { reason: 'unsupported_no_id_noncontainer' });
    assert.equal(encodeCoordinatorSnapshot(owned.original), owned.text);
    assert.equal(owned.fixture.volumes.size, 1);
  } finally { await owned.close(); }
});

test('cancelled unentered deletes preserve cleanup capacity for every original resource', async () => {
  const owned = await journalFixture();
  try {
    const original = identifiedRecoveryJournalFixture(owned.config, owned.original);
    const text = encodeCoordinatorSnapshot(original);
    const recovery = createRecoveryEnvelope(text, { ...owned.conversion, archive: { ...owned.conversion.archive,
      digest: originalFrameDigest(text, original), bytes: Buffer.byteLength(text) + 148 } });
    const generation = recovery.projection.snapshot.generation; assert(generation.kind === 'dirty');
    assert.equal(generation.members.length, 4);
    assert.equal(generation.members.flatMap((member) => member.roles).length, 36);
    const first = generation.members[0]; assert(first);
    let envelope = planCleanupTransition(recovery, { kind: 'queue', memberId: first.memberId, role: 'compute', action: 'delete' });
    envelope = planCleanupTransition(envelope, { kind: 'cancel_queued', effectSequence: generation.nextEffectSequence });
    const cancelled = envelope.projection.snapshot.generation; assert(cancelled.kind === 'dirty');
    assert.equal(cancelled.members[0]?.roles.find((role) => role.role === 'compute')?.delete.kind, 'not_entered');
    const completed: number[] = [];
    for (const member of generation.members) for (const resource of member.checkpoint.record.resources) {
      assert(resource.identity.kind === 'identified');
      envelope = planCleanupTransition(envelope, { kind: 'queue', memberId: member.memberId, role: resource.role, action: 'delete' });
      const queued = envelope.projection.snapshot.generation; assert(queued.kind === 'dirty');
      const effect = queued.queue[0]; assert(effect);
      envelope = planCleanupTransition(envelope, { kind: 'arm', effectSequence: effect.effectSequence,
        expectedBeforeDigest: digest, expectedInputDigest: digest });
      envelope = planCleanupTransition(envelope, { kind: 'settle', effectSequence: effect.effectSequence, outcome: 'absent', receiptDigest: digest,
        presence: { kind: 'absent', reference: resource.identity.id, fingerprint: resource.identity.fingerprint,
          inspectedAtSequence: envelope.sequence + 1, noLateProducerAfter: envelope.sequence } });
      completed.push(effect.effectSequence);
    }
    const settled = parseRecoveryEnvelope(encodeRecoveryEnvelope(envelope)).projection.snapshot.generation; assert(settled.kind === 'dirty');
    assert.deepEqual(completed, Array.from({ length: 36 }, (_, index) => generation.nextEffectSequence + index + 1));
    assert.equal(settled.nextEffectSequence, generation.nextEffectSequence + 37);
    assert.equal(settled.members.flatMap((member) => member.roles).filter((role) => role.delete.kind === 'settled' && role.presence.kind === 'absent').length, 36);
    assert.equal(Buffer.from(envelope.origin.payloadBase64, 'base64').toString(), text);
  } finally { await owned.close(); }
});

test('administrative cleanup retains dependents before proof and reuses exact cleanup after accepted evidence', async () => {
  const owned = await journalFixture();
  try {
    let envelope = createRecoveryEnvelope(owned.text, owned.conversion);
    const decisions = new Map<string, SdkDecision>();
    const adapter = new RecoveryCleanupJournalAdapter({ api: owned.api, current: () => envelope,
      async publish(next) { envelope = next; }, async assertAuthority() {}, async assertBarrierCurrent() {},
      run: (perform) => perform(),
      async readSdkDecision(ref) { const decision = decisions.get(ref.digest); assert(decision); return decision; },
      async publishSdkDecision(decision) { const ref = sdkDecisionReceipt(decision); decisions.set(ref.digest, decision); return ref; } });
    const original = (await adapter.members())[0]; assert(original);
    const result = await adapter.reconcile(owned.config, original);
    assert.equal(result.kind, 'uncertain'); if (result.kind !== 'uncertain') assert.fail('Expected retained unknown create owner');
    await assert.rejects(result.owner.destroy());
    assert.equal(owned.fixture.volumes.size, 1, 'The original volume cannot be removed while a compute producer is uncertain.');
    const accepted = acceptBarrier(envelope); envelope = accepted.envelope;
    decisions.set(sdkDecisionReceipt(accepted.decision).digest, accepted.decision);
    const renewedAttempt = transitionRecovery(envelope, { kind: 'prepare_attempt' });
    assert.deepEqual(renewedAttempt.historyHead, sdkDecisionReceipt(accepted.decision), 'A fresh observation retains the exact previously accepted history.');
    await result.owner.destroy();
    assert.equal(owned.fixture.volumes.size, 0);
    assert.equal(owned.fixture.containers.size, 0);
    assert.equal(result.owner.recoveryRecord.phase, 'destroyed');
    const terminalRecord = (await adapter.members())[0]; assert(terminalRecord);
    assert.equal(terminalRecord.phase, 'destroyed');
    const driver = { backendId: terminalRecord.backendId, backendRevision: terminalRecord.backendRevision,
      reconcile: (record: typeof terminalRecord) => adapter.reconcile(owned.config, record) };
    const retired = await reconcileSandboxRecovery(driver, terminalRecord);
    assert.equal(retired.kind, 'matched'); if (retired.kind !== 'matched') assert.fail('A no-ID terminal record retains its idempotent cleanup owner.');
    const retiredState = encodeRecoveryEnvelope(envelope);
    await retired.owner.stop(); await retired.owner.destroy(); await retired.owner.destroy();
    assert.deepEqual(retired.owner.recoveryRecord, terminalRecord);
    assert.equal(encodeRecoveryEnvelope(envelope), retiredState);
    assert(terminalRecord.resources.some((resource) => resource.identity.kind === 'creating'));
    await assert.rejects(reconcileSandboxRecovery({ ...driver,
      reconcile: async () => ({ kind: 'absent' as const, record: terminalRecord }) }, terminalRecord),
    { message: 'An entered acquisition with unresolved identity cannot be conclusively absent.' });
    assert.equal((await adapter.reconcile(owned.config, original)).kind, 'conflict');
    const generation = envelope.projection.snapshot.generation; assert(generation.kind === 'dirty');
    assert.equal(generation.members.length, 0); assert.equal(generation.retired.length, 1);
    assert.equal(envelope.noIdAbsences[0]?.role, 'compute');
    assert.equal(Buffer.from(envelope.origin.payloadBase64, 'base64').toString(), owned.text);
  } finally { await owned.close(); }
});

test('publication loss retains exact ownership and reacknowledges synchronization without replacing history', async () => {
  const owned = await journalFixture();
  try {
    const recovery = createRecoveryEnvelope(owned.text, owned.conversion);
    let stored = owned.text;
    let failAfterCommit = true;
    const commits: string[] = [];
    const publisher = new RecoveryPublicationOwner({ async readCanonical() { return { text: stored, pendingTemp: false }; },
      async commitCanonical(expected, text) { assert.equal(expected, rawDigest(stored)); stored = text; commits.push(text);
        if (failAfterCommit) { failAfterCommit = false; throw new Error('Lost durable commit reply'); } },
      async discardUnpublishedTemp() { assert.fail('No temp exists'); } }, stored);
    await assert.rejects(publisher.publish(recovery), { reason: 'publication' });
    assert.equal(publisher.pending, true);
    assert.equal(publisher.text, encodeRecoveryEnvelope(recovery));
    await publisher.reconcile();
    assert.equal(publisher.pending, false);
    assert.deepEqual(commits, [encodeRecoveryEnvelope(recovery), encodeRecoveryEnvelope(recovery)]);
    const released = transitionRecovery(recovery, { kind: 'request_release' });
    const stale = transitionRecovery(recovery, { kind: 'refresh_transport', transport: { ...recovery.transport,
      endpointDigest: `sha256:${'d'.repeat(64)}` } });
    const first = publisher.publish(released);
    const second = publisher.publish(stale);
    await first;
    await assert.rejects(second, { reason: 'publication' });
    assert.equal(stored, encodeRecoveryEnvelope(released));
    assert.equal(publisher.pending, false);
    stored = encodeCoordinatorSnapshot(createInitialCoordinatorSnapshot({ authorityId: '00000000-0000-4000-8000-000000000004', daemonId: owned.original.daemonId }));
    await assert.rejects(publisher.reconcile(), { reason: 'publication' });
    assert.equal(publisher.text, encodeRecoveryEnvelope(released));
  } finally { await owned.close(); }
});

test('lost member-manifest reply rejoins the same fixed bytes after metadata advances and fresh retirement', async () => {
  const owned = await journalFixture();
  try {
    let envelope = createRecoveryEnvelope(owned.text, owned.conversion);
    const slots = new Map<string, string>();
    const decisions = new Map<string, SdkDecision>();
    let loseManifestReply = true;
    const makeAdapter = () => new RecoveryCleanupJournalAdapter({ api: owned.api, current: () => envelope,
      async publish(next) { envelope = next; }, async assertAuthority() {}, async assertBarrierCurrent() {}, run: (perform) => perform(),
      async readSdkDecision(ref) { const decision = decisions.get(ref.digest); assert(decision); return decision; },
      async publishSdkDecision(decision) {
        const key = decision.kind === 'member_terminal' ? `member/${decision.memberId}` : decision.kind;
        const text = encodeSdkDecision(decision);
        const existing = slots.get(key);
        if (existing !== undefined && existing !== text) throw new Error('Immutable fixed slot conflicts with retry');
        slots.set(key, text);
        const receipt = sdkDecisionReceipt(decision); decisions.set(receipt.digest, decision);
        if (decision.kind === 'member_terminal' && loseManifestReply) { loseManifestReply = false; throw new Error('Lost member manifest acknowledgement'); }
        return receipt;
      } });
    const adapter = makeAdapter();
    const result = await adapter.reconcile(owned.config, (await adapter.members())[0]);
    if (result.kind !== 'uncertain') assert.fail('Expected original uncertain cleanup owner');
    await assert.rejects(result.owner.destroy());
    const accepted = acceptBarrier(envelope); envelope = accepted.envelope;
    decisions.set(sdkDecisionReceipt(accepted.decision).digest, accepted.decision);
    await assert.rejects(result.owner.destroy(), /Lost member manifest acknowledgement/u);
    const before = slots.get(`member/${owned.memberId}`); assert(before);
    const generation = envelope.projection.snapshot.generation; assert(generation.kind === 'dirty');
    assert.equal(generation.members[0]?.checkpoint.record.phase, 'destroyed');
    envelope = transitionRecovery(envelope, { kind: 'request_release' });
    envelope = transitionRecovery(envelope, { kind: 'clear_release' });
    const fresh = makeAdapter();
    await fresh.resumeDestroyedMembers();
    assert.equal(slots.get(`member/${owned.memberId}`), before);
    const retired = envelope.projection.snapshot.generation; assert(retired.kind === 'dirty');
    assert.equal(retired.members.length, 0);
    assert.equal((await fresh.members())[0]?.phase, 'destroyed');
    assert.equal(owned.fixture.volumes.size, 0);
    assert.equal(owned.fixture.containers.size, 0);
  } finally { await owned.close(); }
});

test('complete final inventory survives metadata and finishes exact clean v1 handback without another Engine observation', async () => {
  const owned = await journalFixture();
  try {
    let envelope = createRecoveryEnvelope(owned.text, owned.conversion);
    const decisions = new Map<string, SdkDecision>();
    const adapter = new RecoveryCleanupJournalAdapter({ api: owned.api, current: () => envelope,
      async publish(next) { envelope = next; }, async assertAuthority() {}, async assertBarrierCurrent() {}, run: (perform) => perform(),
      async readSdkDecision(ref) { const decision = decisions.get(ref.digest); assert(decision); return decision; },
      async publishSdkDecision(decision) { const receipt = sdkDecisionReceipt(decision); decisions.set(receipt.digest, decision); return receipt; } });
    const result = await adapter.reconcile(owned.config, (await adapter.members())[0]);
    if (result.kind !== 'uncertain') assert.fail('Expected original uncertain cleanup owner');
    await assert.rejects(result.owner.destroy());
    const accepted = acceptBarrier(envelope); envelope = accepted.envelope;
    decisions.set(sdkDecisionReceipt(accepted.decision).digest, accepted.decision);
    await result.owner.destroy();
    const member = [...decisions.values()].find((decision) => decision.kind === 'member_terminal'); assert(member?.kind === 'member_terminal');
    assert.equal(terminalDecisionMember(member).memberId, owned.memberId);
    const historicalVerifications: number[] = [];
    const evidencePorts = {
      async readSdkDecision(ref: ReceiptRef) {
        const decision = decisions.get(ref.digest); assert(decision); return decision;
      },
      async findSdkDecision(scope: TypedReceiptScope) {
        const decision = [...decisions.values()].find((entry) => {
          const actual = sdkDecisionScope(entry); return actual.kind === scope.kind && actual.scope === scope.scope;
        });
        return decision ? { ref: sdkDecisionReceipt(decision), decision } : undefined;
      },
      async verifyNativeBarrier(_current: RecoveryEnvelope, decision: BarrierAcceptanceDecision) {
        assert.equal(decision.preparedRawDigest, accepted.decision.kind === 'barrier_acceptance' ? accepted.decision.preparedRawDigest : '');
        historicalVerifications.push(decision.attempt);
      },
      async verifyOutcome() { assert.fail('No failed observation occurred'); },
    };
    const missingRows: unknown = JSON.parse(encodeRecoveryEnvelope(envelope));
    assert(missingRows && typeof missingRows === 'object');
    Reflect.set(missingRows, 'noIdAbsences', []);
    const retainedWithoutProof = parseRecoveryEnvelope(JSON.stringify(missingRows));
    await assert.rejects(validateRecoveryEvidence(retainedWithoutProof, evidencePorts), { reason: 'evidence' });
    const proofGeneration = member.memberProof.generation; assert(proofGeneration.kind === 'dirty');
    const erasedProof = parseCoordinatorSnapshot(encodeCoordinatorSnapshot({ ...member.memberProof,
      generation: { ...proofGeneration, members: proofGeneration.members.map((entry) => ({ ...entry,
        roles: entry.roles.map((role) => role.role === 'compute' ? { ...role, create: { kind: 'not_entered' as const },
          presence: { kind: 'not_entered' as const, provedAtSequence: member.memberProof.sequence } } : role) })) } }));
    const erasedDecision = parseSdkDecision(JSON.stringify(wireSdkDecision({ ...member, memberProof: erasedProof })));
    const erasedReceipt = sdkDecisionReceipt(erasedDecision); assert(erasedReceipt.scope === 'member');
    Reflect.set(missingRows, 'memberTerminals', envelope.memberTerminals.map((entry) => ({ ...entry, receipt: erasedReceipt })));
    const erasedOriginalAction = parseRecoveryEnvelope(JSON.stringify(missingRows));
    await assert.rejects(validateRecoveryEvidence(erasedOriginalAction, { ...evidencePorts,
      readSdkDecision: async (ref) => ref.digest === erasedReceipt.digest ? erasedDecision : evidencePorts.readSdkDecision(ref),
    }), { reason: 'invalid' });
    const resources = [];
    for (const resource of member.record.resources) {
      const role = terminalDecisionMember(member).roles.find((entry) => entry.role === resource.role); assert(role);
      const reference = resource.identity.kind === 'identified' ? resource.identity.id
        : role.presence.kind === 'absent' ? role.presence.reference : resource.name;
      const inspected = await owned.api.request('GET', inspectPath(resource, reference), { statuses: [200, 404] });
      assert.equal(inspected.statusCode, 404);
      resources.push({ memberId: owned.memberId, role: resource.role, name: resource.name, reference,
        fingerprint: resource.identity.kind === 'identified' ? resource.identity.fingerprint : null,
        outcome: 'absent' as const, inspectionDigest: coordinatorDigest('independent-final-observation', `${resource.role}/${reference}/404`) });
    }
    const final = createFinalInventoryDecision(envelope, resources);
    const finalRef = sdkDecisionReceipt(final); assert(finalRef.scope === 'transaction' && finalRef.slot === 'final_inventory');
    decisions.set(finalRef.digest, final);
    assert.throws(() => transitionRecovery(envelope, { kind: 'prepare_attempt' }), { reason: 'transition' });
    assert.deepEqual(planFinalInventory(envelope, final, finalRef).historyHead, sdkDecisionReceipt(accepted.decision));
    const oldActive: unknown = JSON.parse(encodeRecoveryEnvelope(transitionRecovery(envelope, { kind: 'request_release' })));
    assert(oldActive && typeof oldActive === 'object');
    Reflect.set(oldActive, 'phase', { kind: 'attempt_prepared', ordinal: envelope.nextAttempt });
    Reflect.set(oldActive, 'nextAttempt', envelope.nextAttempt + 1);
    Reflect.set(oldActive, 'historyHead', sdkDecisionReceipt(accepted.decision));
    const retainedActive = parseRecoveryEnvelope(JSON.stringify(oldActive));
    const exactActiveBytes = encodeRecoveryEnvelope(retainedActive);
    assert.throws(() => planFinalInventory(retainedActive, final, finalRef), { reason: 'transition' });
    assert.equal(encodeRecoveryEnvelope(retainedActive), exactActiveBytes, 'Resource completion cannot discard an active observation or its prior history.');
    envelope = transitionRecovery(envelope, { kind: 'request_release' });
    envelope = transitionRecovery(envelope, { kind: 'refresh_transport', transport: { ...envelope.transport,
      endpointDigest: `sha256:${'d'.repeat(64)}` } });
    const fresh = await validateRecoveryEvidence(parseRecoveryEnvelope(encodeRecoveryEnvelope(envelope)), evidencePorts);
    assert.equal(fresh.finalInventory?.ref.digest, finalRef.digest);
    assert.deepEqual(fresh.records, [member.record]);
    assert(historicalVerifications.length > 0, 'Offline completion still verifies historical native proof.');
    const terminal = planFinalInventory(envelope, final, finalRef);
    assert.equal(terminal.phase.kind, 'terminal_ready');
    assert.equal(transitionRecovery(terminal, { kind: 'request_release' }), terminal);
    const terminalText = encodeRecoveryEnvelope(terminal);
    const archive = { scope: 'transaction' as const, slot: 'terminal_archive' as const,
      digest: originalFrameDigest(terminalText, terminal.projection.snapshot), bytes: Buffer.byteLength(terminalText) + 148 };
    const manifest = createGenerationTerminalDecision(terminal, archive);
    decisions.set(sdkDecisionReceipt(manifest).digest, manifest);
    const terminalGraph = await validateRecoveryEvidence(terminal, evidencePorts);
    assert.equal(terminalGraph.terminal?.decision.cleanText, manifest.cleanText);
    const clean = planCleanHandback(terminal);
    assert.equal(encodeCoordinatorSnapshot(clean), manifest.cleanText);
    assert.equal(clean.generation.kind, 'clean');
    if (clean.generation.kind !== 'clean') assert.fail('Expected original clean handback');
    assert.equal(clean.generation.lastGenerationId, terminal.origin.generationId);
    assert.equal(clean.generation.generationOrdinal, terminal.origin.generationOrdinal);
    assert.equal(clean.sequence, terminal.sequence + 1);
    assert.equal(clean.authorityId, owned.original.authorityId);
    assert.equal(parseCoordinatorSnapshot(manifest.cleanText).generation.kind, 'clean');
    assert.equal(manifest.origin.digest, owned.conversion.archive.digest);
    assert.equal(Buffer.from(terminal.origin.payloadBase64, 'base64').toString(), owned.text);
  } finally { await owned.close(); }
});
