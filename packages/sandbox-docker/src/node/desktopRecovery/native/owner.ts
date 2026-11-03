import { z } from 'zod/v4';
import { NativeAuthorityProcess } from '../../nativeAuthorityProcess.js';
import { openPreparedExecutable } from '../../preparedExecutable.js';
import type { PreparedExecutable } from '../../preparedExecutable.js';
import type { DockerDesktopRecoveryHelper } from '../contracts.js';
import type { RecoveryReceiptIssuer } from '../../../network/desktop/coordinator/administrativeRecovery/helperSuccession.js';
import { readDesktopRecoveryProfileDigest, readDesktopRecoverySourceDigest } from '../preparation.js';
import { immutable } from '../../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { coordinatorDigest } from '../../../network/desktop/coordinator/journal/schema.js';
import { attemptTerminalRefSchema, receiptRefSchema, receiptScope, sameReceipt } from '../../../network/desktop/coordinator/administrativeRecovery/receipts.js';
import type { AttemptTerminalRef, ReceiptRef, TypedReceiptScope } from '../../../network/desktop/coordinator/administrativeRecovery/receipts.js';
import { encodeSdkDecision, parseSdkDecision, sdkDecisionScope } from '../../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import type { SdkDecision } from '../../../network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { bareDigest, countedCommand, digestBytes, receiptFrame } from './framing.js';
import { nativeFactSchema, RECOVERY_NATIVE_LIMITS, recoveryNativeResponseSchema, wireDigest, wireUuid } from './schemas.js';
import type { NativeCurrentAdmissionFacts, NativeFact, RecoveryNativeLogBytes, RecoveryNativeOpened, RecoveryNativeResponse } from './schemas.js';

export class RecoveryNativeError extends Error {
  constructor(readonly reason: string, readonly claim: 'held' | 'lost', options?: ErrorOptions) {
    super(`Desktop recovery native authority failed: ${reason}.`, options);
    this.name = 'RecoveryNativeError';
  }
}

interface BoundGeneration {
  readonly authorityId: string;
  readonly generationId: string;
  readonly recoveryKey: string;
  readonly originFrameDigest: string;
  readonly originRawDigest: string;
}

export type ExistingGenerationBinding = Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'bound_existing'; recoveryKey: string; originFrameDigest: string; originRawDigest: string }>;
export type ValidatedRecoveryReceipt = Readonly<{ ref: ReceiptRef; text: string } & (
  | { kind: 'native'; fact: NativeFact }
  | { kind: 'sdk'; decision: SdkDecision }
  | { kind: 'archive' }
)>;

function scopeTokens(scope: TypedReceiptScope): string {
  if (scope.kind === 'member_terminal') return `${scope.kind} ${wireUuid.parse(scope.scope)}`;
  if (scope.kind === 'origin_archive' || scope.kind === 'terminal_archive'
    || scope.kind === 'final_inventory' || scope.kind === 'generation_terminal') {
    if (scope.scope !== 'generation') throw new TypeError('Recovery transaction scope must be generation.');
    return `${scope.kind} generation`;
  }
  return `${scope.kind} ${z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(scope.scope)}`;
}

/** The only recovery process that holds the original physical canonical claim. */
export class RecoveryNativeOwner {
  readonly opened: Promise<RecoveryNativeOpened>;
  private readonly process: NativeAuthorityProcess<RecoveryNativeResponse, RecoveryNativeError>;
  private binding: BoundGeneration | undefined;
  private attempt: number | undefined;

