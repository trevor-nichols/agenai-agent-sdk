import { AgentHistoryError } from '../../lifecycle/errors.js';

export class HistoryWorkerChannel {
  private readonly input: AsyncIterator<unknown> = process.stdin[Symbol.asyncIterator]();
  private buffered = Buffer.alloc(0);
  private bytes = 0;
  private ended = false;

  async read(): Promise<unknown> {
    for (;;) {
      const newline = this.buffered.indexOf(10);
      if (newline !== -1 || this.ended) {
        const frame = newline === -1 ? this.buffered : this.buffered.subarray(0, newline);
        this.buffered = newline === -1 ? Buffer.alloc(0) : this.buffered.subarray(newline + 1);
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
        catch { throw new AgentHistoryError('invalid_input', 'Native history worker requires a bounded JSON request.'); }
      }
      const next = await this.input.next();
      if (next.done) { this.ended = true; continue; }
      if (!Buffer.isBuffer(next.value)) throw new AgentHistoryError('invalid_input', 'Invalid native worker input encoding.');
      this.bytes += next.value.length;
      if (this.bytes > 32_768) throw new AgentHistoryError('limit_exhausted', 'Native history worker input exceeds 32 KiB.');
      this.buffered = Buffer.concat([this.buffered, next.value]);
    }
  }

  async permitMutation(): Promise<void> {
    await this.write({ version: 1, kind: 'ready' });
    const permit = await this.read();
    if (permit === null || typeof permit !== 'object' || Array.isArray(permit)
      || Object.keys(permit).length !== 2 || !('version' in permit) || permit.version !== 1
      || !('kind' in permit) || permit.kind !== 'dispatch') {
      throw new AgentHistoryError('invalid_input', 'Native mutation requires one explicit dispatch permit.');
    }
    if (this.buffered.length !== 0 || !(await this.input.next()).done) {
      throw new AgentHistoryError('invalid_input', 'Native mutation accepts one dispatch permit only.');
    }
  }

  write(value: unknown): Promise<void> {
    const output = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(output) > 262_144) throw new AgentHistoryError('limit_exhausted', 'Native history response exceeds its worker envelope.');
    return new Promise((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
  }
}
