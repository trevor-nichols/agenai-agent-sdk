// ------------------------------------------------------------------------------------------------
//                lineFramer.ts - Bounded newline-delimited ACP stdout framing
// ------------------------------------------------------------------------------------------------

import type { Readable } from 'node:stream';

import { AcpProtocolError } from './errors.js';

export interface AcpLineFramer {
  readonly dispose: () => void;
}

export interface CreateAcpLineFramerOptions {
  readonly readable: Readable;
  readonly maxFrameBytes: number;
  readonly onFrame: (frame: string) => void;
  readonly onFatal: (error: Error) => void;
  readonly onEnd: () => void;
}

export function createAcpLineFramer(options: CreateAcpLineFramerOptions): AcpLineFramer {
  let buffered = Buffer.alloc(0);
  let active = true;
  let ended = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  const fatal = (error: Error) => {
    if (!active) return;
    active = false;
    detach();
    options.onFatal(error);
  };

  const onData = (chunk: Buffer | Uint8Array | string) => {
    if (!active) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffered.byteLength + bytes.byteLength > options.maxFrameBytes && !bytes.includes(0x0a)) {
      fatal(new AcpProtocolError('acp_stdout_frame_too_large'));
      return;
    }
    buffered = buffered.byteLength === 0 ? Buffer.from(bytes) : Buffer.concat([buffered, bytes]);

    let newlineIndex = buffered.indexOf(0x0a);
    while (newlineIndex >= 0 && active) {
      let frame = buffered.subarray(0, newlineIndex);
      buffered = buffered.subarray(newlineIndex + 1);
      if (frame.byteLength > 0 && frame[frame.byteLength - 1] === 0x0d) {
        frame = frame.subarray(0, frame.byteLength - 1);
      }
      if (frame.byteLength === 0) {
        fatal(new AcpProtocolError('acp_stdout_empty_frame'));
        return;
      }
      if (frame.byteLength > options.maxFrameBytes) {
        fatal(new AcpProtocolError('acp_stdout_frame_too_large'));
        return;
      }
      try {
        options.onFrame(decoder.decode(frame));
      } catch {
        fatal(new AcpProtocolError('acp_stdout_utf8_invalid'));
        return;
      }
      if (buffered.byteLength > options.maxFrameBytes) {
        fatal(new AcpProtocolError('acp_stdout_frame_too_large'));
        return;
      }
      newlineIndex = buffered.indexOf(0x0a);
    }
  };

  const onError = () => fatal(new AcpProtocolError('acp_stdout_stream_error'));
  const onEnd = () => {
    if (!active || ended) return;
    ended = true;
    if (buffered.byteLength > 0) {
      fatal(new AcpProtocolError('acp_stdout_truncated_frame'));
      return;
    }
    active = false;
    detach();
    options.onEnd();
  };
  const onClose = () => onEnd();
  const detach = () => {
    options.readable.off('data', onData);
    options.readable.off('error', onError);
    options.readable.off('end', onEnd);
    options.readable.off('close', onClose);
  };

  options.readable.on('data', onData);
  options.readable.on('error', onError);
  options.readable.on('end', onEnd);
  options.readable.on('close', onClose);

  return Object.freeze({
    dispose: () => {
      if (!active) return;
      active = false;
      buffered = Buffer.alloc(0);
      detach();
    },
  });
}
