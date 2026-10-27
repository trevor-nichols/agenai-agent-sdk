import type { Readable, Writable } from 'node:stream';
import { observeDesktopVmNetwork } from './native.js';
import { DESKTOP_VM_CONTROLLER_PROTOCOL, DESKTOP_VM_CONTROL_FRAME_BYTES, DESKTOP_VM_OBSERVATION_PROTOCOL,
  parseDesktopVmObserverCommand, type DesktopVmObserverCloseReason, type DesktopVmObserverConfiguration,
  type DesktopVmObserverFrame } from './protocol.js';

export async function runDesktopVmObserverControl(options: {
  readonly input: Readable;
  readonly output: Writable;
  readonly configuration: DesktopVmObserverConfiguration;
}): Promise<DesktopVmObserverCloseReason> {
  const { input, output, configuration } = options;
  const abort = new AbortController();
  const stopping = Promise.withResolvers<void>();
  let reason: DesktopVmObserverCloseReason | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSequence = 0;
  let observation: Promise<void> | undefined;
  let writing = Promise.resolve();
  const close = (cause: DesktopVmObserverCloseReason) => {
    if (reason !== undefined) return;
    reason = cause;
    clearTimeout(timer);
    abort.abort();
    input.destroy();
    stopping.resolve();
  };
  const renew = () => {
    clearTimeout(timer);
    timer = setTimeout(() => close('lease_expired'), configuration.leaseTimeoutMs);
  };
  const write = (frame: DesktopVmObserverFrame) => {
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (bytes.length > configuration.maxOutputBytes) return Promise.reject(new Error('Desktop observer envelope exceeded its output bound.'));
    writing = writing.then(() => new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        close('output_failure');
        output.destroy();
        reject(new Error('Desktop observer output did not settle.'));
      }, configuration.commandTimeoutMs);
      output.write(bytes, (error) => {
        clearTimeout(deadline);
        if (error) { close('output_failure'); reject(error); }
        else resolve();
      });
    }));
    return writing;
  };
  const outputFailed = () => close('output_failure');
  output.on('error', outputFailed);
  output.on('close', outputFailed);
  renew();
  const reading = (async () => {
    await write({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'ready', observationProtocol: DESKTOP_VM_OBSERVATION_PROTOCOL });
    let pending = Buffer.alloc(0);
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > 65536) throw new TypeError('Invalid Desktop control transport.');
      let offset = 0;
      while (offset < chunk.byteLength && reason === undefined) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.byteLength : newline;
        if (pending.length + end - offset > DESKTOP_VM_CONTROL_FRAME_BYTES) throw new TypeError('Desktop control frame exceeded its bound.');
        pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
        offset = newline < 0 ? chunk.byteLength : newline + 1;
        if (newline < 0) continue;
        const command = parseDesktopVmObserverCommand(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending)));
        pending = Buffer.alloc(0);
        if (command.sequence !== lastSequence + 1) throw new TypeError('Desktop observer sequence was replayed or skipped.');
        lastSequence = command.sequence;
        if (command.kind === 'stop') { close('stop'); return; }
        if (command.kind === 'heartbeat') {
          renew();
          await write({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'heartbeat', sequence: command.sequence });
        } else {
          if (observation) throw new TypeError('A Desktop observation is already entered.');
          observation = (async () => {
            const document = await observeDesktopVmNetwork(configuration, abort.signal);
            if (reason === undefined) await write({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observation', sequence: command.sequence, document });
          })().catch(() => { if (reason === undefined) close('observation_failure'); }).finally(() => { observation = undefined; });
        }
      }
    }
    if (reason === undefined) close(pending.length ? 'invalid_control' : 'control_eof');
  })().catch(() => { if (reason === undefined) close('invalid_control'); });
  await stopping.promise;
  await reading;
  // Native close is joined before the final receipt; cancellation never substitutes for settlement.
  await observation;
  await writing.catch(() => {});
  const selected = reason ?? 'control_eof';
  if (!output.destroyed) await write({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'closed', reason: selected }).catch(() => {});
  output.off('error', outputFailed);
  output.off('close', outputFailed);
  return selected;
}
