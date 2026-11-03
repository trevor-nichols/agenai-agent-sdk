import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { RecoveryEvidence } from '../src/node/desktopRecovery/evidence.js';
import { nativeFactSchema } from '../src/node/desktopRecovery/native/schemas.js';
import type { NativeFact, NativeCurrentAdmissionFacts } from '../src/node/desktopRecovery/native/schemas.js';
import type { ValidatedRecoveryReceipt } from '../src/node/desktopRecovery/native/owner.js';
import { digestBytes } from '../src/node/desktopRecovery/native/framing.js';
import { recoveryNativeFactsDigest, recoveryStoreIdentityDigest } from '../src/node/desktopRecovery/restoration/engine.js';
import { beginCoordinatorGeneration, createInitialCoordinatorSnapshot, planCoordinatorTransition } from '../src/network/desktop/coordinator/journal/plans.js';
import { coordinatorDigest, encodeCoordinatorSnapshot } from '../src/network/desktop/coordinator/journal/schema.js';
import { DESKTOP_COORDINATOR_POLICY_DIGEST } from '../src/network/desktop/coordinator/policy.js';
import { createRecoveryEnvelope, planHelperReplacement, transitionRecovery } from '../src/network/desktop/coordinator/administrativeRecovery/plans.js';
import { encodeRecoveryEnvelope, parseRecoveryEnvelope, recoveryEnvelopeV1Schema, recoveryEnvelopeV2Schema } from '../src/network/desktop/coordinator/administrativeRecovery/schema.js';
import { FIRST_SUCCESSOR_PROFILE, FIRST_SUCCESSOR_SOURCE, PREVIOUS_RECOVERY_PROFILE, PREVIOUS_RECOVERY_SOURCE } from '../src/network/desktop/coordinator/administrativeRecovery/helperSuccession.js';
import { originalFrameDigest } from '../src/network/desktop/coordinator/administrativeRecovery/validation.js';
import { rawDigest } from '../src/network/desktop/coordinator/administrativeRecovery/scalars.js';
import { recoveryDecisionBinding, parseSdkDecision } from '../src/network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { restorationEventSchema, restorationEventsDigest, restorationSpansDigest, restorationSpanSchema } from '../src/network/desktop/coordinator/administrativeRecovery/restoration.js';
import type { NativeAttemptRef, NativeOutcomeRef, TypedReceiptScope } from '../src/network/desktop/coordinator/administrativeRecovery/receipts.js';
import { sameReceipt } from '../src/network/desktop/coordinator/administrativeRecovery/receipts.js';

const digest = `sha256:${'a'.repeat(64)}`;
const claim = { rootDevice: '1', rootInode: '2', lockDevice: '1', lockInode: '3' };
const originalHelper = { protocol: 'agenai.desktop-coordinator.v1' as const, sourceDigest: digest,
  executable: { path: '/prepared/original', sha256: 'b'.repeat(64) } };
const helper = { protocol: 'agenai.desktop-recovery-observer.v1' as const, sourceDigest: digest,
  executable: { path: '/prepared/recovery', sha256: 'c'.repeat(64) } };
const roles = ['backend', 'virtualization', 'build', 'docker_cli', 'desktop_cli'] as const;
const images = roles.map((role, i) => ({ role, sha256: String(i + 1).repeat(64), identifier: role, team: '9BNSXJN65R' }));
const processFacts = (base: number): NativeCurrentAdmissionFacts['processes'] => [0, 1].map((offset) => ({
  role: offset === 0 ? 'backend' : 'virtualization', pid: base + offset, uid: 501,
  parentPid: 1, processGroup: base, startSeconds: String(base), startMicroseconds: '0', pidVersion: null,
  imageSha256: images[offset]?.sha256 ?? assert.fail('Missing fixed image'),
}));
const facts = (base: number, continuousNs: string): NativeCurrentAdmissionFacts => ({
  profileDigest: 'd'.repeat(64), hostBoot: '33333333-3333-4333-8333-333333333333', uid: 501, continuousNs,
  images, processes: processFacts(base), peer: { pid: base, pidVersion: base, uid: 501, device: '1', inode: String(base) },
  store: { parentDevice: '1', parentInode: '49', device: '1', inode: '50', uid: '501', mode: '420', birthSeconds: '100', birthNanoseconds: '0' },
  metadata: { components: { sha256: 'e'.repeat(64), bytes: 402 }, settings: { sha256: 'f'.repeat(64), bytes: 361 } },
});
const key = (scope: TypedReceiptScope) => `${scope.kind}:${scope.scope}`;

