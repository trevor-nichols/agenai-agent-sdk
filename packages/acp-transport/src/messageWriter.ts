// ------------------------------------------------------------------------------------------------
//                messageWriter.ts - Serialized bounded ACP message output - Dependencies: streams
// ------------------------------------------------------------------------------------------------

import type { Writable } from 'node:stream';

import { AcpClientError } from './errors.js';
import type { AcpMessage } from './protocol.js';

export interface AcpMessageWriter {
  readonly write: (message: AcpMessage) => Promise<void>;
  readonly dispose: (drainMs: number) => Promise<void>;
}

export function createAcpMessageWriter(input: {
  readonly writable: Writable;
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
}): AcpMessageWriter {
  let disposed = false;
  let queuedBytes = 0;
  let queue: Promise<void> = Promise.resolve();
  const activeRejectors = new Set<(error: Error) => void>();

  const writeNow = (frame: Buffer): Promise<void> => new Promise((resolve, reject) => {
    if (disposed) {
      reject(new AcpClientError('acp_client_disposed', 'The ACP client is disposed.'));
      return;
    }
    let listenersAttached = true;
    let returnObserved = false;
    let writeCompleted = false;
    let drainRequired = false;
    let drainObserved = false;
    let settled = false;
    const cleanupListeners = () => {
      if (!listenersAttached) return;
      listenersAttached = false;
      input.writable.off('drain', onDrain);
      input.writable.off('error', onError);
      input.writable.off('close', onClose);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      activeRejectors.delete(rejectActive);
      if (error) reject(error);
      else resolve();
    };
    const complete = (error?: Error) => {
      cleanupListeners();
      settle(error);
    };
    const completeSuccessfulWrite = () => {
      if (!returnObserved || !writeCompleted || (drainRequired && !drainObserved)) return;
      complete();
    };
    const rejectActive = (error: Error) => {
      settle(error);
      input.writable.off('drain', onDrain);
      // Rejecting the caller does not settle an entered Node write. Its callback may still fail
      // and emit an error; retain observation until that write settles or the stream closes.
      if (writeCompleted) cleanupListeners();
    };
    const onDrain = () => {
      drainObserved = true;
      completeSuccessfulWrite();
    };
    const onError = () => complete(new AcpClientError(
      'acp_stdin_stream_error',
      'The ACP input stream failed.',
    ));
    const onClose = () => complete(new AcpClientError(
      'acp_stdin_stream_closed',
      'The ACP input stream closed.',
    ));
    activeRejectors.add(rejectActive);
    input.writable.once('drain', onDrain);
    input.writable.once('error', onError);
    input.writable.once('close', onClose);

    try {
      const admitted = input.writable.write(frame, (error) => {
        if (error) return;
        writeCompleted = true;
        if (disposed) cleanupListeners();
        else completeSuccessfulWrite();
      });
      drainRequired = !admitted;
      drainObserved = admitted;
      returnObserved = true;
      completeSuccessfulWrite();
    } catch {
      complete(new AcpClientError(
        'acp_stdin_write_failed',
        'The ACP input stream write failed.',
      ));
    }
  });

  const writer: AcpMessageWriter = {
    write: (message) => {
      if (disposed) {
        return Promise.reject(new AcpClientError(
          'acp_client_disposed',
          'The ACP client is disposed.',
        ));
      }
      const frame = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
      if (frame.byteLength - 1 > input.maxFrameBytes) {
        throw new AcpClientError(
          'acp_outbound_frame_too_large',
          'The ACP outbound frame exceeds the configured limit.',
        );
      }
      if (queuedBytes + frame.byteLength > input.maxBufferedBytes) {
        throw new AcpClientError(
          'acp_outbound_buffer_limit_exceeded',
          'The ACP outbound buffer is full.',
        );
      }

      queuedBytes += frame.byteLength;
      const operation = queue.then(() => writeNow(frame));
      queue = operation.then(
        () => { queuedBytes -= frame.byteLength; },
        () => { queuedBytes -= frame.byteLength; },
      );
      return operation;
    },
    dispose: async (drainMs) => {
      if (disposed) return;
      disposed = true;
      const error = new AcpClientError('acp_client_disposed', 'The ACP client is disposed.');
      for (const reject of activeRejectors) reject(error);
      activeRejectors.clear();
      if (drainMs <= 0) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        queue,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, drainMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    },
  };
  return Object.freeze(writer);
}
