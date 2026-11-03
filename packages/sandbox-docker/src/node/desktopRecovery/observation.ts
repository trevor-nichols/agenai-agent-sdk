import { transitionRecovery } from '../../network/desktop/coordinator/administrativeRecovery/plans.js';
import { RecoveryPublicationOwner } from '../../network/desktop/coordinator/administrativeRecovery/publication.js';
import type { RecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import { isRecoveryEnvelope } from '../../network/desktop/coordinator/administrativeRecovery/schema.js';
import { barrierDecisionRefSchema, nativeAttemptRefSchema, nativeOutcomeRefSchema } from '../../network/desktop/coordinator/administrativeRecovery/receipts.js';
import { barrierAcceptanceDecisionSchema, recoveryDecisionBinding } from '../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import type { BarrierAcceptanceDecision } from '../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { RecoveryJournalError } from '../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { RecoveryAuthority, sameTransport, transportAdmission } from './authority.js';
import { RecoveryEvidence } from './evidence.js';
import type { NativeFact } from './native/schemas.js';
import { baselineVmIdentity, RestorationClassifier } from './restoration/classifier.js';
import { RecoveryRestorationCollector } from './restoration/collect.js';
import { assertNoRunningRecoveryContainers } from './restoration/engine.js';
import type { RecoveryTransportObservation } from './restoration/transport.js';

interface EnteredObservation {
  readonly before: RecoveryTransportObservation;
  readonly previousVmId: string | undefined;
  readonly preparedRawDigest: string;
  armed?: Extract<NativeFact, { kind: 'armed' }>;
  classifier?: RestorationClassifier;
  collector?: RecoveryRestorationCollector;
  decision?: BarrierAcceptanceDecision;
}

export class RecoveryObservation {
  private entered: EnteredObservation | undefined;
  private initialization: 'required' | 'bound' | 'complete' = 'required';

  constructor(private readonly authority: RecoveryAuthority, private readonly evidence: RecoveryEvidence,
    private readonly publication: RecoveryPublicationOwner) {}

  private current(): RecoveryEnvelope {
    const current = this.publication.current;
    if (!isRecoveryEnvelope(current)) throw new RecoveryJournalError('transition', 'Observation requires an original recovery transaction.');
    return current;
  }

  async begin(): Promise<void> {
    if (this.entered && this.current().phase.kind === 'armed') return;
    if (!this.entered) {
      const before = await this.authority.capture();
      assertNoRunningRecoveryContainers(before.engine);
      if (this.current().phase.kind === 'attempt_prepared') {
        if (!sameTransport(this.current().transport, transportAdmission(before, this.current().sequence))) {
          throw new RecoveryJournalError('evidence', 'Prepared observation transport changed before its native arming.');
        }
      } else {
        await this.publication.publish(transitionRecovery(this.current(), { kind: 'refresh_transport',
          transport: transportAdmission(before, this.current().sequence) }));
        await this.publication.publish(transitionRecovery(this.current(), { kind: 'prepare_attempt' }));
      }
      const prepared = this.current();
      if (prepared.phase.kind !== 'attempt_prepared') throw new RecoveryJournalError('transition', 'Observation preparation did not retain its attempt.');
      await this.authority.native.bindAttempt({ attempt: prepared.phase.ordinal,
        expectedCanonicalPayloadDigest: this.publication.digest, previousHistory: prepared.historyHead });
      const baseline = await this.authority.native.readObservedBytes('init');
      this.entered = { before, previousVmId: baselineVmIdentity(baseline.bytes), preparedRawDigest: this.publication.digest };
    }
    const receipt = await this.authority.native.beginObservation();
    if (receipt.kind !== 'native' || receipt.fact.kind !== 'armed') throw new RecoveryJournalError('evidence', 'Arming requires the actual native receipt.');
    this.entered.armed = receipt.fact;
    this.entered.classifier ??= new RestorationClassifier(this.entered.previousVmId);
    await this.publication.publish(transitionRecovery(this.current(), { kind: 'armed',
      preparedRawDigest: this.entered.preparedRawDigest, armed: nativeAttemptRefSchema.parse(receipt.ref) }));
  }

  async stopped(): Promise<void> {
    if (!this.entered?.armed) throw new RecoveryJournalError('transition', 'The original in-process observation must still own its producer watches.');
    if (this.current().phase.kind === 'stopped') return;
    if (this.current().phase.kind !== 'armed') throw new RecoveryJournalError('transition', 'Stopped observation requires the exact armed attempt.');
    const stopped = await this.authority.native.observeStopped();
    await this.publication.publish(transitionRecovery(this.current(), { kind: 'stopped', stopped: nativeAttemptRefSchema.parse(stopped.ref) }));
  }

  async finish(): Promise<void> {
    const current = this.current();
    if (current.phase.kind === 'cleanup') return;
    if (current.phase.kind !== 'stopped') throw new RecoveryJournalError('transition', 'Restoration requires the exact stopped attempt.');
    const existing = await this.authority.native.readReceipt({ kind: 'barrier_acceptance', scope: current.phase.ordinal });
    if (existing) {
      if (existing.kind !== 'sdk' || existing.decision.kind !== 'barrier_acceptance') throw new RecoveryJournalError('evidence', 'Accepted observation slot contains a foreign decision.');
      await this.evidence.verifyNativeBarrier(current, existing.decision);
      await this.publication.publish(transitionRecovery(current, { kind: 'accept_barrier', decision: existing.decision,
        receipt: barrierDecisionRefSchema.parse(existing.ref) }));
      this.entered = undefined;
      return;
    }
    const entered = this.entered;
    if (!entered?.armed || !entered.classifier) throw new RecoveryJournalError('transition', 'Restoration lost its original observer and byte classifier.');
    if (!entered.decision) {
      entered.collector ??= new RecoveryRestorationCollector({ native: this.authority.native, api: this.authority.api,
        endpoint: this.authority.endpoint, expectedId: this.authority.daemonId, before: entered.before,
        armed: entered.armed, classifier: entered.classifier });
      const collected = await entered.collector.collect();
      const admission = await this.authority.native.readReceipt({ kind: 'admission', scope: current.phase.ordinal });
      if (!admission) throw new RecoveryJournalError('evidence', 'Restoration lacks its actual native admission.');
      const decision = barrierAcceptanceDecisionSchema.parse({ format: 'agenai.desktop-recovery.sdk-decision.v1',
        kind: 'barrier_acceptance', binding: recoveryDecisionBinding(current), attempt: current.phase.ordinal,
        previousHistory: current.historyHead, preparedRawDigest: current.phase.preparedRawDigest,
        native: { admission: admission.ref, armed: current.phase.armed, stopped: current.phase.stopped, finished: collected.finished.ref },
        transport: transportAdmission(collected.transport, current.sequence + 1), restoration: collected.restoration });
      await this.evidence.verifyNativeBarrier(current, decision);
      entered.decision = decision;
    }
    const decision = entered.decision;
    const published = await this.authority.native.publishSdkDecision(decision);
    await this.publication.publish(transitionRecovery(this.current(), { kind: 'accept_barrier', decision,
      receipt: barrierDecisionRefSchema.parse(published.ref) }));
    this.entered = undefined;
  }

  /** A fresh process can join a durable success, but cannot recreate missed watches. */
  async resumeInterrupted(): Promise<void> {
    if (this.initialization === 'complete') return;
    const current = this.current();
    if (!('ordinal' in current.phase) || current.phase.kind === 'attempt_closed') {
      this.initialization = 'complete'; return;
    }
    if (this.initialization === 'required') {
      await this.authority.native.bindAttempt({ attempt: current.phase.ordinal,
        expectedCanonicalPayloadDigest: this.publication.digest, previousHistory: current.historyHead });
      this.initialization = 'bound';
    }
    const accepted = await this.authority.native.readReceipt({ kind: 'barrier_acceptance', scope: current.phase.ordinal });
    if (accepted && current.phase.kind === 'stopped') { await this.finish(); this.initialization = 'complete'; return; }
    if (accepted) throw new RecoveryJournalError('evidence', 'A completed observation cannot precede its original stopped canonical checkpoint.');
    await this.abandon();
    this.initialization = 'complete';
  }

  async abandon(): Promise<void> {
    const current = this.current();
    if (!('ordinal' in current.phase) || current.phase.kind === 'attempt_closed') return;
    const receipt = await this.authority.native.abandonObservation();
    if (receipt.kind === 'sdk' && receipt.decision.kind === 'barrier_acceptance') {
      if (current.phase.kind !== 'stopped') throw new RecoveryJournalError('evidence', 'Completed acceptance has no matching stopped canonical checkpoint.');
      await this.evidence.verifyNativeBarrier(current, receipt.decision);
      await this.publication.publish(transitionRecovery(current, { kind: 'accept_barrier', decision: receipt.decision,
        receipt: barrierDecisionRefSchema.parse(receipt.ref) }));
    } else {
      const terminal = nativeOutcomeRefSchema.parse(receipt.ref);
      await this.evidence.verifyOutcome(current, terminal);
      await this.publication.publish(transitionRecovery(current, { kind: 'close_attempt', terminal }));
    }
    this.entered = undefined;
  }
}