// Synthetic inputs test the historical verifier; they do not qualify native lifecycle observation.
function fixture(mutate: (fact: NativeFact) => NativeFact = (fact) => fact, lateOutcome = false, previousIssuer = false) {
  const selectedHelper = previousIssuer ? { ...helper, sourceDigest: PREVIOUS_RECOVERY_SOURCE } : helper;
  const profile = previousIssuer ? PREVIOUS_RECOVERY_PROFILE.slice(7) : 'd'.repeat(64);
  const currentFacts = (base: number, continuousNs: string) => ({ ...facts(base, continuousNs), profileDigest: profile });
  const initial = createInitialCoordinatorSnapshot({ authorityId: '11111111-1111-4111-8111-111111111111', daemonId: 'verification-fixture' });
  const begun = beginCoordinatorGeneration(initial, { identity: {
    generationId: '22222222-2222-4222-8222-222222222222', ordinal: 1, coordinationRevision: 'desktop-coordination-v1',
    coordinationPolicyDigest: DESKTOP_COORDINATOR_POLICY_DIGEST,
    engineBindingDigest: coordinatorDigest('agenai.desktop-coordinator.engine-binding.v1', JSON.stringify({ daemonId: initial.daemonId, shared: digest })),
    endpointBindingDigest: digest, hostPreparationDigest: digest,
    nativeAssetDigest: coordinatorDigest('agenai.desktop-coordinator.native-asset.v1', JSON.stringify(originalHelper)),
  }, basis: { kind: 'host_engine_only', hostDigest: digest, engineDigest: digest,
    exclusionDigest: coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(claim)), atSequence: 1 } });
  if (begun.kind === 'rejected') assert.fail(begun.reason);
  const record = parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'agenai-docker',
    backendRevision: 'engine-1.52-v7-desktop-apple-virtualization-native-arm64', namespace: 'evidence-tests',
    operationId: '66666666-6666-4666-8666-666666666666', sandboxId: 'docker-66666666-6666-4666-8666-666666666666',
    imageDigest: digest, configurationDigest: digest, policyDigest: digest, phase: 'reserved', authority: { kind: 'unverified' },
    resources: ['compute', 'storage', 'export', 'network', 'egress_socket', 'egress_broker', 'egress_relay', 'route_observer']
      .map((role) => ({ role, name: `evidence-original-${role}`, identity: { kind: 'planned' } })) });
  assert(record.backendRevision === 'engine-1.52-v7-desktop-apple-virtualization-native-arm64');
  const registered = planCoordinatorTransition(begun.snapshot, { kind: 'register', record, slot: 0,
    binding: { profile: 'desktop-apple-virtualization-native-arm64', backendRevision: record.backendRevision, configurationIdentityDigest: digest } });
  if (registered.kind === 'rejected') assert.fail(registered.reason);
  const text = encodeCoordinatorSnapshot(registered.snapshot);
  let envelope = createRecoveryEnvelope(text, { claim,
    archive: { scope: 'transaction', slot: 'origin_archive', digest: originalFrameDigest(text, registered.snapshot), bytes: Buffer.byteLength(text) + 148 },
    preparation: { configuredEndpoint: 'unix:///fixture/docker.sock', sharedDigest: digest, originalHelper, recoveryHelper: selectedHelper },
    transport: { kind: 'sdk-current-transport.v1', admittedAtSequence: 2, endpointDigest: digest, nativeFactsDigest: digest, engineFactsDigest: digest } });
  envelope = transitionRecovery(envelope, { kind: 'prepare_attempt' });
  const preparedRawDigest = rawDigest(encodeRecoveryEnvelope(envelope));
  const receipts = new Map<string, ValidatedRecoveryReceipt>();
  const link = (ref: NativeAttemptRef) => ({ kind: ref.slot, attempt: ref.attempt, sha256: ref.digest.slice(7) });
  const base = { format: 'agenai.desktop-recovery-native-fact.v1', engineKey: envelope.engineKey.slice(7),
    authorityId: envelope.authorityId, generationId: envelope.origin.generationId, recoveryKey: envelope.recoveryKey.slice(7),
    attempt: 1, originFrameDigest: envelope.origin.framedDigest.slice(7), claim, previousHistory: { kind: 'none' },
    issuer: { sourceDigest: selectedHelper.sourceDigest.slice(7), executableSha256: selectedHelper.executable.sha256 },
    profileDigest: profile, hostBoot: '33333333-3333-4333-8333-333333333333', uid: 501, startedContinuousNs: '1000000000' };
  const publish = (body: unknown) => {
    const fact = nativeFactSchema.parse(mutate(nativeFactSchema.parse(body)));
    const text = JSON.stringify(fact); const header = Buffer.alloc(512);
    header.write(`AGENAI-RECOVERY-1\n${fact.engineKey}\n${fact.recoveryKey}\n${fact.kind}\n${fact.attempt}\n${Buffer.byteLength(text)}\n${rawDigest(text).slice(7)}\n`);
    const frame = Buffer.concat([header, Buffer.from(text)]);
    const ref: NativeAttemptRef = { scope: 'attempt', attempt: fact.attempt, slot: fact.kind, digest: `sha256:${digestBytes(frame)}`, bytes: frame.length };
    const receipt = { kind: 'native' as const, ref, fact, text };
    receipts.set(`${fact.kind}:${fact.attempt}`, receipt);
    return receipt;
  };
  const admission = publish({ ...base, kind: 'admission', previous: null, canonicalPayloadSha256: preparedRawDigest.slice(7),
    finishedContinuousNs: '1200000000', facts: currentFacts(100, '1100000000') });
  const armed = publish({ ...base, kind: 'armed', previous: link(admission.ref), canonicalPayloadSha256: preparedRawDigest.slice(7),
    finishedContinuousNs: '1300000000', producers: processFacts(100), watchCount: 2, deadlineContinuousNs: '601000000000',
    logSources: [{ source: 'init', sourceIdentity: '1:10', initialOffset: '42' }, { source: 'console', sourceIdentity: '1:11', initialOffset: '0' }] });
  envelope = transitionRecovery(envelope, { kind: 'armed', preparedRawDigest, armed: armed.ref });
  const stopped = publish({ ...base, kind: 'stopped', previous: link(armed.ref), canonicalPayloadSha256: rawDigest(encodeRecoveryEnvelope(envelope)).slice(7),
    finishedContinuousNs: '2000000000', joined: processFacts(100), completeCensuses: 2, endpoint: 'not_serving' });
  envelope = transitionRecovery(envelope, { kind: 'stopped', stopped: stopped.ref });
  const spans = [{ source: 'init', sourceIdentity: '1:10', sequence: 1, start: '42', end: '80', sha256: 'e'.repeat(64) }];
  let finished = publish({ ...base, kind: 'finished', previous: link(stopped.ref), canonicalPayloadSha256: rawDigest(encodeRecoveryEnvelope(envelope)).slice(7),
    finishedContinuousNs: '4000000000', facts: currentFacts(200, '3000000000'), spans, spanManifestSha256: rawDigest(JSON.stringify(spans)).slice(7) });
  assert.equal(finished.fact.kind, 'finished');
  if (finished.fact.kind !== 'finished') assert.fail('Expected finished fixture');
  // Repair dependent checksums after semantic mutation so failures reach the intended graph rule.
  finished = publish({ ...finished.fact, spanManifestSha256: rawDigest(JSON.stringify(finished.fact.spans)).slice(7) });
  if (finished.fact.kind !== 'finished') assert.fail('Expected finished fixture');
  const restoredSpans = finished.fact.spans.map((span) => restorationSpanSchema.parse({ ...span, sha256: `sha256:${span.sha256}` }));
  const events = [
    { kind: 'linux_boot' }, { kind: 'vm_identity', vmId: '44444444-4444-4444-8444-444444444444' }, { kind: 'containerd_ready' },
    { kind: 'dockerd_process', pid: 600 }, { kind: 'dockerd_start' }, { kind: 'load_start' }, { kind: 'restore_start' },
    { kind: 'load_complete' }, { kind: 'initialization_complete' }, { kind: 'api_listen' },
  ].map((event) => restorationEventSchema.parse({ ...event, spanStart: 0, spanEnd: 0 }));
  const parsed = parseSdkDecision(JSON.stringify({ format: 'agenai.desktop-recovery.sdk-decision.v1', kind: 'barrier_acceptance',
    binding: recoveryDecisionBinding(envelope), attempt: 1, previousHistory: null, preparedRawDigest,
    native: { admission: admission.ref, armed: armed.ref, stopped: stopped.ref, finished: finished.ref },
    transport: { ...envelope.transport, admittedAtSequence: envelope.sequence + 1,
      nativeFactsDigest: recoveryNativeFactsDigest(finished.fact.facts) },
    restoration: { kind: 'accepted', profile: 'stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1', spans: restoredSpans,
      events, warnings: [], diagnostics: [], sourceSpanDigest: restorationSpansDigest(restoredSpans),
      classifiedEventsDigest: restorationEventsDigest({ events, warnings: [], diagnostics: [] }),
      engineIdentityDigest: digest, storeIdentityDigest: recoveryStoreIdentityDigest(finished.fact.facts) } }));
  if (parsed.kind !== 'barrier_acceptance') assert.fail('Expected barrier fixture');
  let outcome: NativeOutcomeRef | undefined;
  if (lateOutcome) {
    const receipt = publish({ ...base, kind: 'outcome', previous: link(finished.ref), lastCompleted: link(finished.ref),
      canonicalPayloadSha256: rawDigest(encodeRecoveryEnvelope(envelope)).slice(7), finishedContinuousNs: '5000000000',
      outcome: 'interrupted', reason: 'transport' });
    outcome = { ...receipt.ref, slot: 'outcome' };
  }
  const verifier = new RecoveryEvidence({ async readReceipt(scope, expected) {
    const found = receipts.get(key(scope));
    if (expected !== undefined && (!found || !sameReceipt(found.ref, expected))) assert.fail('Fixture reference mismatch');
    return found;
  } }, `sha256:${'d'.repeat(64)}`);
  return { verifier, envelope, decision: parsed, outcome, helper: selectedHelper, receipts, publish };
}

