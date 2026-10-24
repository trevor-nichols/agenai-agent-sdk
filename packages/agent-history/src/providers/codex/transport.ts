import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { terminateProcessGroup, waitForGroupExit } from '../process/group.js';
import type { CodexHistoryConnection, CodexHistoryRequest, CodexHistoryRequestContext } from './contracts.js';

const FRAME_BYTES = 2 * 1024 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const INPUT_BYTES = 32 * 1024;
const MAX_FRAMES = 256;
const envelopeSchema = z.object({ id: z.number().int().positive().optional(), method: z.string().min(1).max(256).optional(),
  result: z.unknown().optional(), error: z.object({ code: z.number().int(), message: z.string().max(16_384) }).optional(),
});

interface PendingResponse {
  readonly id: number;
  readonly maximum: number;
  readonly resolve: (response: Uint8Array) => void;
  readonly reject: (error: AgentHistoryError) => void;
}

export class CodexStdioClient implements CodexHistoryConnection {
  readonly runtimeVersion = '0.163.0';
  private readonly frame = Buffer.allocUnsafe(FRAME_BYTES);
  private frameLength = 0;
  private outputBytes = 0;
  private frames = 0;
  private nextId = 0;
  private pending?: PendingResponse;
  private failure?: AgentHistoryError;
  private closed = false;
  private readonly exited: Promise<void>;
  private readonly wallTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => child.once('close', () => {
      if (this.pending) this.stop(new AgentHistoryError('native_failure', 'Codex history process exited before its response.'));
      resolve();
    }));
    child.on('error', () => this.stop(new AgentHistoryError('native_failure', 'Codex history process could not start.')));
    child.stdin.on('error', () => this.stop(new AgentHistoryError('native_failure', 'Codex history process input closed unexpectedly.')));
    child.once('exit', () => this.stop(this.closed ? undefined
      : new AgentHistoryError('native_failure', 'Codex history process exited before its operation completed.')));
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => this.consume(chunk, false));
    this.wallTimer = setTimeout(() => this.stop(new AgentHistoryError('deadline_exceeded', 'Codex history process exceeded its operation deadline.')), 30_000);
  }

  stop(error?: AgentHistoryError): void {
    this.failure ??= error;
    if (this.pending) {
      this.pending.reject(this.failure ?? new AgentHistoryError('closed', 'Codex history process is closing.'));
      this.pending = undefined;
    }
    if (this.child.pid !== undefined) {
      try { terminateProcessGroup(this.child.pid); }
      catch { this.failure = new AgentHistoryError('cleanup_failed', 'Codex history process group could not be stopped.'); }
    }
  }

  private consume(chunk: Buffer, stdout: boolean): void {
    if (this.failure) return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > TOTAL_BYTES) return this.stop(new AgentHistoryError('limit_exhausted', 'Codex history process exceeded its output budget.'));
    if (!stdout) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - offset;
      if (this.frameLength + length > FRAME_BYTES) return this.stop(new AgentHistoryError('limit_exhausted', 'Codex history response exceeds its frame budget.'));
      chunk.copy(this.frame, this.frameLength, offset, end);
      this.frameLength += length;
      if (newline === -1) return;
      const response = Buffer.from(this.frame.subarray(0, this.frameLength));
      this.frameLength = 0;
      offset = newline + 1;
      if (response.length !== 0) this.receive(response);
      if (this.failure) return;
    }
  }

  private receive(response: Buffer): void {
    if (++this.frames > MAX_FRAMES) return this.stop(new AgentHistoryError('limit_exhausted', 'Codex history process exceeded its message budget.'));
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response));
      const envelope = envelopeSchema.parse(value);
      if (envelope.method !== undefined) {
        if (envelope.id !== undefined) throw new Error('Unexpected native callback');
        return;
      }
      if (envelope.id === undefined || envelope.id !== this.pending?.id
        || (Object.hasOwn(envelope, 'result') === Object.hasOwn(envelope, 'error'))) {
        throw new Error('Invalid response correlation');
      }
      const pending = this.pending;
      if (response.length > pending.maximum) return this.stop(new AgentHistoryError('limit_exhausted', 'Codex history response exceeds the requested ingress budget.'));
      this.pending = undefined;
      pending.resolve(response);
    } catch { this.stop(new AgentHistoryError('native_failure', 'Codex history returned an invalid or unexpected protocol envelope.')); }
  }

  private async call(method: CodexHistoryRequest['method'] | 'initialize', params: unknown, context: CodexHistoryRequestContext): Promise<Uint8Array> {
    context.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.closed) throw new AgentHistoryError('closed', 'Codex history process is closing.');
    if (this.pending) throw new AgentHistoryError('busy', 'Codex history allows one outstanding native request.');
    const id = ++this.nextId;
    const input = `${JSON.stringify({ id, method, params })}\n`;
    if (Buffer.byteLength(input) > INPUT_BYTES) throw new AgentHistoryError('limit_exhausted', 'Codex history request exceeds its input budget.');
    const response = new Promise<Uint8Array>((resolve, reject) => { this.pending = { id, maximum: Math.min(FRAME_BYTES, context.maxResponseBytes), resolve, reject }; });
    const abort = () => this.stop(new AgentHistoryError('cancelled', 'Codex history read was cancelled.'));
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const timer = setTimeout(() => this.stop(new AgentHistoryError('deadline_exceeded', 'Codex history request exceeded its deadline.')), 10_000);
    try {
      if (!this.failure) this.child.stdin.write(input);
      return await response;
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
    }
  }

  request(request: CodexHistoryRequest, context: CodexHistoryRequestContext): Promise<Uint8Array> {
    return this.call(request.method, request.params, context);
  }

  async initialize(signal: AbortSignal): Promise<void> {
    const response = await this.call('initialize', { clientInfo: { name: 'agenai_history', version: '1' },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true } }, { signal, maxResponseBytes: FRAME_BYTES });
    const parsed = z.object({ result: z.object({ userAgent: z.string().max(4096) }) }).safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response)));
    if (!parsed.success || !parsed.data.result.userAgent.startsWith('agenai_history/0.163.0 ')) {
      throw new AgentHistoryError('unsupported_scope', 'Codex history requires the qualified app-server 0.163.0 initialization.');
    }
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    await this.assertResourcePolicy();
  }

  private async assertResourcePolicy(): Promise<void> {
    try {
      if (this.child.pid === undefined) throw new Error('Missing process');
      const limits = await readFile(`/proc/${this.child.pid}/limits`, 'utf8');
      for (const { name, maximum } of [{ name: 'address space', maximum: 2_147_483_648 },
        { name: 'cpu time', maximum: 30 }, { name: 'open files', maximum: 256 }, { name: 'core file size', maximum: 0 }]) {
        const match = new RegExp(`^Max ${name}\\s+(\\S+)\\s+(\\S+)`, 'mu').exec(limits);
        if (!match || ![match[1], match[2]].every((value) => value !== undefined && /^\d+$/u.test(value)
          && Number.isSafeInteger(Number(value)) && Number(value) <= maximum && (maximum === 0 || Number(value) > 0))) {
          throw new Error('Resource policy mismatch');
        }
      }
    } catch { throw new AgentHistoryError('unsupported_scope', 'Codex history could not establish its qualified kernel resource limits.'); }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.stop(), 2000);
    try {
      await this.exited;
      this.stop();
      if (this.child.pid !== undefined) await waitForGroupExit(this.child.pid);
    } finally {
      clearTimeout(timer);
      clearTimeout(this.wallTimer);
    }
  }
}
