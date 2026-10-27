// ------------------------------------------------------------------------------------------------
//                control.ts - Controller-only stdio lease and once-only infrastructure shutdown
// ------------------------------------------------------------------------------------------------

import type { Readable, Writable } from 'node:stream';
import { CONTROL_FRAME_BYTES, EGRESS_PROTOCOL, parseControllerFrame } from './protocol.js';
import type { EgressCloseReason, EgressHelperFrame, EgressHelperRole } from './protocol.js';
import type { EgressService } from './broker.js';

function writeFrame(output: Writable, frame: EgressHelperFrame): Promise<void> {
  return new Promise<void>((resolve, reject) => output.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve()));
}

export async function runEgressControl(options: {
  readonly input: Readable;
  readonly output: Writable;
  readonly role: EgressHelperRole;
  readonly leaseTimeoutMs: number;
  readonly start: (signal: AbortSignal) => Promise<EgressService>;
}): Promise<EgressCloseReason> {
  const { input, output, role, leaseTimeoutMs } = options;
  const controller = new AbortController();
  const firstHeartbeat = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<EgressCloseReason>();
  let reason: EgressCloseReason | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let lastSequence = 0;
  const close = (next: EgressCloseReason) => {
    if (reason !== undefined) return;
    reason = next;
    clearTimeout(timer);
    controller.abort();
    input.destroy();
    firstHeartbeat.resolve();
    stopping.resolve(next);
  };
  const renew = () => {
    clearTimeout(timer);
    timer = setTimeout(() => close('lease_expired'), leaseTimeoutMs);
  };
  output.on('error', () => close('control_eof'));
  renew();
  const service = options.start(controller.signal);
  void service.then((started) => started.failed.catch(() => close('runtime_failure')), () => close('runtime_failure'));
  const reading = (async () => {
    let pending = Buffer.alloc(0);
    for await (const value of input) {
      if (!(value instanceof Uint8Array) || value.byteLength > 65536) throw new TypeError('Invalid control transport bytes.');
      let offset = 0;
      while (offset < value.byteLength && reason === undefined) {
        const delimiter = value.indexOf(10, offset);
        const end = delimiter < 0 ? value.byteLength : delimiter;
        if (pending.length + end - offset > CONTROL_FRAME_BYTES) throw new TypeError('Oversized control frame.');
        pending = Buffer.concat([pending, value.subarray(offset, end)]);
        offset = delimiter < 0 ? value.byteLength : delimiter + 1;
        if (delimiter < 0) continue;
        const frame = parseControllerFrame(JSON.parse(pending.toString('utf8')));
        pending = Buffer.alloc(0);
        if (frame.kind === 'stop') { close('stop'); return; }
        if (frame.sequence !== lastSequence + 1) throw new TypeError('Replayed or skipped heartbeat.');
        lastSequence = frame.sequence;
        renew();
        await writeFrame(output, { protocol: EGRESS_PROTOCOL, kind: 'heartbeat', sequence: frame.sequence });
        firstHeartbeat.resolve();
      }
    }
    if (reason === undefined) close(pending.length ? 'invalid_control' : 'control_eof');
  })().catch(() => { if (reason === undefined) close('invalid_control'); });
  try {
    await Promise.all([service, firstHeartbeat.promise]);
    if (reason === undefined) await writeFrame(output, { protocol: EGRESS_PROTOCOL, kind: 'ready', role });
    await stopping.promise;
  } catch { close('runtime_failure'); }
  const selected = await stopping.promise;
  await reading;
  const started = await service.catch(() => undefined);
  await started?.close();
  // A lost controller can also close stdout. Notification is best effort after service quiescence.
  if (!output.destroyed) await writeFrame(output, { protocol: EGRESS_PROTOCOL, kind: 'closed', reason: selected }).catch(() => {});
  return selected;
}
