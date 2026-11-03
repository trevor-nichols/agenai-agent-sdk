import type { RecoveryEvidencePorts } from '../../network/desktop/coordinator/administrativeRecovery/evidence.js';
import type { RecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import { encodeRecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import type { AttemptTerminalRef, NativeAttemptRef, NativeOutcomeRef, ReceiptRef, TypedReceiptScope } from '../../network/desktop/coordinator/administrativeRecovery/receipts.js';
import { receiptScope } from '../../network/desktop/coordinator/administrativeRecovery/receipts.js';
import type { BarrierAcceptanceDecision, SdkDecision } from '../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { assertDecisionBinding } from '../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { rawDigest, RecoveryJournalError } from '../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { restorationSpanSchema } from '../../network/desktop/coordinator/administrativeRecovery/restoration.js';
import type { RecoveryNativeOwner, ValidatedRecoveryReceipt } from './native/owner.js';
import type { NativeFact, NativeCurrentAdmissionFacts } from './native/schemas.js';
import { digestBytes } from './native/framing.js';
import { recoveryNativeFactsDigest, recoveryStoreIdentityDigest } from './restoration/engine.js';
import { recoveryReceiptIssuer } from '../../network/desktop/coordinator/administrativeRecovery/helperSuccession.js';

type NativeReceipt = Extract<ValidatedRecoveryReceipt, { kind: 'native' }>;
type Stage = 'admission' | 'armed' | 'stopped' | 'finished';
type NativeProcess = NativeCurrentAdmissionFacts['processes'][number];
const stages: readonly Stage[] = ['admission', 'armed', 'stopped', 'finished'];
const attemptNs = 600_000_000_000n;

function invalid(message: string): never { throw new RecoveryJournalError('evidence', message); }
function bare(digest: string): string { return digest.slice('sha256:'.length); }
function lifetime(process: NativeProcess): string {
  return JSON.stringify([process.pid, process.uid, process.startSeconds, process.startMicroseconds]);
}
function processIdentity(process: NativeProcess): string {
  return JSON.stringify([lifetime(process), process.role, process.imageSha256]);
}
function processSet(processes: readonly NativeProcess[]): Set<string> {
  const set = new Set(processes.map(processIdentity));
  if (set.size !== processes.length || new Set(processes.map((process) => process.pid)).size !== processes.length) {
    return invalid('Native producer census duplicates a process lifetime or PID.');
  }
  return set;
}
function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
function nativeHistoryMatches(fact: NativeFact, previous: AttemptTerminalRef | null): boolean {
  return fact.previousHistory.kind === 'none' ? previous === null : previous !== null
    && fact.previousHistory.kind === previous.slot && fact.previousHistory.attempt === previous.attempt
    && fact.previousHistory.sha256 === bare(previous.digest);
}
function linkMatches(link: NativeFact['previous'], ref: NativeAttemptRef): boolean {
  return link !== null && link.kind === ref.slot && link.attempt === ref.attempt && link.sha256 === bare(ref.digest);
}
function bindNative(envelope: RecoveryEnvelope, fact: NativeFact, attempt: number, currentProfileDigest: string): void {
  const issuer = recoveryReceiptIssuer(envelope, attempt, currentProfileDigest);
  if (fact.attempt !== attempt || fact.engineKey !== bare(envelope.engineKey) || fact.authorityId !== envelope.authorityId
    || fact.generationId !== envelope.origin.generationId || fact.recoveryKey !== bare(envelope.recoveryKey)
    || fact.originFrameDigest !== bare(envelope.origin.framedDigest)
    || JSON.stringify(fact.claim) !== JSON.stringify(envelope.origin.claim)
    || fact.issuer.sourceDigest !== bare(issuer.helper.sourceDigest)
    || fact.issuer.executableSha256 !== issuer.helper.executable.sha256 || fact.profileDigest !== bare(issuer.profileDigest)) {
    invalid('Native evidence replaces its original generation, physical claim or prepared issuer.');
  }
  if (BigInt(fact.finishedContinuousNs) < BigInt(fact.startedContinuousNs)) invalid('Native observation interval runs backwards.');
}
function sameIssuer(first: NativeFact, next: NativeFact): void {
  if (first.hostBoot !== next.hostBoot || first.uid !== next.uid || first.profileDigest !== next.profileDigest
    || JSON.stringify(first.issuer) !== JSON.stringify(next.issuer)
    || first.startedContinuousNs !== next.startedContinuousNs
    || JSON.stringify(first.previousHistory) !== JSON.stringify(next.previousHistory)
    || BigInt(next.finishedContinuousNs) < BigInt(first.finishedContinuousNs)) {
    invalid('Native stages cross an issuer, host, history or monotonic interval boundary.');
  }
}
function currentFacts(fact: Extract<NativeFact, { kind: 'admission' | 'finished' }>): void {
  const facts = fact.facts;
  if (facts.hostBoot !== fact.hostBoot || facts.uid !== fact.uid || facts.profileDigest !== fact.profileDigest
    || BigInt(facts.continuousNs) < BigInt(fact.startedContinuousNs)
    || BigInt(facts.continuousNs) > BigInt(fact.finishedContinuousNs)) invalid('Native current facts lie outside their issued interval.');
  admittedProcesses(facts.processes, facts, 'current');
  if (!facts.processes.some((process) => process.role === 'virtualization')
    || !facts.processes.some((process) => process.role === 'backend' && process.pid === facts.peer.pid)
    || facts.peer.uid !== facts.uid) invalid('Native current peer is not an admitted backend beside its VM producer.');
}
function admittedProcesses(processes: readonly NativeProcess[], facts: NativeCurrentAdmissionFacts, phase: 'current' | 'joined'): void {
  processSet(processes);
  const images = new Map(facts.images.map((image) => [image.role, image]));
  if (images.size !== facts.images.length) invalid('Native image identities duplicate a role.');
  for (const process of processes) {
    if (process.uid !== facts.uid || images.get(process.role)?.sha256 !== process.imageSha256
      || phase === 'current' && (process.role === 'docker_cli' || process.role === 'desktop_cli') || process.role === 'vmnetd') {
      invalid('Native producer census contains an unadmitted image, account or lifecycle actor.');
    }
  }
}
function stableInstallation(before: NativeCurrentAdmissionFacts, after: NativeCurrentAdmissionFacts): void {
  const images = (facts: NativeCurrentAdmissionFacts) => [...facts.images].sort((left, right) => left.role.localeCompare(right.role));
  if (before.hostBoot !== after.hostBoot || before.uid !== after.uid || before.profileDigest !== after.profileDigest
    || JSON.stringify(images(before)) !== JSON.stringify(images(after))
    || JSON.stringify(before.store) !== JSON.stringify(after.store)
    || JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) {
    invalid('Native lifecycle changed the host, installed images, metadata or persistent store.');
  }
}

/** Historical verification reads only the already bound immutable store; it never contacts Docker. */
export class RecoveryEvidence implements RecoveryEvidencePorts {
  constructor(private readonly native: Pick<RecoveryNativeOwner, 'readReceipt'>, private readonly currentProfileDigest: string) {}

  async readSdkDecision(ref: ReceiptRef): Promise<SdkDecision> {
    const receipt = await this.native.readReceipt(receiptScope(ref), ref);
    if (receipt?.kind !== 'sdk') return invalid('An SDK decision reference does not identify a complete SDK receipt.');
    return receipt.decision;
  }

  async findSdkDecision(scope: TypedReceiptScope): Promise<Readonly<{ ref: ReceiptRef; decision: SdkDecision }> | undefined> {
    const receipt = await this.native.readReceipt(scope);
    if (receipt === undefined) return undefined;
    if (receipt.kind !== 'sdk') return invalid('Deterministic SDK decision discovery returned a foreign receipt kind.');
    return { ref: receipt.ref, decision: receipt.decision };
  }

  private async readNative(envelope: RecoveryEnvelope, ref: NativeAttemptRef): Promise<NativeReceipt> {
    const receipt = await this.native.readReceipt(receiptScope(ref), ref, recoveryReceiptIssuer(envelope, ref.attempt, this.currentProfileDigest));
    if (receipt?.kind !== 'native' || receipt.fact.kind !== ref.slot) return invalid('A native stage reference does not identify its exact completed stage.');
    return receipt;
  }

  private async resolveNativeLink(envelope: RecoveryEnvelope, link: NonNullable<NativeFact['previous']>): Promise<NativeReceipt> {
    const receipt = await this.native.readReceipt({ kind: link.kind, scope: link.attempt }, undefined, recoveryReceiptIssuer(envelope, link.attempt, this.currentProfileDigest));
    if (receipt?.kind !== 'native' || receipt.fact.kind !== link.kind || bare(receipt.ref.digest) !== link.sha256) {
      return invalid('A native predecessor is absent or differs from its exact issued digest.');
    }
    return receipt;
  }

  private async previousHistory(envelope: RecoveryEnvelope, fact: NativeFact): Promise<AttemptTerminalRef | null> {
    const history = fact.previousHistory;
    if (history.kind === 'none') return null;
    if (history.attempt >= fact.attempt) return invalid('Native attempt history does not decrease.');
    const receipt = await this.native.readReceipt({ kind: history.kind, scope: history.attempt }, undefined, recoveryReceiptIssuer(envelope, history.attempt, this.currentProfileDigest));
    if (!receipt || bare(receipt.ref.digest) !== history.sha256) return invalid('Native history omits its exact prior terminal receipt.');
    if (receipt.ref.scope === 'attempt' && receipt.ref.slot === 'outcome') return { ...receipt.ref, slot: 'outcome' };
    if (receipt.ref.scope === 'decision' && receipt.ref.slot === 'barrier_acceptance') return receipt.ref;
    return invalid('Native history points outside the closed terminal reference union.');
  }

  async verifyOutcome(envelope: RecoveryEnvelope, ref: NativeOutcomeRef): Promise<Readonly<{ previousHistory: AttemptTerminalRef | null }>> {
    const receipt = await this.readNative(envelope, ref); const fact = receipt.fact;
    if (fact.kind !== 'outcome') return invalid('Attempt outcome has a foreign native kind.');
    bindNative(envelope, fact, ref.attempt, this.currentProfileDigest);
    if (JSON.stringify(fact.previous) !== JSON.stringify(fact.lastCompleted) || fact.lastCompleted?.kind === 'outcome') {
      return invalid('Native outcome replaces or cycles its last completed stage.');
    }
    let prior = fact.lastCompleted;
    let expected = prior === null ? -1 : stages.findIndex((stage) => stage === prior?.kind);
    let later: NativeFact = fact;
    while (prior !== null) {
      const previous = await this.resolveNativeLink(envelope, prior);
      if (expected < 0 || previous.fact.kind !== stages[expected]) return invalid('Native outcome skips a required predecessor stage.');
      bindNative(envelope, previous.fact, ref.attempt, this.currentProfileDigest); sameIssuer(previous.fact, later);
      if (previous.fact.kind === 'admission' && previous.fact.previous !== null) return invalid('Native admission has a predecessor.');
      later = previous.fact; prior = previous.fact.previous; expected--;
    }
    if (expected !== -1) return invalid('Native outcome predecessor chain is incomplete.');
    return { previousHistory: await this.previousHistory(envelope, fact) };
  }

  async verifyNativeBarrier(envelope: RecoveryEnvelope, decision: BarrierAcceptanceDecision): Promise<void> {
    assertDecisionBinding(envelope, decision);
    const admissionReceipt = await this.readNative(envelope, decision.native.admission);
    const armedReceipt = await this.readNative(envelope, decision.native.armed);
    const stoppedReceipt = await this.readNative(envelope, decision.native.stopped);
    const finishedReceipt = await this.readNative(envelope, decision.native.finished);
    const admission = admissionReceipt.fact; const armed = armedReceipt.fact;
    const stopped = stoppedReceipt.fact; const finished = finishedReceipt.fact;
    if (admission.kind !== 'admission' || armed.kind !== 'armed' || stopped.kind !== 'stopped' || finished.kind !== 'finished') {
      return invalid('Accepted barrier does not contain the exact four native stages.');
    }
    for (const fact of [admission, armed, stopped, finished]) {
      bindNative(envelope, fact, decision.attempt, this.currentProfileDigest);
      if (!nativeHistoryMatches(fact, decision.previousHistory)) invalid('Native stage replaces the accepted decision history.');
    }
    if (admission.previous !== null || !linkMatches(armed.previous, decision.native.admission)
      || !linkMatches(stopped.previous, decision.native.armed) || !linkMatches(finished.previous, decision.native.stopped)) {
      invalid('Accepted barrier skips or replaces a native predecessor.');
    }
    sameIssuer(admission, armed); sameIssuer(armed, stopped); sameIssuer(stopped, finished);
    currentFacts(admission); currentFacts(finished); stableInstallation(admission.facts, finished.facts);
    const deadline = BigInt(armed.deadlineContinuousNs);
    if (deadline !== BigInt(armed.startedContinuousNs) + attemptNs || BigInt(finished.finishedContinuousNs) > deadline) {
      invalid('Native accepted observation exceeds its fixed continuous-time deadline.');
    }
    if (admission.canonicalPayloadSha256 !== bare(decision.preparedRawDigest)
      || armed.canonicalPayloadSha256 !== bare(decision.preparedRawDigest)
      || stopped.canonicalPayloadSha256 === armed.canonicalPayloadSha256
      || finished.canonicalPayloadSha256 === stopped.canonicalPayloadSha256
      || finished.canonicalPayloadSha256 === armed.canonicalPayloadSha256) {
      invalid('Native stages do not bind distinct prepared, armed and stopped canonical publications.');
    }
    if (envelope.phase.kind === 'stopped' && envelope.phase.ordinal === decision.attempt
      && finished.canonicalPayloadSha256 !== bare(rawDigest(encodeRecoveryEnvelope(envelope)))) {
      invalid('Finished native facts differ from the actual stopped canonical bytes.');
    }
    const armedSet = processSet(armed.producers); const joined = processSet(stopped.joined);
    admittedProcesses(stopped.joined, admission.facts, 'joined');
    if (!sameSet(processSet(admission.facts.processes), armedSet) || armed.watchCount !== armed.producers.length
      || [...armedSet].some((producer) => !joined.has(producer))) invalid('Stopped evidence omits an originally armed producer watch.');
    const old = new Set(stopped.joined.map(lifetime));
    if (finished.facts.processes.some((process) => old.has(lifetime(process)))) invalid('An old producer lifetime survives the stopped interval.');
    this.verifySpans(armed, finished, decision);
    if (decision.transport.nativeFactsDigest !== recoveryNativeFactsDigest(finished.facts)
      || decision.restoration.storeIdentityDigest !== recoveryStoreIdentityDigest(finished.facts)) {
      invalid('Accepted restoration does not bind the native finished composition and persistent store.');
    }
    const outcome = await this.native.readReceipt({ kind: 'outcome', scope: decision.attempt }, undefined, recoveryReceiptIssuer(envelope, decision.attempt, this.currentProfileDigest));
    if (outcome !== undefined) {
      if (outcome.kind !== 'native' || outcome.fact.kind !== 'outcome'
        || !linkMatches(outcome.fact.lastCompleted, decision.native.finished)
        || !linkMatches(outcome.fact.previous, decision.native.finished)) {
        invalid('Accepted restoration conflicts with a pre-finished native outcome.');
      }
      bindNative(envelope, outcome.fact, decision.attempt, this.currentProfileDigest); sameIssuer(finished, outcome.fact);
      if (!nativeHistoryMatches(outcome.fact, decision.previousHistory)) invalid('Later observer outcome replaces accepted history.');
    }
  }

  private verifySpans(armed: Extract<NativeFact, { kind: 'armed' }>, finished: Extract<NativeFact, { kind: 'finished' }>, decision: BarrierAcceptanceDecision): void {
    if (digestBytes(Buffer.from(JSON.stringify(finished.spans))) !== finished.spanManifestSha256) invalid('Native span manifest checksum differs from its exact spans.');
    const expected = finished.spans.map((span) => restorationSpanSchema.parse({ ...span, sha256: `sha256:${span.sha256}` }));
    if (JSON.stringify(expected) !== JSON.stringify(decision.restoration.spans)) invalid('SDK restoration differs from the native observed byte spans.');
    const sources = new Map<string, Readonly<{ source: 'init' | 'console'; end: bigint }>>();
    for (const source of armed.logSources) {
      if (sources.has(source.sourceIdentity)) invalid('Armed log sources duplicate a held file identity.');
      sources.set(source.sourceIdentity, { source: source.source, end: BigInt(source.initialOffset) });
    }
    if (!armed.logSources.some((source) => source.source === 'init') || !armed.logSources.some((source) => source.source === 'console')) invalid('Armed evidence omits a required log source family.');
    let sequence = 0;
    for (const span of finished.spans) {
      const prior = sources.get(span.sourceIdentity);
      if (span.sequence !== sequence + 1 || BigInt(span.end) <= BigInt(span.start)
        || BigInt(span.end) - BigInt(span.start) > 65_536n || BigInt(span.start) !== (prior?.end ?? 0n)
        || prior !== undefined && prior.source !== span.source) invalid('Native spans skip, replay or cross a held log source interval.');
      sources.set(span.sourceIdentity, { source: span.source, end: BigInt(span.end) }); sequence = span.sequence;
    }
  }
}
