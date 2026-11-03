import { setTimeout as delay } from 'node:timers/promises';
import type { DockerApi } from '../../../resources/api.js';
import { RecoveryNativeError } from '../native/owner.js';
import type { RecoveryNativeOwner, ValidatedRecoveryReceipt } from '../native/owner.js';
import type { RestorationEvidence } from '../../../network/desktop/coordinator/administrativeRecovery/restoration.js';
import type { NativeFact } from '../native/schemas.js';
import { RestorationClassifier } from './classifier.js';
import { recoveryNativeFactsDigest, RecoveryRestorationError } from './engine.js';
import { assertRecoveryRestoredTransport, captureRecoveryTransport } from './transport.js';
import type { RecoveryTransportObservation } from './transport.js';

export interface RecoveryRestorationCollection {
  readonly finished: ValidatedRecoveryReceipt;
  readonly transport: RecoveryTransportObservation;
  readonly restoration: RestorationEvidence;
}

interface RecoveryRestorationInput {
  native: RecoveryNativeOwner;
  api: DockerApi;
  endpoint: string;
  expectedId: string;
  before: RecoveryTransportObservation;
  armed: Extract<NativeFact, { kind: 'armed' }>;
  classifier: RestorationClassifier;
}

/** One observation retains its collector budget, classified bytes and completed result across retries. */
export class RecoveryRestorationCollector {
  private readonly deadline = performance.now() + 180_000;
  private readonly signal = AbortSignal.timeout(180_000);
  private completed: RecoveryRestorationCollection | undefined;

  constructor(private readonly input: Readonly<RecoveryRestorationInput>) {}

  async collect(): Promise<RecoveryRestorationCollection> {
    if (this.completed) return this.completed;
    const input = this.input;
    for (;;) {
      if (performance.now() >= this.deadline) throw new RecoveryRestorationError('restoration', 'Restoration collection exceeded its fixed three-minute interval.');
      if (input.classifier.complete) {
        let receipt: ValidatedRecoveryReceipt | undefined;
        try { receipt = await input.native.finishFacts(); }
        catch (cause) {
          if (!(cause instanceof RecoveryNativeError) || cause.claim !== 'held' || cause.reason !== 'unread_log_bytes') throw cause;
        }
        if (receipt) {
          if (receipt.kind !== 'native' || receipt.fact.kind !== 'finished') {
            throw new RecoveryRestorationError('restoration', 'Native observation did not return its exact finished fact.');
          }
          const transport = await captureRecoveryTransport(input.native, input.api, input.endpoint, input.expectedId, this.signal);
          const nativeDeadline = BigInt(input.armed.deadlineContinuousNs);
          if (performance.now() >= this.deadline || BigInt(transport.native.continuousNs) > nativeDeadline
            || BigInt(receipt.fact.finishedContinuousNs) > nativeDeadline) {
            throw new RecoveryRestorationError('restoration', 'Restoration completion exceeded the admitted native or SDK interval.');
          }
          assertRecoveryRestoredTransport(input.before, transport);
          if (recoveryNativeFactsDigest(receipt.fact.facts) !== transport.nativeFactsDigest) {
            throw new RecoveryRestorationError('composition', 'Native finished facts changed before the matching Docker restoration GETs.');
          }
          const restoration = input.classifier.finish(receipt.fact, transport.engine, input.armed);
          this.completed = Object.freeze({ finished: receipt, transport, restoration });
          return this.completed;
        }
      }
      let received = false;
      for (const source of ['init', 'console'] as const) {
        const chunk = await input.native.readObservedBytes(source);
        if (chunk.bytes.length !== 0) { input.classifier.consume(chunk); received = true; }
      }
      if (!received) await delay(100, undefined, { signal: this.signal });
    }
  }
}