test('helper succession binds historical and new native outcomes to opposite sides of one fixed attempt cutoff', async () => {
  const value = fixture(undefined, true, true); assert(value.outcome);
  let released = transitionRecovery(value.envelope, { kind: 'close_attempt', terminal: value.outcome });
  released = transitionRecovery(released, { kind: 'request_release' });
  const adopted = planHelperReplacement(released, value.helper, helper, `sha256:${'d'.repeat(64)}`);
  assert.equal(recoveryEnvelopeV1Schema.safeParse(JSON.parse(encodeRecoveryEnvelope(adopted))).success, false);
  assert.deepEqual(await value.verifier.verifyOutcome(adopted, value.outcome), { previousHistory: null });
  const previous = value.receipts.get('outcome:1'); assert(previous?.kind === 'native' && previous.fact.kind === 'outcome');
  const current = value.publish({ ...previous.fact, attempt: 2, previous: null, lastCompleted: null,
    previousHistory: { kind: 'outcome', attempt: 1, sha256: value.outcome.digest.slice(7) },
    issuer: { sourceDigest: helper.sourceDigest.slice(7), executableSha256: helper.executable.sha256 }, profileDigest: 'd'.repeat(64) });
  const currentRef: NativeOutcomeRef = { ...current.ref, slot: 'outcome' };
  assert.deepEqual(await value.verifier.verifyOutcome(adopted, currentRef), { previousHistory: value.outcome });
  const wrongPast = value.publish({ ...previous.fact, issuer: current.fact.issuer, profileDigest: 'd'.repeat(64) });
  await assert.rejects(value.verifier.verifyOutcome(adopted, { ...wrongPast.ref, slot: 'outcome' }), { name: 'RecoveryJournalError' });
  value.receipts.set('outcome:1', previous);
  const wrongFuture = value.publish({ ...current.fact, issuer: previous.fact.issuer, profileDigest: PREVIOUS_RECOVERY_PROFILE.slice(7) });
  await assert.rejects(value.verifier.verifyOutcome(adopted, { ...wrongFuture.ref, slot: 'outcome' }), { name: 'RecoveryJournalError' });
});

