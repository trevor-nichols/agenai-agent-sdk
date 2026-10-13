import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import { randomUUID } from 'node:crypto';
import type { AcpProviderLimits } from '../limits.js';
import type { AcpHostFacilities, AcpHostSessionInput, AcpHostTerminalLease } from './contracts.js';
import { awaitHost } from './lifecycle.js';
import { AcpHostLeases } from './leases.js';
import { hostEnvironment, hostExitStatus, hostInteger, hostObject, hostPath, hostText, invalidHostRequest, unsupportedHostRequest } from './validation.js';

interface Terminal {
  readonly lease: AcpHostTerminalLease;
  readonly release: () => Promise<void>;
  readonly outputByteLimit: number;
  readonly lifetime: AbortController;
  released: boolean;
}

export class AcpHostTerminals {
  private readonly terminals = new Map<string, Terminal>();
  private readonly leases: AcpHostLeases;

  constructor(private readonly host: AcpHostFacilities, private readonly limits: AcpProviderLimits) {
    this.leases = new AcpHostLeases(limits.hostOperationTimeoutMs);
  }

  async request(method: string, params: AcpJsonObject, session: AcpHostSessionInput): Promise<AcpJsonValue> {
    if (!this.host.createTerminal) throw unsupportedHostRequest();
    if (method === 'terminal/create') return this.create(params, session);
    const id = hostText(params.terminalId, 256);
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.released) throw invalidHostRequest();
    const signal = AbortSignal.any([session.signal, terminal.lifetime.signal]);
    if (method === 'terminal/output') {
      const result = await awaitHost(terminal.lease.output(signal), signal);
      const object = hostObject(result);
      const output = hostText(object.output, this.limits.maxQueuedBytes, true);
      if (typeof object.truncated !== 'boolean') throw invalidHostRequest();
      const bytes = Buffer.from(output, 'utf8');
      let tail = bytes.length > terminal.outputByteLimit ? bytes.subarray(bytes.length - terminal.outputByteLimit) : bytes;
      while (tail.length && (tail[0]! & 0xc0) === 0x80) tail = tail.subarray(1);
      return { output: tail.toString('utf8'), truncated: object.truncated || bytes.length > terminal.outputByteLimit,
        ...(object.exitStatus == null ? {} : { exitStatus: { ...hostExitStatus(object.exitStatus) } }) };
    }
    if (method === 'terminal/wait_for_exit') return { ...hostExitStatus(await awaitHost(terminal.lease.waitForExit(signal), signal)) };
    if (method === 'terminal/kill') { await awaitHost(terminal.lease.kill(signal), signal); return {}; }
    if (method === 'terminal/release') { await this.release(id, terminal); return {}; }
    throw unsupportedHostRequest();
  }

  private async create(params: AcpJsonObject, session: AcpHostSessionInput): Promise<AcpJsonValue> {
    if (this.leases.size >= this.limits.maxHostTerminals) throw invalidHostRequest();
    const command = hostText(params.command);
    if (params.args !== undefined && (!Array.isArray(params.args) || params.args.length > 128)) throw invalidHostRequest();
    const args = Object.freeze(((params.args ?? []) as AcpJsonValue[]).map((arg) => hostText(arg, 16_384, true)));
    const env = hostEnvironment(params.env);
    const cwd = params.cwd == null ? undefined : hostPath(params.cwd);
    const outputByteLimit = params.outputByteLimit == null ? Math.min(64 * 1_024, this.limits.maxQueuedBytes)
      : hostInteger(params.outputByteLimit, 1, this.limits.maxQueuedBytes);
    const { lease, release } = await this.leases.acquire((signal) => this.host.createTerminal!({ ...session, signal, command, args, env, outputByteLimit,
      ...(cwd === undefined ? {} : { cwd }) }), session.signal);
    try {
      if (typeof lease.output !== 'function' || typeof lease.waitForExit !== 'function' || typeof lease.kill !== 'function') {
        throw invalidHostRequest();
      }
      if (session.signal.aborted) throw session.signal.reason;
      const id = `agenai-terminal-${randomUUID()}`;
      this.terminals.set(id, { lease, release, outputByteLimit, lifetime: new AbortController(), released: false });
      return { terminalId: id };
    } catch (error) { await release(); throw error; }
  }

  private async release(id: string, terminal: Terminal): Promise<void> {
    terminal.released = true;
    terminal.lifetime.abort(new DOMException('Terminal released.', 'AbortError'));
    await terminal.release();
    this.terminals.delete(id);
  }

  async close(): Promise<void> {
    for (const terminal of this.terminals.values()) {
      terminal.released = true;
      terminal.lifetime.abort(new DOMException('Terminal released.', 'AbortError'));
    }
    await this.leases.close();
    this.terminals.clear();
  }
}
