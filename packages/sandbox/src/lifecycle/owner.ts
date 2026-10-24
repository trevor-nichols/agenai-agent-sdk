// ------------------------------------------------------------------------------------------------
//                owner.ts - Sandbox resource ownership - Driver ports and bounded operations
// ------------------------------------------------------------------------------------------------

import type { SandboxDriverReady, SandboxDriverReservation } from '../backend/contracts.js';
import type { OperationOptions, Sandbox, SandboxReservation, SandboxState } from '../contracts.js';
import { SandboxCleanupError, SandboxOperationError, SandboxStartError, SandboxStateError } from '../errors.js';
import { parseTransferOptions } from '../files/parse.js';
import type { ParsedTransferOptions } from '../files/parse.js';
import { parseSandboxGuestPath } from '../files/paths.js';
import type { SandboxTreeSource, SandboxTreeSelection, SandboxExportConsumer, SandboxTransferOptions } from '../files/types.js';
import { assertSandboxEffectivePolicy, parseSandboxEffectivePolicy, parseSandboxProcessId } from '../policy/parse.js';
import type { SandboxRequest } from '../policy/types.js';
import { parseSandboxProcessSpec } from '../process/parse.js';
import { ownProcessStreams } from '../process/streams.js';
import type { OwnedProcessStreams } from '../process/streams.js';
import type { SandboxProcessInput, SandboxProcessReservation, SandboxProcessStreams } from '../process/types.js';
import type { SandboxRecoveryPolicy, SandboxRecoveryRecord } from '../recovery/types.js';
import { parseOperationOptions } from '../internal/operations.js';
import { RecoveryJournal } from './journal.js';
import { scheduleDeadline } from './deadline.js';
import { actualOperation, observe, settled } from './observation.js';
import { importTree, exportTree } from './transfer.js';
import type { OwnedTransfer } from './transfer.js';

interface FileOperation {
  readonly kind: 'import' | 'export';
  readonly controller: AbortController;
  readonly actual: Promise<unknown>;
  readonly work: OwnedTransfer;
}

interface ProcessOperation {
  readonly controller: AbortController;
  readonly actual: Promise<SandboxProcessStreams>;
}

export class SandboxOwner implements SandboxReservation {
  private snapshot: SandboxState = Object.freeze({ kind: 'reserved' });
  private readonly journal: RecoveryJournal;
  private readonly startupController = new AbortController();
  private startup: Promise<Sandbox> | undefined;
  private ready: SandboxDriverReady | undefined;
  private transfer: FileOperation | undefined;
  private processReserved = false;
  private process: ProcessOperation | undefined;
  private streams: OwnedProcessStreams | undefined;
  private cancelExecutionDeadline: (() => void) | undefined;
  private stopActual: Promise<void> | undefined;
  private destroyActual: Promise<void> | undefined;
  private stopObservation: Promise<void> | undefined;
  private destroyObservation: Promise<void> | undefined;

  constructor(private readonly driver: SandboxDriverReservation, private readonly request: SandboxRequest,
    recovery: SandboxRecoveryPolicy, record: SandboxRecoveryRecord) {
    this.journal = new RecoveryJournal(record, recovery, (error) => {
      this.startupController.abort(error);
      this.fence('start');
    });
  }

  get id() { return this.driver.id; }
  get state(): SandboxState { return this.snapshot; }
  get recoveryRecord(): SandboxRecoveryRecord { return this.journal.current; }

  start(input?: OperationOptions): Promise<Sandbox> {
    const options = parseOperationOptions(input);
    if (this.snapshot.kind !== 'reserved') return Promise.reject(new SandboxStateError('Sandbox startup is once-only and cannot follow cleanup.'));
    this.snapshot = Object.freeze({ kind: 'starting' });
    if (options.signal?.aborted) this.startupController.abort(new SandboxOperationError('cancelled', 'Sandbox startup was cancelled before entry.'));
    this.startup = actualOperation(async () => {
      this.startupController.signal.throwIfAborted();
      await this.journal.initialize();
      this.startupController.signal.throwIfAborted();
      const ready = await this.driver.start({ signal: this.startupController.signal, checkpoint: this.journal.checkpoint });
      this.ready = ready;
      if (this.snapshot.kind !== 'starting' || this.startupController.signal.aborted) {
        throw new SandboxOperationError('cancelled', 'Sandbox startup settled after its admission was closed.');
      }
      const effective = parseSandboxEffectivePolicy(ready.effective);
      const workspace = parseSandboxGuestPath(ready.workspace);
      assertSandboxEffectivePolicy(this.request, effective);
      const owner = this;
      const sandbox: Sandbox = Object.freeze({
        id: this.id, effective, workspace,
        get state() { return owner.state; },
        get recoveryRecord() { return owner.recoveryRecord; },
        importTree: (entries: SandboxTreeSource, operation?: SandboxTransferOptions) => owner.importTree(entries, operation),
        reserveProcess: (spec: SandboxProcessInput) => owner.reserveProcess(spec),
        exportTree: (selection: SandboxTreeSelection, consume: SandboxExportConsumer, operation?: SandboxTransferOptions) => owner.exportTree(selection, consume, operation),
        stop: () => owner.stop(), destroy: () => owner.destroy(),
      });
      this.snapshot = Object.freeze({ kind: 'ready' });
      return sandbox;
    });
    void this.startup.catch(() => this.fence('start'));
    return observe(this.startup, this.request.policy.deadlines.startupMs, {
      signal: operationSignal(this.startupController, options), onInterrupt: (error) => {
        this.startupController.abort(error);
        this.fence('start');
        void this.stop().catch(() => {});
      },
    }).catch((cause: unknown) => { throw new SandboxStartError('Sandbox startup failed; its reservation retains cleanup ownership.', { cause, owner: this }); });
  }