  constructor(path: string, private readonly engineKey: string, endpointPath: string,
    executable: PreparedExecutable, private readonly helper: DockerDesktopRecoveryHelper,
    private readonly profileDigest: string, onLoss: (error: RecoveryNativeError) => void) {
    wireDigest.parse(engineKey);
    if (!endpointPath.startsWith('/') || endpointPath === '/' || Buffer.byteLength(endpointPath) > 4096
      || !endpointPath.isWellFormed() || /\p{Cc}/u.test(endpointPath)
      || endpointPath.slice(1).split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new TypeError('Recovery native endpoint requires a canonical absolute Unix path.');
    }
    this.process = new NativeAuthorityProcess(path, ['--cleanup', engineKey, '--endpoint', endpointPath], executable, {
      maximumResponseBytes: 6 * RECOVERY_NATIVE_LIMITS.canonicalBytes + 1024,
      parse: (input) => recoveryNativeResponseSchema.parse(input), opened: (response) => response.kind === 'opened',
      closed: (response) => response.kind === 'closed',
      failure: (response) => response.kind === 'failure' ? new RecoveryNativeError(response.reason, response.claim) : undefined,
      error: (reason, claim, cause) => new RecoveryNativeError(reason, claim, cause === undefined ? undefined : { cause }),
      isFailure: (cause): cause is RecoveryNativeError => cause instanceof RecoveryNativeError,
    }, onLoss);
    this.opened = this.process.opened.then((response) => {
      if (response.kind !== 'opened') throw this.process.protocolFailure('opening_response');
      this.claim = immutable(response);
      return immutable(response);
    });
    void this.opened.catch(() => {});
  }

  get claimed(): boolean { return this.process.claimed; }
  get closeJoined(): boolean { return this.process.closeJoined; }

  async readCanonical() {
    const response = await this.process.request('READ\n');
    if (response.kind !== 'snapshot' || !response.text.isWellFormed()
      || Buffer.byteLength(response.text) > RECOVERY_NATIVE_LIMITS.canonicalBytes
      || digestBytes(Buffer.from(response.text)) !== response.digest) throw this.process.protocolFailure('snapshot_response');
    return immutable({ text: response.text, rawDigest: `sha256:${response.digest}`,
      stateIdentity: { device: response.stateDevice, inode: response.stateInode }, pendingTemp: response.pendingTemp });
  }

  async checkClaim(): Promise<void> {
    await this.process.verifyExecutable();
    const response = await this.process.request('CHECK\n');
    if (response.kind !== 'checked') throw this.process.protocolFailure('check_response');
    if (response.fenced) throw new RecoveryNativeError('storage_fenced', 'held');
  }

  async commitCanonical(expectedRawDigest: string, text: string): Promise<void> {
    if ((await this.readCanonical()).rawDigest !== `sha256:${bareDigest(expectedRawDigest)}`) {
      throw new RecoveryNativeError('canonical_changed', 'held');
    }
    const input = countedCommand('COMMIT', text, RECOVERY_NATIVE_LIMITS.canonicalBytes);
    const response = await this.process.request(input);
    if (response.kind !== 'committed' || response.digest !== digestBytes(Buffer.from(text))) {
      throw this.process.protocolFailure('commit_response');
    }
  }

  async discardUnpublishedCanonicalTemp(expectedRawDigest: string): Promise<void> {
    if ((await this.readCanonical()).rawDigest !== `sha256:${bareDigest(expectedRawDigest)}`) {
      throw new RecoveryNativeError('canonical_changed', 'held');
    }
    const response = await this.process.request('DISCARD_TEMP\n');
    if (response.kind !== 'discarded') throw this.process.protocolFailure('discard_response');
  }

  async bindOrigin(input: Readonly<{ authorityId: string; generationId: string; recoveryKey: string;
    originFrameDigest: string; expectedCanonicalPayloadDigest: string }>): Promise<ExistingGenerationBinding> {
    const authorityId = wireUuid.parse(input.authorityId); const generationId = wireUuid.parse(input.generationId);
    const response = await this.process.request(`BIND_ORIGIN ${authorityId} ${generationId} ${bareDigest(input.recoveryKey)} ${bareDigest(input.originFrameDigest)} ${bareDigest(input.expectedCanonicalPayloadDigest)}\n`);
    if (response.kind !== 'bound_existing' || response.recoveryKey !== bareDigest(input.recoveryKey)
      || response.originFrameDigest !== bareDigest(input.originFrameDigest)) throw this.process.protocolFailure('origin_binding_response');
    return this.captureBinding(authorityId, generationId, response);
  }

  async rebindExistingGeneration(authorityId: string, generationId: string, expectedCurrentRawDigest: string): Promise<ExistingGenerationBinding> {
    wireUuid.parse(authorityId); wireUuid.parse(generationId);
    const response = await this.process.request(`BIND_EXISTING ${authorityId} ${generationId} ${bareDigest(expectedCurrentRawDigest)}\n`);
    if (response.kind === 'absent') return Object.freeze(response);
    if (response.kind !== 'bound_existing') throw this.process.protocolFailure('existing_binding_response');
    return this.captureBinding(authorityId, generationId, response);
  }

