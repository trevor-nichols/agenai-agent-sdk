// ------------------------------------------------------------------------------------------------
//                owner.ts - Once-only Docker exec ownership - Whole-sandbox termination boundary
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/v4';
import { parseSandboxProcessId, SandboxOperationError, SandboxStateError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { OperationOptions, SandboxPolicy, SandboxProcessExit, SandboxProcessSpec, SandboxProcessStreams } from '@agen-ai/sandbox';
import type { SandboxDriverProcessReservation } from '@agen-ai/sandbox/backend';
import type { DockerSandboxConfig } from '../policy/config.js';
import { DOCKER_API } from '../policy/config.js';
import { DOCKER_ENVIRONMENT } from '../policy/container.js';
import type { DockerApi } from '../resources/api.js';
import { DockerProcessAttachment } from './attachment.js';

const createdSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u) });
const inspectionSchema = z.object({
  ID: z.string().regex(/^[a-f0-9]{64}$/u), ContainerID: z.string().regex(/^[a-f0-9]{64}$/u),
  Running: z.boolean(), ExitCode: z.number().int().min(0).max(255).nullable(),
});
const fixedEnvironment: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(DOCKER_ENVIRONMENT.map((entry) => {
  const separator = entry.indexOf('=');
  return [entry.slice(0, separator), entry.slice(separator + 1)];
})));

export class DockerProcessOwner implements SandboxDriverProcessReservation {
  readonly id = parseSandboxProcessId(`docker-process-${randomUUID()}`);
  private readonly stopping = new AbortController();
  private readonly exited = Promise.withResolvers<SandboxProcessExit>();
  private entered = false;
  private startActual: Promise<SandboxProcessStreams> | undefined;
  private exitSettled = false;
  private attachment: DockerProcessAttachment | undefined;
  private monitoring: Promise<void> | undefined;

  constructor(private readonly api: DockerApi, private readonly config: DockerSandboxConfig,
    private readonly containerId: string, private readonly spec: SandboxProcessSpec, private readonly policy: SandboxPolicy,
    private readonly assertActive: (signal?: AbortSignal) => Promise<void>, private readonly stopSandbox: () => Promise<void>) {
    for (const [name, value] of Object.entries(fixedEnvironment)) {
      if (spec.env[name] !== undefined && spec.env[name] !== value) {
        throw new SandboxUnsupportedError(`Docker requires its fixed safe ${name} environment value.`);
      }
    }
    void this.exited.promise.catch(() => {});
  }

  start(options?: OperationOptions): Promise<SandboxProcessStreams> {
    if (this.entered || this.stopping.signal.aborted) return Promise.reject(new SandboxStateError('Docker process startup is once-only and cannot follow shutdown.'));
    this.entered = true;
    this.startActual = this.launch(options);
    return this.startActual;
  }

  private async launch(options?: OperationOptions): Promise<SandboxProcessStreams> {
    const signal = options?.signal ? AbortSignal.any([options.signal, this.stopping.signal]) : this.stopping.signal;
    signal.throwIfAborted();
    await this.assertActive(signal);
    signal.throwIfAborted();
    const created = await this.api.json('POST', `${DOCKER_API}/containers/${this.containerId}/exec`, createdSchema, { signal, body: {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Privileged: false,
      Cmd: [this.spec.executable, ...this.spec.args], Env: Object.entries({ ...fixedEnvironment, ...this.spec.env }).map(([key, value]) => `${key}=${value}`),
      WorkingDir: this.spec.cwd, User: `${this.config.user.uid}:${this.config.user.gid}`,
    } });
    signal.throwIfAborted();
    await this.assertActive(signal);
    signal.throwIfAborted();
    const attached = await this.api.upgrade(`${DOCKER_API}/exec/${created.Id}/start`, { Detach: false, Tty: false }, signal);
    this.attachment = new DockerProcessAttachment(attached, this.policy.streams, (error) => this.fail(error));
    if (signal.aborted) { this.attachment.close(); throw new SandboxOperationError('cancelled', 'Docker process attached after shutdown entered.'); }
    this.monitoring = this.monitor(created.Id).catch((error: unknown) => {
      if (!this.stopping.signal.aborted) this.fail(error instanceof Error ? error : new SandboxOperationError('driver_failure', 'Docker process inspection failed.', { cause: error }));
    });
    return Object.freeze({ stdin: this.attachment.stdin, stdout: this.attachment.stdout, stderr: this.attachment.stderr, exit: this.exited.promise });
  }

  closeAdmission(): void {
    if (!this.stopping.signal.aborted) this.stopping.abort(new SandboxOperationError('cancelled', 'Docker sandbox compute is stopping.'));
    this.attachment?.close();
  }

  async computeStopped(): Promise<void> {
    this.closeAdmission();
    this.exit({ kind: 'unavailable', reason: 'sandbox_stopped' });
    await this.startActual?.catch(() => {});
    await this.monitoring;
    await this.attachment?.settled;
  }

  private async monitor(execId: string): Promise<void> {
    while (!this.stopping.signal.aborted) {
      const response = await this.api.request('GET', `${DOCKER_API}/exec/${execId}/json`, { statuses: [200, 404], signal: this.stopping.signal });
      if (this.stopping.signal.aborted) return;
      if (response.statusCode === 404) {
        throw new SandboxOperationError('driver_failure', 'Docker lost the owned exec before sandbox removal was confirmed.');
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.from(response.body).toString('utf8')); }
      catch (cause) { throw new SandboxOperationError('driver_failure', 'Docker exec inspection returned invalid JSON.', { cause }); }
      const result = inspectionSchema.safeParse(value);
      if (!result.success || result.data.ID !== execId || result.data.ContainerID !== this.containerId) {
        throw new SandboxOperationError('driver_failure', 'Docker exec inspection differs from the exact owned exec and workload.');
      }
      // Docker upgrades the stream before native startup; a non-running null exit is still pending.
      if (!result.data.Running && result.data.ExitCode !== null) { this.exit({ kind: 'exited', code: result.data.ExitCode }); return; }
      await delay(100, undefined, { signal: this.stopping.signal });
    }
  }

  private exit(result: SandboxProcessExit): void {
    if (this.exitSettled) return;
    this.exitSettled = true;
    this.exited.resolve(Object.freeze(result));
  }

  private fail(error: Error): void {
    this.attachment?.close(error);
    void this.stopSandbox().catch(() => {});
  }
}
