import { encodeCoordinatorSnapshot, parseCoordinatorSnapshot } from '../journal/schema.js';
import type { CoordinatorSnapshot } from '../journal/schema.js';
import { encodeRecoveryEnvelope, isRecoveryEnvelope, isRecoveryEnvelopeFormat, parseRecoveryEnvelope, recoveryEnvelopeDigest, recoveryPredecessorFormat } from './schema.js';
import type { RecoveryEnvelope } from './schema.js';
import { jsonValue, rawDigest, RecoveryJournalError } from './scalars.js';
import { planCleanHandback, planHelperReplacement } from './plans.js';
import { activeRecoveryHelper } from './helperSuccession.js';

export type RecoveryCanonicalState = RecoveryEnvelope | CoordinatorSnapshot;
export interface RecoveryCanonicalObservation { readonly text: string; readonly pendingTemp: boolean }
export interface RecoveryCanonicalPort {
  readCanonical(): Promise<RecoveryCanonicalObservation>;
  commitCanonical(expectedRawDigest: string, text: string): Promise<unknown>;
  discardUnpublishedTemp(expectedRawDigest: string): Promise<void>;
}
export function parseRecoveryCanonical(text: string): RecoveryCanonicalState {
  const value = jsonValue(text);
  if (value && typeof value === 'object' && 'format' in value && isRecoveryEnvelopeFormat(value.format)) return parseRecoveryEnvelope(text);
  return parseCoordinatorSnapshot(text);
}
export function encodeRecoveryCanonical(state: RecoveryCanonicalState): string {
  return isRecoveryEnvelope(state) ? encodeRecoveryEnvelope(state) : encodeCoordinatorSnapshot(state);
}

/** Retains each actual publication and its exact accepted/proposed bytes through failure. */
export class RecoveryPublicationOwner {
  private acceptedText: string;
  private accepted: RecoveryCanonicalState;
  private proposedText: string | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly port: RecoveryCanonicalPort, currentText: string) {
    this.acceptedText = currentText;
    this.accepted = parseRecoveryCanonical(currentText);
  }
  get current(): RecoveryCanonicalState { return this.accepted; }
  get text(): string { return this.acceptedText; }
  get digest(): string { return rawDigest(this.acceptedText); }
  get pending(): boolean { return this.proposedText !== undefined; }

  publish(next: RecoveryCanonicalState): Promise<void> {
    const text = encodeRecoveryCanonical(next);
    return this.run(async () => {
      if (this.proposedText !== undefined) await this.reconcileActual();
      if (text === this.acceptedText) return;
      this.assertSuccessor(next, text);
      this.proposedText = text;
      try {
        await this.port.commitCanonical(this.digest, text);
        this.accept(text); this.proposedText = undefined;
      } catch (cause) {
        try { this.observe(await this.port.readCanonical()); }
        catch (readCause) { throw new AggregateError([cause, readCause], 'Recovery publication and its canonical readback did not both settle.'); }
        throw new RecoveryJournalError('publication', 'Recovery publication retains its exact original proposal.', { cause });
      }
    });
  }
  reconcile(): Promise<void> { return this.run(() => this.reconcileActual()); }
  async settle(): Promise<void> {
    await this.tail;
    if (this.proposedText !== undefined) throw new RecoveryJournalError('publication', 'Recovery still owns an unacknowledged canonical proposal.');
  }

  private run(perform: () => Promise<void>): Promise<void> {
    const actual = this.tail.then(perform);
    this.tail = actual.catch(() => {});
    return actual;
  }
  private accept(text: string): void { this.accepted = parseRecoveryCanonical(text); this.acceptedText = text; }
  private assertSuccessor(next: RecoveryCanonicalState, text: string): void {
    const current = this.accepted;
    if (!isRecoveryEnvelope(current)) {
      if (current.generation.kind === 'dirty' && next.format === 'agenai.docker-desktop-recovery.v1'
        && Buffer.from(next.origin.payloadBase64, 'base64').equals(Buffer.from(this.acceptedText))) return;
    } else if (isRecoveryEnvelope(next)) {
      if ((current.format === 'agenai.docker-desktop-recovery.v1' && next.format === 'agenai.docker-desktop-recovery.v2'
        || current.format === 'agenai.docker-desktop-recovery.v2' && next.format === 'agenai.docker-desktop-recovery.v3')
        && text === encodeRecoveryEnvelope(planHelperReplacement(current, activeRecoveryHelper(current), next.activeHelper, next.activeProfileDigest))) return;
      if (next.format === current.format && next.sequence === current.sequence + 1
        && next.predecessor.format === recoveryPredecessorFormat(current)
        && next.predecessor.digest === recoveryEnvelopeDigest(current)
        && JSON.stringify(next.origin) === JSON.stringify(current.origin)
        && JSON.stringify(next.preparation) === JSON.stringify(current.preparation)
        && (current.format !== 'agenai.docker-desktop-recovery.v2' || next.format === 'agenai.docker-desktop-recovery.v2'
          && JSON.stringify(next.activeHelper) === JSON.stringify(current.activeHelper) && next.activeProfileDigest === current.activeProfileDigest
          && JSON.stringify(next.previousIssuer) === JSON.stringify(current.previousIssuer))
        && (current.format !== 'agenai.docker-desktop-recovery.v3' || next.format === 'agenai.docker-desktop-recovery.v3'
          && JSON.stringify(next.activeHelper) === JSON.stringify(current.activeHelper) && next.activeProfileDigest === current.activeProfileDigest
          && JSON.stringify(next.previousIssuers) === JSON.stringify(current.previousIssuers))) return;
    } else if (current.phase.kind === 'terminal_ready' && text === encodeCoordinatorSnapshot(planCleanHandback(current))) return;
    throw new RecoveryJournalError('publication', 'Canonical publication does not continue the exact accepted original state.');
  }
  private observe(observed: RecoveryCanonicalObservation): void {
    if (observed.text !== this.acceptedText && observed.text !== this.proposedText) {
      throw new RecoveryJournalError('publication', 'Canonical recovery bytes match neither the original accepted state nor its proposal.');
    }
    this.accept(observed.text);
  }
  private async reconcileActual(): Promise<void> {
    const observed = await this.port.readCanonical();
    this.observe(observed);
    const expected = this.digest;
    if (observed.pendingTemp) await this.port.discardUnpublishedTemp(expected);
    // Exact readback alone does not acknowledge the failed directory synchronization.
    await this.port.commitCanonical(expected, this.acceptedText);
    this.proposedText = undefined;
  }
}