  private captureBinding(authorityId: string, generationId: string,
    response: Extract<RecoveryNativeResponse, { kind: 'bound_existing' }>): ExistingGenerationBinding {
    const binding = immutable({ authorityId, generationId, recoveryKey: `sha256:${response.recoveryKey}`,
      originFrameDigest: `sha256:${response.originFrameDigest}`, originRawDigest: `sha256:${response.originRawDigest}` });
    if (this.binding !== undefined && JSON.stringify(this.binding) !== JSON.stringify(binding)) {
      throw this.process.protocolFailure('generation_binding_changed');
    }
    this.binding = binding;
    return Object.freeze({ kind: 'bound_existing', recoveryKey: binding.recoveryKey,
      originFrameDigest: binding.originFrameDigest, originRawDigest: binding.originRawDigest });
  }

  async bindAttempt(input: Readonly<{ attempt: number; expectedCanonicalPayloadDigest: string;
    previousHistory: AttemptTerminalRef | null }>): Promise<void> {
    const binding = this.requireBinding();
    const attempt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.attempt);
    const previous = input.previousHistory === null ? null : attemptTerminalRefSchema.parse(input.previousHistory);
    if (previous !== null) {
      if (previous.attempt >= attempt) {
        throw new TypeError('Recovery attempt history must refer to an earlier terminal attempt.');
      }
    }
    const history = previous === null ? `none 0 ${'0'.repeat(64)}`
      : `${previous.slot} ${previous.attempt} ${bareDigest(previous.digest)}`;
    const command = `BIND ${binding.authorityId} ${binding.generationId} ${bareDigest(binding.recoveryKey)} ${attempt} ${bareDigest(binding.originFrameDigest)} ${bareDigest(input.expectedCanonicalPayloadDigest)} ${history}\n`;
    if (Buffer.byteLength(command) > 512) throw new TypeError('Recovery attempt binding exceeds its command bound.');
    const response = await this.process.request(command);
    if (response.kind !== 'bound') throw this.process.protocolFailure('attempt_binding_response');
    this.attempt = attempt;
  }

  async observeAdmission(): Promise<NativeCurrentAdmissionFacts> {
    const response = await this.process.request('OBSERVE_ADMISSION\n');
    if (response.kind !== 'admission') throw this.process.protocolFailure('admission_response');
    return immutable(response.facts);
  }

  async observeCurrentPeer(): Promise<NativeCurrentAdmissionFacts> {
    const response = await this.process.request('OBSERVE_CURRENT_PEER\n');
    if (response.kind !== 'current_peer') throw this.process.protocolFailure('peer_response');
    return immutable(response.facts);
  }

  beginObservation(): Promise<ValidatedRecoveryReceipt> { return this.stage('ARM', 'armed'); }
  observeStopped(): Promise<ValidatedRecoveryReceipt> { return this.stage('OBSERVE_STOPPED', 'stopped'); }
  finishFacts(): Promise<ValidatedRecoveryReceipt> { return this.stage('FINISH_FACTS', 'finished'); }
  async abandonObservation(): Promise<ValidatedRecoveryReceipt> {
    if (this.attempt === undefined) throw new TypeError('Recovery observation requires a bound positive attempt.');
    const response = await this.process.request('ABANDON\n');
    return this.validateReceipt(response, { kind: response.kind === 'receipt' && response.recordKind === 'barrier_acceptance'
      ? 'barrier_acceptance' : 'outcome', scope: this.attempt });
  }

  private async stage(command: string, slot: 'armed' | 'stopped' | 'finished' | 'outcome'): Promise<ValidatedRecoveryReceipt> {
    if (this.attempt === undefined) throw new TypeError('Recovery observation requires a bound positive attempt.');
    const response = await this.process.request(`${command}\n`);
    return this.validateReceipt(response, { kind: slot, scope: this.attempt });
  }

  async readObservedBytes(source: 'init' | 'console'): Promise<Readonly<RecoveryNativeLogBytes & { bytes: Uint8Array }>> {
    z.enum(['init', 'console']).parse(source);
    const response = await this.process.request(`READ_LOG ${source}\n`);
    if (response.kind !== 'log_bytes' || response.source !== source) throw this.process.protocolFailure('log_response');
    const bytes = Buffer.from(response.bytesBase64, 'base64');
    if (bytes.length > RECOVERY_NATIVE_LIMITS.chunkBytes || bytes.toString('base64') !== response.bytesBase64
      || BigInt(response.end) - BigInt(response.start) !== BigInt(bytes.length)
      || digestBytes(bytes) !== response.sha256) throw this.process.protocolFailure('log_bytes');
    return Object.freeze({ ...response, bytes });
  }

  async readMetadata(source: 'components' | 'settings'): Promise<Readonly<{ source: 'components' | 'settings'; sha256: string; bytes: Uint8Array }>> {
    z.enum(['components', 'settings']).parse(source);
    const response = await this.process.request(`READ_METADATA ${source}\n`);
    if (response.kind !== 'metadata_bytes' || response.source !== source) throw this.process.protocolFailure('metadata_response');
    const bytes = Buffer.from(response.bytesBase64, 'base64');
    if (bytes.length !== response.bytes || bytes.toString('base64') !== response.bytesBase64
      || digestBytes(bytes) !== response.sha256) throw this.process.protocolFailure('metadata_bytes');
    return Object.freeze({ source, sha256: `sha256:${response.sha256}`, bytes });
  }

  async archiveCurrentCanonical(slot: 'origin_archive' | 'terminal_archive', expectedRawDigest: string): Promise<ValidatedRecoveryReceipt> {
    if ((await this.readCanonical()).rawDigest !== `sha256:${bareDigest(expectedRawDigest)}`) {
      throw new RecoveryNativeError('canonical_changed', 'held');
    }
    const response = await this.process.request(`ARCHIVE ${slot === 'origin_archive' ? 'origin' : 'terminal'}\n`);
    return this.validateReceipt(response, { kind: slot, scope: 'generation' });
  }

  get currentIssuer(): RecoveryReceiptIssuer { return { helper: this.helper, profileDigest: this.profileDigest }; }

  async readReceipt(scope: TypedReceiptScope, expected?: ReceiptRef, issuer = this.currentIssuer): Promise<ValidatedRecoveryReceipt | undefined> {
    const response = await this.process.request(`READ_RECEIPT ${scopeTokens(scope)}\n`);
    if (response.kind === 'absent') {
      if (expected !== undefined) throw new RecoveryNativeError('receipt_missing', 'held');
      return undefined;
    }
    const receipt = this.validateReceipt(response, scope, issuer);
    if (expected !== undefined && !sameReceipt(receipt.ref, receiptRefSchema.parse(expected))) {
      throw new RecoveryNativeError('receipt_substituted', 'held');
    }
    return receipt;
  }

  async publishSdkDecision(input: SdkDecision): Promise<ValidatedRecoveryReceipt> {
    const text = encodeSdkDecision(input);
    const decision = parseSdkDecision(text);
    const scope = sdkDecisionScope(decision);
    const response = await this.process.request(countedCommand(`SDK_DECISION ${scopeTokens(scope)}`, text,
      RECOVERY_NATIVE_LIMITS.frameBytes - RECOVERY_NATIVE_LIMITS.frameHeaderBytes));
    const receipt = this.validateReceipt(response, scope);
    if (receipt.kind !== 'sdk' || receipt.text !== text) throw this.process.protocolFailure('decision_publication_response');
    return receipt;
  }

  close(): Promise<void> { return this.process.close(); }

  private requireBinding(): BoundGeneration {
    if (this.binding === undefined) throw new TypeError('Recovery evidence requires an existing bound original generation.');
    return this.binding;
  }

  private validateReceipt(response: RecoveryNativeResponse, scope: TypedReceiptScope, issuer = this.currentIssuer): ValidatedRecoveryReceipt {
    const binding = this.requireBinding();
    if (response.kind !== 'receipt' || response.recordKind !== scope.kind || response.scope !== String(scope.scope)) {
      throw this.process.protocolFailure('receipt_response');
    }
    const frame = receiptFrame(response, this.engineKey, bareDigest(binding.recoveryKey));
    if (frame.length !== response.bytes || digestBytes(frame) !== response.digest) throw this.process.protocolFailure('receipt_digest');
    const fields = { slot: response.recordKind, digest: `sha256:${response.digest}`, bytes: response.bytes };
    const ref = receiptRefSchema.parse(scope.kind === 'member_terminal'
      ? { ...fields, scope: 'member', memberId: scope.scope }
      : scope.scope === 'generation' ? { ...fields, scope: 'transaction' }
        : { ...fields, scope: scope.kind === 'barrier_acceptance' ? 'decision' : 'attempt', attempt: scope.scope });
    if (response.recordKind === 'origin_archive' || response.recordKind === 'terminal_archive') {
      return immutable({ kind: 'archive', ref, text: response.text });
    }
    let body: unknown;
    try { body = JSON.parse(response.text); }
    catch (cause) { throw new RecoveryNativeError('receipt_json', 'held', { cause }); }
    if (ref.scope === 'attempt') {
      const fact = nativeFactSchema.parse(body);
      if (fact.kind !== scope.kind || fact.attempt !== scope.scope || fact.engineKey !== this.engineKey
        || fact.authorityId !== binding.authorityId || fact.generationId !== binding.generationId
        || fact.recoveryKey !== bareDigest(binding.recoveryKey) || fact.originFrameDigest !== bareDigest(binding.originFrameDigest)
        || fact.issuer.sourceDigest !== bareDigest(issuer.helper.sourceDigest) || fact.issuer.executableSha256 !== issuer.helper.executable.sha256
        || fact.profileDigest !== bareDigest(issuer.profileDigest) || JSON.stringify(fact.claim) !== JSON.stringify(this.claimFields())) {
        throw new RecoveryNativeError('receipt_binding', 'held');
      }
      return immutable({ kind: 'native', ref, text: response.text, fact });
    }
    const decision = parseSdkDecision(response.text);
    if (scopeTokens(sdkDecisionScope(decision)) !== scopeTokens(receiptScope(ref))) throw new RecoveryNativeError('decision_scope', 'held');
    if (decision.binding.authorityId !== binding.authorityId || decision.binding.generationId !== binding.generationId
      || decision.binding.engineKey !== `sha256:${this.engineKey}` || decision.binding.recoveryKey !== binding.recoveryKey
      || decision.binding.originFrameDigest !== binding.originFrameDigest || decision.binding.originRawDigest !== binding.originRawDigest
      || decision.binding.claimDigest !== coordinatorDigest('agenai.desktop-coordinator.claim.v1', JSON.stringify(this.claimFields()))) {
      throw new RecoveryNativeError('decision_binding', 'held');
    }
    return immutable({ kind: 'sdk', ref, text: response.text, decision });
  }

  private claim: RecoveryNativeOpened | undefined;
  private claimFields() {
    const claim = this.claim;
    if (claim === undefined) throw new TypeError('Recovery native claim has not opened.');
    return { rootDevice: claim.rootDevice, rootInode: claim.rootInode, lockDevice: claim.lockDevice, lockInode: claim.lockInode };
  }
}

export async function openRecoveryNativeOwner(options: Readonly<{ helper: DockerDesktopRecoveryHelper;
  engineKey: string; endpoint: string; onLoss: (error: RecoveryNativeError) => void }>): Promise<RecoveryNativeOwner> {
  const [sourceDigest, profileDigest] = await Promise.all([readDesktopRecoverySourceDigest(), readDesktopRecoveryProfileDigest()]);
  if (sourceDigest !== options.helper.sourceDigest) throw new RecoveryNativeError('source_digest', 'lost');
  const executable = await openPreparedExecutable(options.helper.executable);
  try {
    const owner = new RecoveryNativeOwner(options.helper.executable.path, options.engineKey,
      options.endpoint.startsWith('unix://') ? options.endpoint.slice(7) : options.endpoint,
      executable, options.helper, profileDigest, options.onLoss);
    return owner;
  } catch (error) {
    await executable.close().catch(() => {});
    throw error;
  }
}