test('second helper succession retains two closed issuer windows and refuses a receipt from either wrong window', async () => {
  const value = fixture(undefined, true, true); assert(value.outcome);
  const original = value.receipts.get('outcome:1'); assert(original?.kind === 'native' && original.fact.kind === 'outcome');
  const firstHelper = { ...helper, sourceDigest: FIRST_SUCCESSOR_SOURCE,
    executable: { path: '/prepared/first-successor', sha256: '8'.repeat(64) } };
  let closed = transitionRecovery(value.envelope, { kind: 'close_attempt', terminal: value.outcome });
  closed = transitionRecovery(closed, { kind: 'request_release' });
  let first = planHelperReplacement(closed, value.helper, firstHelper, FIRST_SUCCESSOR_PROFILE);
  first = transitionRecovery(first, { kind: 'refresh_transport', transport: first.transport });
  first = transitionRecovery(first, { kind: 'clear_release' });
  first = transitionRecovery(first, { kind: 'prepare_attempt' });
  const second = value.publish({ ...original.fact, attempt: 2, previous: null, lastCompleted: null,
    previousHistory: { kind: 'outcome', attempt: 1, sha256: value.outcome.digest.slice(7) },
    issuer: { sourceDigest: FIRST_SUCCESSOR_SOURCE.slice(7), executableSha256: firstHelper.executable.sha256 },
    profileDigest: FIRST_SUCCESSOR_PROFILE.slice(7) });
  const secondRef: NativeOutcomeRef = { ...second.ref, slot: 'outcome' };
  first = transitionRecovery(first, { kind: 'close_attempt', terminal: secondRef });
  first = transitionRecovery(first, { kind: 'request_release' });
  if (first.format !== 'agenai.docker-desktop-recovery.v2') assert.fail('Expected first succession v2.');
  const adopted = planHelperReplacement(first, firstHelper, helper, `sha256:${'d'.repeat(64)}`);
  if (adopted.format !== 'agenai.docker-desktop-recovery.v3') assert.fail('Expected second succession v3.');
  assert.deepEqual(adopted.previousIssuers.map((issuer) => issuer.throughAttempt), [1, 2]);
  assert.deepEqual(adopted.preparation, first.preparation);
  assert.deepEqual(adopted.historyHead, first.historyHead);
  assert.equal(recoveryEnvelopeV1Schema.safeParse(JSON.parse(encodeRecoveryEnvelope(adopted))).success, false);
  assert.equal(recoveryEnvelopeV2Schema.safeParse(JSON.parse(encodeRecoveryEnvelope(adopted))).success, false);
  assert.throws(() => planHelperReplacement({ ...first, activeProfileDigest: `sha256:${'9'.repeat(64)}` }, firstHelper, helper, `sha256:${'d'.repeat(64)}`));
  const current = value.publish({ ...original.fact, attempt: 3, previous: null, lastCompleted: null,
    previousHistory: { kind: 'outcome', attempt: 2, sha256: secondRef.digest.slice(7) },
    issuer: { sourceDigest: helper.sourceDigest.slice(7), executableSha256: helper.executable.sha256 }, profileDigest: 'd'.repeat(64) });
  const epochs = [original, second, current];
  for (const receipt of epochs) {
    if (receipt.ref.scope !== 'attempt' || receipt.fact.kind !== 'outcome') assert.fail('Expected an issued outcome in each interval.');
    await value.verifier.verifyOutcome(adopted, { ...receipt.ref, slot: 'outcome' });
    for (const wrongIssuer of epochs.filter((candidate) => candidate !== receipt)) {
      const wrong = value.publish({ ...receipt.fact, issuer: wrongIssuer.fact.issuer, profileDigest: wrongIssuer.fact.profileDigest });
      await assert.rejects(value.verifier.verifyOutcome(adopted, { ...wrong.ref, slot: 'outcome' }), { name: 'RecoveryJournalError' });
      value.receipts.set(`outcome:${receipt.fact.attempt}`, receipt);
    }
  }
  for (const invalid of [
    { ...adopted, previousIssuers: [...adopted.previousIssuers].reverse() },
    { ...adopted, previousIssuers: [adopted.previousIssuers[0], { ...adopted.previousIssuers[1], throughAttempt: 1 }] },
    { ...adopted, previousIssuers: [adopted.previousIssuers[0], { ...adopted.previousIssuers[1], helper }] },
  ]) assert.throws(() => parseRecoveryEnvelope(JSON.stringify(invalid)));
});