  stop(): Promise<void> {
    if (this.snapshot.kind === 'destroyed' || this.snapshot.kind === 'stopped') return Promise.resolve();
    if (this.stopObservation) return this.stopObservation;
    const actual = this.beginStop();
    this.stopObservation = observe(actual, this.request.policy.deadlines.cleanupMs).catch((cause: unknown) => {
      this.fence('stop');
      throw new SandboxCleanupError('Sandbox compute cleanup did not settle successfully.', { cause, owner: this, operation: 'stop' });
    }).finally(() => { this.stopObservation = undefined; });
    return this.stopObservation;
  }

  destroy(): Promise<void> {
    if (this.snapshot.kind === 'destroyed') return Promise.resolve();
    if (this.destroyObservation) return this.destroyObservation;
    this.snapshot = Object.freeze({ kind: 'destroying' });
    this.transfer?.controller.abort(new SandboxOperationError('cancelled', 'Sandbox storage is being destroyed.'));
    if (!this.destroyActual) {
      const transferCleanup = this.cleanupTransfer();
      void transferCleanup.catch(() => {});
      const dispatch = Promise.withResolvers<void>();
      const actual = dispatch.promise.then(async () => {
        await transferCleanup;
        await this.driver.destroy();
        this.snapshot = Object.freeze({ kind: 'destroyed' });
      }).catch((error: unknown) => {
        this.destroyActual = undefined;
        if (this.snapshot.kind !== 'destroyed') this.snapshot = Object.freeze({ kind: 'uncertain', operation: 'destroy' });
        throw error;
      });
      this.destroyActual = actual;
      this.beginStop().then(dispatch.resolve, dispatch.reject);
    }
    this.destroyObservation = observe(this.destroyActual, this.request.policy.deadlines.cleanupMs).catch((cause: unknown) => {
      this.fence('destroy');
      throw new SandboxCleanupError('Sandbox destruction did not settle successfully.', { cause, owner: this, operation: 'destroy' });
    }).finally(() => { this.destroyObservation = undefined; });
    return this.destroyObservation;
  }

  private beginStop(): Promise<void> {
    if (this.stopActual) return this.stopActual;
    if (this.snapshot.kind !== 'destroying') this.snapshot = Object.freeze({ kind: 'stopping' });
    // Enter physical shutdown before joining work that may need shutdown to settle.
    const physical = Promise.withResolvers<void>();
    let transferCleanup: Promise<void> | undefined;
    const actual = physical.promise.then(async () => {
      await settled(this.startup);
      await settled(this.process?.actual);
      this.streams?.close();
      await this.streams?.settled;
      await transferCleanup;
      if (this.snapshot.kind !== 'destroying' && this.snapshot.kind !== 'destroyed') this.snapshot = Object.freeze({ kind: 'stopped' });
    }).catch((error: unknown) => {
      this.stopActual = undefined;
      if (this.snapshot.kind !== 'destroyed' && this.snapshot.kind !== 'destroying') this.snapshot = Object.freeze({ kind: 'uncertain', operation: 'stop' });
      throw error;
    });
    this.stopActual = actual;
    void actual.catch(() => {});
    const reason = new SandboxOperationError('cancelled', 'Sandbox compute is stopping.');
    this.startupController.abort(reason);
    this.process?.controller.abort(reason);
    if (this.transfer?.kind === 'import') this.transfer.controller.abort(reason);
    this.cancelExecutionDeadline?.();
    this.cancelExecutionDeadline = undefined;
    actualOperation(() => this.driver.stop()).then(physical.resolve, physical.reject);
    if (this.transfer?.kind === 'import') {
      transferCleanup = this.cleanupTransfer();
      void transferCleanup.catch(() => {});
    }
    this.streams?.close();
    return actual;
  }

  private importTree(entries: SandboxTreeSource, input?: SandboxTransferOptions) {
    const options = parseTransferOptions(input);
    if (this.snapshot.kind !== 'ready' || this.processReserved || this.transfer) throw new SandboxStateError('File import requires ready compute, no entered import, and no process reservation.');
    const ready = this.readyPort();
    return this.enterFile('import', options, (controller) => importTree(ready, entries, {
      signal: controller.signal, quotas: options.quotas, buffers: this.request.policy.transfers,
    }));
  }

