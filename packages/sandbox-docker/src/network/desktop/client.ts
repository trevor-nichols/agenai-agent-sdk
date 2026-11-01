// ------------------------------------------------------------------------------------------------
//                client.ts - Single-observation Desktop helper control and joined attachment ownership
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import type { DockerEngineAttachment } from '../../engine/client.js';
import { DockerFrameDecoder } from '../../process/framing.js';
import { DESKTOP_VM_CONTROLLER_PROTOCOL, parseDesktopVmObserverFrame } from './protocol.js';
import type { DesktopVmObserverConfiguration, DesktopVmObserverCommand } from './protocol.js';
import { parseDesktopVmObservation } from './observation/vm.js';
import type { DesktopVmObservation } from './observation/vm.js';
import type { DesktopObservationByteBudget } from './observation/budget.js';

export interface DesktopVmObserverClient {
  readonly ready: Promise<void>;
  readonly settled: Promise<void>;
  beginReadiness(): void;
  stopRenewal(): void;
  observe(signal?: AbortSignal, budget?: DesktopObservationByteBudget): Promise<DesktopVmObservation>;
  close(): Promise<DesktopVmObserverSettlement>;
}
export type DesktopVmObserverSettlement = Readonly<{ kind: 'confirmed_stop' }>
  | Readonly<{ kind: 'attachment_joined'; failure: SandboxOperationError }>;
interface PendingObservation {
  sequence: number | undefined;
  readonly result: ReturnType<typeof Promise.withResolvers<DesktopVmObservation>>;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly detach: () => void;
  readonly budget?: DesktopObservationByteBudget;
}
type QueuedCommand = Readonly<{ kind: 'heartbeat' | 'stop' }>
  | Readonly<{ kind: 'observe'; observation: PendingObservation }>;