test('historical native graph accepts the exact stopped/fresh chain and a later observer-only EOF outcome offline', async () => {
  for (const lateOutcome of [false, true]) {
    const value = fixture(undefined, lateOutcome);
    await value.verifier.verifyNativeBarrier(value.envelope, value.decision);
  }
});

test('stopped evidence may join an extra pinned lifecycle CLI but cannot change an armed root or admit a CLI as an original producer', async () => {
  const auxiliary: NativeCurrentAdmissionFacts['processes'][number] = { role: 'docker_cli', pid: 900, uid: 501, parentPid: 100,
    processGroup: 100, startSeconds: '900', startMicroseconds: '0', pidVersion: null,
    imageSha256: images.find((image) => image.role === 'docker_cli')?.sha256 ?? assert.fail('Missing pinned CLI image') };
  const extra = fixture((fact) => fact.kind === 'stopped' ? { ...fact, joined: [...fact.joined, auxiliary] } : fact);
  await extra.verifier.verifyNativeBarrier(extra.envelope, extra.decision);
  const replaced = fixture((fact) => fact.kind === 'stopped' ? { ...fact, joined: fact.joined.map((entry, index) => index === 0
    ? { ...entry, role: 'docker_cli', imageSha256: auxiliary.imageSha256 } : entry) } : fact);
  await assert.rejects(replaced.verifier.verifyNativeBarrier(replaced.envelope, replaced.decision), { name: 'RecoveryJournalError' });
  const original = fixture((fact) => fact.kind === 'admission' ? { ...fact, facts: { ...fact.facts, processes: [...fact.facts.processes, auxiliary] } } : fact);
  await assert.rejects(original.verifier.verifyNativeBarrier(original.envelope, original.decision), { name: 'RecoveryJournalError' });
});