  private exportTree(selection: SandboxTreeSelection, consume: SandboxExportConsumer, input?: SandboxTransferOptions) {
    const options = parseTransferOptions(input);
    if (this.snapshot.kind !== 'stopped' || this.transfer) throw new SandboxStateError('File export requires stopped compute and no other entered transfer.');
    const ready = this.readyPort();
    return this.enterFile('export', options, (controller) => exportTree(ready, selection, consume, {
      signal: controller.signal, quotas: options.quotas, buffers: this.request.policy.transfers,
    }));
  }

  private enterFile(kind: 'import' | 'export', options: ParsedTransferOptions, perform: (controller: AbortController) => OwnedTransfer) {
    if (options.signal?.aborted) return Promise.reject(new SandboxOperationError('cancelled', 'Sandbox file transfer was cancelled before entry.'));
    if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) return Promise.reject(new SandboxOperationError('deadline_exceeded', 'Sandbox file transfer deadline elapsed before entry.'));
    const controller = new AbortController();
    // perform constructs deferred work; the slot is installed before any caller iterator getter.
    const work = perform(controller);
    const actual = work.actual;
    const entry = { kind, controller, actual, work };
    this.transfer = entry;
    const release = () => { if (this.transfer === entry && work.clean) this.transfer = undefined; };
    void actual.then(release, () => { release(); if (kind === 'import') this.fence('import'); });
    const duration = options.deadlineAt === undefined ? undefined : Math.max(0, options.deadlineAt - Date.now());
    const observation = observe(actual, duration, { signal: operationSignal(controller, options), onInterrupt: (error) => {
      controller.abort(error);
      this.fence(kind);
      if (kind === 'import') void this.stop().catch(() => {});
    } });
    return observation;
  }

  private async cleanupTransfer(): Promise<void> {
    const entry = this.transfer;
    if (!entry) return;
    await entry.work.cleanup();
    if (this.transfer === entry && entry.work.clean) this.transfer = undefined;
  }

  private reserveProcess(input: SandboxProcessInput): SandboxProcessReservation {
    const spec = parseSandboxProcessSpec(input);
    if (this.snapshot.kind !== 'ready' || this.processReserved || this.transfer) throw new SandboxStateError('A sandbox admits one process reservation, after its imports settle.');
    this.processReserved = true;
    const reserved = this.readyPort().reserveProcess(spec);
    const id = parseSandboxProcessId(reserved.id);
    let entered = false;
    return Object.freeze({ id, stopScope: 'sandbox', start: (options?: OperationOptions) => {
      const parsed = parseOperationOptions(options);
      if (entered || this.snapshot.kind !== 'ready') return Promise.reject(new SandboxStateError('Process startup is once-only and requires ready compute.'));
      entered = true;
      const controller = new AbortController();
      if (parsed.signal?.aborted) controller.abort(new SandboxOperationError('cancelled', 'Process startup was cancelled before entry.'));
      const dispatch = Promise.withResolvers<SandboxProcessStreams>();
      const actual = dispatch.promise;
      this.process = { controller, actual };
      const execution = this.request.policy.execution;
      if (execution.kind === 'deadline') {
        this.cancelExecutionDeadline = scheduleDeadline(execution.timeoutMs, () => {
          controller.abort(new SandboxOperationError('deadline_exceeded', 'Sandbox execution exceeded its deadline.'));
          void this.stop().catch(() => {});
        });
      }
      const observation = observe(actual, this.request.policy.deadlines.startupMs, { signal: operationSignal(controller, parsed), onInterrupt: (error) => {
        controller.abort(error);
        this.fence('process');
        void this.stop().catch(() => {});
      } });
      void actual.catch(() => { this.fence('process'); void this.stop().catch(() => {}); });
      actualOperation(async () => {
        controller.signal.throwIfAborted();
        const raw = await reserved.start({ signal: controller.signal });
        const owned = ownProcessStreams(raw, this.request.policy.streams, () => { void this.stop().catch(() => {}); });
        this.streams = owned;
        if (controller.signal.aborted || this.snapshot.kind !== 'ready') {
          owned.close();
          throw new SandboxOperationError('cancelled', 'Process startup settled after its admission was closed.');
        }
        return owned.streams;
      }).then(dispatch.resolve, dispatch.reject);
      return observation;
    }, stop: () => this.stop() });
  }

  private readyPort(): SandboxDriverReady {
    if (!this.ready) throw new SandboxStateError('Sandbox startup has not yielded a workspace.');
    return this.ready;
  }

  private fence(operation: 'start' | 'import' | 'export' | 'process' | 'stop' | 'destroy'): void {
    if (this.snapshot.kind !== 'destroyed' && this.snapshot.kind !== 'destroying' && this.snapshot.kind !== 'stopping' && this.snapshot.kind !== 'stopped') {
      this.snapshot = Object.freeze({ kind: 'uncertain', operation });
    }
  }
}

function operationSignal(controller: AbortController, options: OperationOptions): AbortSignal {
  return options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
}
