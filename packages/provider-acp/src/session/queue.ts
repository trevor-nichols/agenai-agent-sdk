import { AGENT_PROTOCOL_EVENT_BYTES_LIMIT } from '@agen-ai/agent-protocol';

import { AcpProviderSessionError } from './errors.js';

export interface QueueEntry<Value> {
  readonly value: Value;
  readonly bytes: number;
  readonly consumed: Promise<void>;
  readonly release: () => void;
}

export function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

export class SessionQueue<Value> {
  private readonly entries: QueueEntry<Value>[] = [];
  private readonly retained = new Map<QueueEntry<Value>, (error?: Error) => void>();
  private wake: (() => void) | undefined;
  private failure: Error | undefined;
  private bytes = 0;
  private outputBytes = 0;
  private stateCount = 0;

  constructor(private readonly limits: {
    readonly maxQueuedMessages: number;
    readonly maxQueuedBytes: number;
  }) {}

  admit(value: Value, bytes: number, control = false): QueueEntry<Value> {
    if (this.failure) throw this.failure;
    const messageLimit = this.limits.maxQueuedMessages - (control ? 1 : 2);
    const byteLimit = this.limits.maxQueuedBytes - AGENT_PROTOCOL_EVENT_BYTES_LIMIT * (control ? 1 : 2);
    if (this.retained.size + this.stateCount >= messageLimit || this.bytes + bytes > byteLimit) {
      throw new AcpProviderSessionError('acp_session_queue_full', 'The ACP session output budget is exhausted.');
    }
    const completion = deferred<void>();
    // Permission entries retain their reservation independently of notification acknowledgements.
    void completion.promise.catch(() => undefined);
    const entry: QueueEntry<Value> = {
      value,
      bytes,
      consumed: completion.promise,
      release: () => this.retained.get(entry)?.(),
    };
    this.bytes += bytes;
    this.retained.set(entry, (error) => {
      const queuedIndex = this.entries.indexOf(entry);
      if (queuedIndex >= 0) this.entries.splice(queuedIndex, 1);
      this.retained.delete(entry);
      this.bytes -= bytes;
      if (error) completion.reject(error);
      else completion.resolve();
    });
    this.entries.push(entry);
    this.wake?.();
    this.wake = undefined;
    return entry;
  }

  async take(shouldStop: () => boolean, canTake: (value: Value) => boolean = () => true): Promise<QueueEntry<Value> | undefined> {
    for (;;) {
      if (shouldStop()) return undefined;
      if (this.failure) throw this.failure;
      const index = this.entries.findIndex((entry) => canTake(entry.value));
      if (index >= 0) return this.entries.splice(index, 1)[0];
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  wakeReader(): void {
    this.wake?.();
    this.wake = undefined;
  }

  reserveOutput(value: unknown): () => void {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (this.outputBytes !== 0 || bytes > AGENT_PROTOCOL_EVENT_BYTES_LIMIT
      || this.bytes + bytes > this.limits.maxQueuedBytes) {
      throw new AcpProviderSessionError('acp_session_output_full', 'The ACP session mapped output budget is exhausted.');
    }
    this.outputBytes = bytes;
    return () => { this.outputBytes = 0; };
  }

  reserveState(value: unknown, extraBytes = 0): () => void {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8') + extraBytes;
    if (this.retained.size + this.stateCount >= this.limits.maxQueuedMessages - 2
      || this.bytes + bytes > this.limits.maxQueuedBytes - AGENT_PROTOCOL_EVENT_BYTES_LIMIT * 2) {
      throw new AcpProviderSessionError('acp_session_state_full', 'The ACP session item state budget is exhausted.');
    }
    this.stateCount += 1;
    this.bytes += bytes;
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      this.stateCount -= 1;
      this.bytes -= bytes;
    };
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.entries.length = 0;
    for (const finish of [...this.retained.values()]) finish(error);
    this.wake?.();
    this.wake = undefined;
  }
}