export function createDesktopVmObserverClient(options: {
  readonly attachment: DockerEngineAttachment;
  readonly configuration: DesktopVmObserverConfiguration;
  readonly onFailure: (error: SandboxOperationError) => void;
}): DesktopVmObserverClient {
  const { attachment, configuration, onFailure } = options;
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  let enteredReady = false;
  let closing = false;
  let renewing = true;
  let closedReceipt = false;
  let failure: SandboxOperationError | undefined;
  let sequence = 0;
  let heartbeatSequence: number | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
  let pending: PendingObservation | undefined;
  let retiringObservationSequence: number | undefined;
  let writing: Promise<void> = Promise.resolve();
  let closeActual: Promise<DesktopVmObserverSettlement> | undefined;
  let readinessStarted = false;
  let readinessDeadline: ReturnType<typeof setTimeout> | undefined;
  const fail = (cause: unknown) => {
    if (failure) return;
    failure = cause instanceof SandboxOperationError ? cause : new SandboxOperationError('driver_failure', 'Desktop route observer control failed.', { cause });
    clearTimeout(readinessDeadline); clearTimeout(heartbeatTimer); clearTimeout(heartbeatDeadline);
    ready.reject(failure);
    if (pending) { clearTimeout(pending.timer); pending.detach(); pending.result.reject(failure); pending = undefined; }
    attachment.stream.destroy();
    if (!closing) onFailure(failure);
  };
  const nextSequence = () => {
    if (!Number.isSafeInteger(sequence + 1)) throw new SandboxOperationError('driver_failure', 'Desktop observer sequence is exhausted.');
    sequence += 1; return sequence;
  };
  const write = (queued: QueuedCommand) => {
    writing = writing.then(() => new Promise<void>((resolve, reject) => {
      if (queued.kind === 'heartbeat' && (!renewing || closing || failure)) { resolve(); return; }
      if (queued.kind === 'observe' && (closing || failure || pending !== queued.observation)) { resolve(); return; }
      if (attachment.stream.destroyed) { reject(new SandboxOperationError('driver_failure', 'Desktop observer attachment is closed.')); return; }
      const currentSequence = nextSequence();
      if (queued.kind === 'observe') queued.observation.sequence = currentSequence;
      else if (queued.kind === 'heartbeat') {
        heartbeatSequence = currentSequence;
        heartbeatDeadline = setTimeout(() => fail(new SandboxOperationError('deadline_exceeded', 'Desktop observer heartbeat acknowledgement expired.')), configuration.leaseTimeoutMs);
        heartbeatDeadline.unref();
      }
      const command: DesktopVmObserverCommand = { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: queued.kind, sequence: currentSequence };
      const deadline = setTimeout(() => {
        const error = new SandboxOperationError('deadline_exceeded', 'Desktop observer control write did not settle.');
        reject(error); fail(error);
      }, configuration.commandTimeoutMs);
      attachment.stream.write(`${JSON.stringify(command)}\n`, (error) => {
        clearTimeout(deadline);
        if (error) reject(error); else resolve();
      });
    }));
    void writing.catch(fail);
    return writing;
  };
  const heartbeat = () => {
    if (!renewing || closing || failure) return;
    void write({ kind: 'heartbeat' });
  };
  const decoder = new DockerFrameDecoder();
  let bytesPending = Buffer.alloc(0);
  const deliver = async (channel: 1 | 2, bytes: Uint8Array) => {
    if (failure) return;
    if (channel !== 1) throw new SandboxOperationError('driver_failure', 'Desktop observer emitted unexpected stderr.');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.byteLength : newline;
      if (bytesPending.length + end - offset + 1 > configuration.maxOutputBytes) throw new SandboxOperationError('output_limit', 'Desktop observation envelope exceeds its output bound.');
      bytesPending = Buffer.concat([bytesPending, bytes.subarray(offset, end)]);
      offset = newline < 0 ? bytes.byteLength : newline + 1;
      if (newline < 0) continue;
      const frameBytes = bytesPending.byteLength + 1;
      pending?.budget?.consume(frameBytes);
      const frame = parseDesktopVmObserverFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytesPending)));
      bytesPending = Buffer.alloc(0);
      if (closedReceipt) throw new SandboxOperationError('driver_failure', 'Desktop observer sent output after close.');
      if (frame.kind === 'ready') {
        if (enteredReady) throw new SandboxOperationError('driver_failure', 'Desktop observer repeated readiness.');
        enteredReady = true; clearTimeout(readinessDeadline);
        if (!closing) { ready.resolve(); if (readinessStarted) heartbeat(); }
      } else if (!enteredReady) throw new SandboxOperationError('driver_failure', 'Desktop observer responded before readiness.');
      else if (frame.kind === 'heartbeat') {
        if (heartbeatSequence === undefined || frame.sequence !== heartbeatSequence) throw new SandboxOperationError('driver_failure', 'Desktop observer acknowledged an unexpected heartbeat.');
        heartbeatSequence = undefined; clearTimeout(heartbeatDeadline);
        if (renewing && !closing) { heartbeatTimer = setTimeout(heartbeat, configuration.heartbeatMs); heartbeatTimer.unref(); }
      } else if (frame.kind === 'observation') {
        if (closing && frame.sequence === retiringObservationSequence) {
          parseDesktopVmObservation(frame.document);
          retiringObservationSequence = undefined;
          continue;
        }
        if (!pending || pending.sequence !== frame.sequence || closing) throw new SandboxOperationError('driver_failure', 'Desktop observer returned an uncorrelated observation.');
        const observation = parseDesktopVmObservation(frame.document);
        const entered = pending; pending = undefined; clearTimeout(entered.timer); entered.detach(); entered.result.resolve(observation);
      } else {
        if (!closing || frame.reason !== 'stop') throw new SandboxOperationError('driver_failure', `Desktop observer retired its authority (${frame.reason}).`);
        closedReceipt = true;
      }
    }
  };
  const pumping = (async () => {
    if (attachment.head.byteLength > 65536 || attachment.stream.readableHighWaterMark > 65536) throw new SandboxOperationError('output_limit', 'Desktop observer receive ownership exceeds its bound.');
    await decoder.accept(attachment.head, deliver);
    for await (const bytes of attachment.stream) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65536) throw new SandboxOperationError('output_limit', 'Desktop observer returned invalid or oversized bytes.');
      await decoder.accept(bytes, deliver);
    }
    decoder.finish();
    if (bytesPending.length || !closedReceipt) throw new SandboxOperationError('driver_failure', 'Desktop observer attachment closed without a complete joined-close receipt.');
  })().catch(fail);
  const settled = Promise.all([pumping, attachment.closed.catch(fail)]).then(async () => { await writing.catch(() => {}); });
  const close = () => {
    if (closeActual) return closeActual;
    closing = true;
    clearTimeout(readinessDeadline); clearTimeout(heartbeatTimer); clearTimeout(heartbeatDeadline);
    ready.reject(new SandboxOperationError('cancelled', 'Desktop observer control is closing.'));
    if (pending) {
      const entered = pending; pending = undefined; clearTimeout(entered.timer); entered.detach();
      retiringObservationSequence = entered.sequence;
      void settled.then(() => entered.result.reject(failure ?? new SandboxOperationError('cancelled', 'Desktop observation was stopped.')));
    }
    if (!attachment.stream.destroyed) {
      void write({ kind: 'stop' });
    }
    const deadline = setTimeout(() => fail(new SandboxOperationError('deadline_exceeded', 'Desktop observer close did not settle.')), configuration.commandTimeoutMs);
    closeActual = settled.then((): DesktopVmObserverSettlement => {
      if (closedReceipt && !failure) return Object.freeze({ kind: 'confirmed_stop' });
      return Object.freeze({ kind: 'attachment_joined', failure: failure
        ?? new SandboxOperationError('driver_failure', 'Desktop observer native close remains unconfirmed.') });
    }).finally(() => clearTimeout(deadline));
    return closeActual;
  };
  return Object.freeze({ ready: ready.promise, settled, close,
    beginReadiness() {
      if (failure) throw failure;
      if (closing) throw new SandboxOperationError('cancelled', 'Desktop observer control is closing.');
      if (readinessStarted) return;
      readinessStarted = true;
      if (enteredReady) heartbeat();
      else {
        readinessDeadline = setTimeout(() => fail(new SandboxOperationError('deadline_exceeded', 'Desktop observer readiness expired.')), configuration.commandTimeoutMs);
        readinessDeadline.unref();
      }
    },
    stopRenewal() { renewing = false; clearTimeout(heartbeatTimer); }, async observe(signal?: AbortSignal, budget?: DesktopObservationByteBudget) {
    signal?.throwIfAborted();
    await ready.promise;
    if (!renewing || closing || failure) throw failure ?? new SandboxStateError('Desktop observer admission is closed.');
    if (pending) throw new SandboxStateError('A Desktop observation is already entered.');
    const result = Promise.withResolvers<DesktopVmObservation>();
    void result.promise.catch(() => {});
    const abort = () => { void close().catch(() => {}); };
    const timer = setTimeout(() => {
      fail(new SandboxOperationError('deadline_exceeded', 'Desktop VM observation exceeded its command deadline.'));
    }, configuration.commandTimeoutMs);
    const entered: PendingObservation = { sequence: undefined, result, timer, budget, detach: () => signal?.removeEventListener('abort', abort) };
    pending = entered;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else void write({ kind: 'observe', observation: entered });
    try { return await result.promise; }
    catch (cause) { await settled; throw cause; }
  } });
}
