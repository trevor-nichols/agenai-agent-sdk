import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { COORDINATOR_JOURNAL_LIMITS } from '../network/desktop/coordinator/journal/schema.js';
import type { PreparedExecutable } from './preparedExecutable.js';
import { NativeAuthorityProcess } from './nativeAuthorityProcess.js';

const physicalId = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const stateIdentity = { stateDevice: physicalId, stateInode: physicalId };
const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('opened'), initial: z.enum(['required', 'existing']),
    rootDevice: physicalId, rootInode: physicalId, lockDevice: physicalId, lockInode: physicalId,
    ...stateIdentity, pendingTemp: z.boolean() }),
  z.strictObject({ kind: z.literal('snapshot'), text: z.string(), digest, ...stateIdentity, pendingTemp: z.boolean() }),
  z.strictObject({ kind: z.literal('committed'), digest, ...stateIdentity }),
  z.strictObject({ kind: z.literal('checked'), fenced: z.boolean() }),
  z.strictObject({ kind: z.literal('cleanup') }),
  z.strictObject({ kind: z.literal('discarded') }),
  z.strictObject({ kind: z.literal('closed') }),
  z.strictObject({ kind: z.literal('failure'), reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    errno: z.number().int().min(0).max(65_535), claim: z.enum(['held', 'lost']) }),
]);
type HolderResponse = z.infer<typeof responseSchema>;
export type DesktopCoordinatorHolderIdentity = Extract<HolderResponse, { kind: 'opened' }>;
export type DesktopCoordinatorHolderSnapshot = Extract<HolderResponse, { kind: 'snapshot' }>;

export class DesktopCoordinatorHolderError extends Error {
  constructor(readonly reason: string, readonly claim: 'held' | 'lost', options?: ErrorOptions) {
    super(`Desktop coordinator native authority failed: ${reason}.`, options);
    this.name = 'DesktopCoordinatorHolderError';
  }
}

const MAX_PAYLOAD = COORDINATOR_JOURNAL_LIMITS.framedBytes - COORDINATOR_JOURNAL_LIMITS.nativeHeaderBytes;
const MAX_RESPONSE = 6 * MAX_PAYLOAD + 1_024;

/** One prepared process owns the stable claim and every entered storage command. */
export class DesktopCoordinatorHolder {
  readonly opened: Promise<DesktopCoordinatorHolderIdentity>;
  private readonly process: NativeAuthorityProcess<HolderResponse, DesktopCoordinatorHolderError>;

  constructor(path: string, mode: 'initialize' | 'open' | 'cleanup', engineKey: string,
    executable: PreparedExecutable, onLoss: (error: DesktopCoordinatorHolderError) => void) {
    this.process = new NativeAuthorityProcess(path, [mode, engineKey], executable, {
      maximumResponseBytes: MAX_RESPONSE,
      parse: (input) => responseSchema.parse(input),
      opened: (response) => response.kind === 'opened',
      closed: (response) => response.kind === 'closed',
      failure: (response) => response.kind === 'failure' ? new DesktopCoordinatorHolderError(response.reason, response.claim) : undefined,
      error: (reason, claim, cause) => new DesktopCoordinatorHolderError(reason, claim, cause === undefined ? undefined : { cause }),
      isFailure: (cause): cause is DesktopCoordinatorHolderError => cause instanceof DesktopCoordinatorHolderError,
    }, onLoss);
    this.opened = this.process.opened.then((response) => {
      if (response.kind !== 'opened') throw this.process.protocolFailure('opening_response');
      return Object.freeze(response);
    });
    void this.opened.catch(() => {});
  }

  get claimed(): boolean { return this.process.claimed; }

  async read(): Promise<DesktopCoordinatorHolderSnapshot> {
    const response = await this.process.request('READ\n');
    if (response.kind !== 'snapshot' || Buffer.byteLength(response.text) > MAX_PAYLOAD
      || createHash('sha256').update(response.text).digest('hex') !== response.digest) {
      throw this.process.protocolFailure('snapshot_response');
    }
    return Object.freeze(response);
  }

  async check(): Promise<void> {
    await this.process.verifyExecutable();
    const response = await this.process.request('CHECK\n');
    if (response.kind !== 'checked') throw this.process.protocolFailure('check_response');
    if (response.fenced) throw new DesktopCoordinatorHolderError('storage_fenced', 'held');
  }

  async commit(text: string): Promise<void> {
    const payload = Buffer.from(text, 'utf8');
    if (payload.length < 1 || payload.length > MAX_PAYLOAD || !text.isWellFormed()) {
      throw new TypeError('Coordinator snapshot exceeds its native framing contract.');
    }
    const input = Buffer.concat([Buffer.from(`COMMIT ${payload.length}\n`), payload, Buffer.from('\n')]);
    const response = await this.process.request(input);
    if (response.kind !== 'committed' || response.digest !== createHash('sha256').update(payload).digest('hex')) {
      throw this.process.protocolFailure('commit_response');
    }
  }

  async enterCleanup(): Promise<void> {
    const response = await this.process.request('CLEANUP\n');
    if (response.kind !== 'cleanup') throw this.process.protocolFailure('cleanup_response');
  }

  async discardUnpublishedTemp(): Promise<void> {
    const response = await this.process.request('DISCARD_TEMP\n');
    if (response.kind !== 'discarded') throw this.process.protocolFailure('discard_response');
  }

  close(): Promise<void> { return this.process.close(); }
}
