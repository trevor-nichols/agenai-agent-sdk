// ------------------------------------------------------------------------------------------------
//                controller.ts - Exact helper readiness, heartbeat and joined Docker stdio ownership
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';
import type { DockerEngineAttachment } from '../engine/client.js';
import { DockerFrameDecoder } from '../process/framing.js';
import { CONTROL_FRAME_BYTES, EGRESS_PROTOCOL, parseHelperFrame } from '../helpers/protocol.js';
import type { EgressControllerFrame, EgressHelperRole } from '../helpers/protocol.js';

export interface EgressHelperController {
  readonly ready: Promise<void>;
  readonly settled: Promise<void>;
  close(): Promise<void>;
}

export function createEgressHelperController(options: {
  readonly attachment: DockerEngineAttachment;
  readonly role: EgressHelperRole;
  readonly heartbeatMs: number;
  readonly leaseTimeoutMs: number;
  readonly onFailure: (error: SandboxOperationError) => void;
}): EgressHelperController {
  const { attachment, role, heartbeatMs, leaseTimeoutMs, onFailure } = options;
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  let closing = false;
  let failed = false;
  let enteredReady = false;
  let sequence = 0;
  let expectedReply = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let replyTimer: ReturnType<typeof setTimeout> | undefined;
  let writeTail = Promise.resolve();
  let closeActual: Promise<void> | undefined;
  const clearTimers = () => { clearTimeout(heartbeatTimer); clearTimeout(replyTimer); clearTimeout(readinessTimer); };
  const fail = (cause: unknown) => {
    if (closing || failed) return;
    failed = true;
    clearTimers();
    const error = cause instanceof SandboxOperationError ? cause : new SandboxOperationError('driver_failure', 'Egress helper control failed.', { cause });
    ready.reject(error);
    attachment.stream.destroy();
    onFailure(error);
  };
  const write = (frame: EgressControllerFrame) => {
    writeTail = writeTail.then(() => new Promise<void>((resolve, reject) => {
      if (attachment.stream.destroyed) { reject(new SandboxOperationError('driver_failure', 'Egress helper control is closed.')); return; }
      attachment.stream.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
    }));
    void writeTail.catch(fail);
  };
  const heartbeat = () => {
    if (closing || failed) return;
    if (!Number.isSafeInteger(sequence + 1)) { fail(new SandboxOperationError('driver_failure', 'Egress heartbeat sequence is exhausted.')); return; }
    sequence += 1;
    expectedReply = sequence;
    write({ protocol: EGRESS_PROTOCOL, kind: 'heartbeat', sequence });
    replyTimer = setTimeout(() => fail(new SandboxOperationError('deadline_exceeded', 'Egress helper heartbeat acknowledgement expired.')), leaseTimeoutMs);
    replyTimer.unref();
  };
  const readinessTimer = setTimeout(() => fail(new SandboxOperationError('deadline_exceeded', 'Egress helper readiness expired.')), leaseTimeoutMs);
  readinessTimer.unref();
  let pending = Buffer.alloc(0);
  const decoder = new DockerFrameDecoder();
  const deliver = async (channel: 1 | 2, bytes: Uint8Array) => {
    if (closing || failed) return;
    if (channel !== 1) throw new SandboxOperationError('driver_failure', 'Egress helper wrote unexpected stderr output.');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const delimiter = bytes.indexOf(10, offset);
      const end = delimiter < 0 ? bytes.byteLength : delimiter;
      if (pending.length + end - offset > CONTROL_FRAME_BYTES) throw new SandboxOperationError('output_limit', 'Egress helper control frame exceeds its bound.');
      pending = Buffer.concat([pending, bytes.subarray(offset, end)]);
      offset = delimiter < 0 ? bytes.byteLength : delimiter + 1;
      if (delimiter < 0) continue;
      const frame = parseHelperFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending)));
      pending = Buffer.alloc(0);
      if (frame.kind === 'ready') {
        if (frame.role !== role || enteredReady) throw new SandboxOperationError('driver_failure', 'Egress helper readiness differs from the reserved role.');
        enteredReady = true;
        clearTimeout(readinessTimer);
        ready.resolve();
      } else if (frame.kind === 'heartbeat') {
        if (frame.sequence !== expectedReply || expectedReply === 0) throw new SandboxOperationError('driver_failure', 'Egress helper acknowledged an unexpected heartbeat.');
        expectedReply = 0;
        clearTimeout(replyTimer);
        heartbeatTimer = setTimeout(heartbeat, heartbeatMs);
        heartbeatTimer.unref();
      } else throw new SandboxOperationError('driver_failure', `Egress helper closed its authority (${frame.reason}).`);
    }
  };
  const pumping = (async () => {
    if (attachment.head.byteLength > 65536 || attachment.stream.readableHighWaterMark > 65536) throw new SandboxOperationError('output_limit', 'Egress control exceeds its native receive bound.');
    await decoder.accept(attachment.head, deliver);
    for await (const bytes of attachment.stream) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65536) throw new SandboxOperationError('output_limit', 'Egress control returned invalid or oversized bytes.');
      await decoder.accept(bytes, deliver);
    }
    if (!closing && !failed) {
      decoder.finish();
      throw new SandboxOperationError('driver_failure', 'Egress helper control closed unexpectedly.');
    }
  })().catch(fail);
  const settled = Promise.all([pumping, attachment.closed.catch(fail)]).then(async () => { await writeTail.catch(() => {}); });
  heartbeat();
  return Object.freeze({ ready: ready.promise, settled, close() {
    if (closeActual) return closeActual;
    closing = true;
    clearTimers();
    ready.reject(new SandboxOperationError('cancelled', 'Egress helper control is closing.'));
    if (!attachment.stream.destroyed) write({ protocol: EGRESS_PROTOCOL, kind: 'stop' });
    const timeout = setTimeout(() => attachment.stream.destroy(), leaseTimeoutMs);
    closeActual = settled.finally(() => clearTimeout(timeout));
    return closeActual;
  } });
}