test('outcome verification walks the exact native predecessor chain before exposing its history link', async () => {
  const valid = fixture(undefined, true);
  assert(valid.outcome);
  assert.deepEqual(await valid.verifier.verifyOutcome(valid.envelope, valid.outcome), { previousHistory: null });
  const broken = fixture((fact) => fact.kind === 'stopped' && fact.previous
    ? { ...fact, previous: { ...fact.previous, kind: 'admission' } } : fact, true);
  assert(broken.outcome);
  await assert.rejects(broken.verifier.verifyOutcome(broken.envelope, broken.outcome), { name: 'RecoveryJournalError' });
});

test('historical verification rejects semantic tampering beyond otherwise valid native frames', async () => {
  const cases: readonly Readonly<{ name: string; mutate(fact: NativeFact): NativeFact }>[] = [
    { name: 'predecessor replacement', mutate: (fact) => fact.kind === 'armed'
      ? { ...fact, previous: { kind: 'admission', attempt: 1, sha256: '0'.repeat(64) } } : fact },
    { name: 'cross-host interval', mutate: (fact) => fact.kind === 'stopped'
      ? { ...fact, hostBoot: '55555555-5555-4555-8555-555555555555' } : fact },
    { name: 'missing old producer', mutate: (fact) => fact.kind === 'stopped'
      ? { ...fact, joined: processFacts(102) } : fact },
    { name: 'surviving old producer', mutate: (fact) => fact.kind === 'finished'
      ? { ...fact, facts: { ...fact.facts, processes: processFacts(100), peer: { ...fact.facts.peer, pid: 100 } } } : fact },
    { name: 'disk replacement', mutate: (fact) => fact.kind === 'finished'
      ? { ...fact, facts: { ...fact.facts, store: { ...fact.facts.store, inode: '51' } } } : fact },
    { name: 'noncontinuous first span', mutate: (fact) => fact.kind === 'finished'
      ? { ...fact, spans: fact.spans.map((span) => ({ ...span, start: '43' })) } : fact },
    { name: 'deadline extension', mutate: (fact) => fact.kind === 'armed'
      ? { ...fact, deadlineContinuousNs: '602000000000' } : fact },
    { name: 'prepared canonical replacement', mutate: (fact) => fact.kind === 'admission'
      ? { ...fact, canonicalPayloadSha256: '0'.repeat(64) } : fact },
    { name: 'pre-finished contradictory outcome', mutate: (fact) => fact.kind === 'outcome'
      ? { ...fact, lastCompleted: null, previous: null } : fact },
  ];
  for (const row of cases) {
    const value = fixture(row.mutate, row.name === 'pre-finished contradictory outcome');
    await assert.rejects(value.verifier.verifyNativeBarrier(value.envelope, value.decision), { name: 'RecoveryJournalError' }, row.name);
  }
});
