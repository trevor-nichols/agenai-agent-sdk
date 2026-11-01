import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileFromBytes } from '@agen-ai/sandbox';
import type { Sandbox, SandboxProcessReservation, SandboxReservation, SandboxTransferSummary } from '@agen-ai/sandbox';
import { exportSandboxDirectory, SandboxDirectoryCleanupError } from '@agen-ai/sandbox/node';
import { CONCURRENT_FIXTURE, memberNativeState, memberProject, sha256 } from './fixture.js';
import { CONCURRENT_GUEST_PROGRAM } from './program.js';
import { CONCURRENT_NETWORK_PROGRAM } from './network-program.js';
import { CONCURRENT_PROTOCOL, networkCommand } from './protocol.js';
import { ConcurrentProgramSession, integer, observeWithin, record, text } from './session.js';
import type {
  ConcurrentCleanupFailure, ConcurrentContinuity, ConcurrentForbiddenObservation, ConcurrentHttpsFixture, ConcurrentMemberInput,
  ConcurrentMemberLabel, ConcurrentMemberResult, ConcurrentWorkflowOptions,
} from './types.js';

const encoder = new TextEncoder();
type GitState = ConcurrentContinuity['git'];

function gitState(value: unknown): GitState {
  const input = record(value); assert.equal(input.detached, true);
  const head = text(input.head); assert(/^[a-f0-9]{40,64}$/u.test(head));
  const configSha256 = text(input.configSha256); const indexSha256 = text(input.indexSha256);
  assert(/^[a-f0-9]{64}$/u.test(configSha256) && /^[a-f0-9]{64}$/u.test(indexSha256));
  return { head, detached: true, configSha256, indexSha256 };
}

export class ConcurrentMember {
  readonly token = randomUUID();
  readonly owner: SandboxReservation;
  private readonly generation: string;
  private prepared: Sandbox | undefined;
  private processOwner: SandboxProcessReservation | undefined;
  private primary: Readonly<{ process: SandboxProcessReservation; session: ConcurrentProgramSession }> | undefined;
  private imported: SandboxTransferSummary | undefined;
  private git: GitState | undefined;
  private mutation: 'initial' | 'mutated' = 'initial';
  private artifactCleanup: SandboxDirectoryCleanupError | undefined;
  private publication: Readonly<{ exported: SandboxTransferSummary; directory: string }> | undefined;
  private readonly operations: Array<Readonly<{ name: string; task: Promise<unknown> }>> = [];

  constructor(readonly label: ConcurrentMemberLabel, readonly input: ConcurrentMemberInput, private readonly options: ConcurrentWorkflowOptions) {
    const coordinator = options.coordinator.state; assert.equal(coordinator.kind, 'active');
    if (coordinator.kind !== 'active') throw new Error('Original coordinator admission is not active.');
    this.generation = coordinator.generation;
    this.owner = input.backend.reserve(input.request, input.recovery);
  }
  get sandbox(): Sandbox { assert(this.prepared, 'Member preparation has not settled.'); return this.prepared; }
  get process(): SandboxProcessReservation { assert(this.primary, 'Original primary has not dispatched.'); return this.primary.process; }
  get session(): ConcurrentProgramSession { assert(this.primary, 'Original primary has not dispatched.'); return this.primary.session; }
  get processId(): string | null { return this.processOwner?.id ?? null; }
  get readerId(): string | null { return this.primary?.session.readerId ?? null; }

  private track<T>(name: string, task: Promise<T>): Promise<T> {
    void task.catch(() => {}); this.operations.push({ name, task }); return task;
  }
  private transferOptions(operation: 'import' | 'export') {
    return { ...this.options.transferOptions?.(this.label, operation), ...(this.options.signal ? { signal: this.options.signal } : {}) };
  }

  private assertCoordinatedMembership(): void {
    const coordinator = this.options.coordinator.state;
    assert.equal(coordinator.kind, 'active', 'Original coordinator lost active authority.');
    if (coordinator.kind !== 'active') throw new Error('Original coordinator lost active authority.');
    assert.equal(coordinator.generation, this.generation);
    assert(coordinator.members.some((member) => member.kind === 'active' && member.sandboxId === this.owner.id
      && member.operationId === this.owner.recoveryRecord.operationId),
    'Prepared owner is not an active original member of the supplied coordinator.');
  }

  async prepare(): Promise<void> {
    const operation = this.options.signal ? { signal: this.options.signal } : {};
    this.prepared = await this.track('sandbox_start', this.owner.start(operation));
    this.assertCoordinatedMembership();
    assert.equal(this.prepared.files.kind, 'read_write');
    this.imported = await this.track('import', this.prepared.importTree([
      fileFromBytes('inputs/source.txt', encoder.encode(CONCURRENT_FIXTURE.source)),
      fileFromBytes('inputs/AGENTS.md', encoder.encode(CONCURRENT_FIXTURE.instructions)),
      fileFromBytes('project/source.txt', encoder.encode(CONCURRENT_FIXTURE.source)),
      fileFromBytes('project/same-path.txt', encoder.encode(CONCURRENT_FIXTURE.initialProject)),
      fileFromBytes('native-state/state.txt', encoder.encode(CONCURRENT_FIXTURE.initialNativeState)),
      fileFromBytes('.concurrency/primary.mjs', encoder.encode(CONCURRENT_GUEST_PROGRAM)),
      fileFromBytes('.concurrency/network.mjs', encoder.encode(CONCURRENT_NETWORK_PROGRAM)),
    ], this.transferOptions('import')));
    assert.equal(this.imported.files, 7n); assert.equal(this.imported.symlinks, 0n);
  }

  async dispatch(): Promise<void> {
    this.assertCoordinatedMembership();
    const process = this.sandbox.reserveProcess({ executable: '/usr/local/bin/node',
      args: [this.sandbox.workspace + '/.concurrency/primary.mjs', this.label, this.token, String(this.options.operationTimeoutMs)],
      cwd: this.sandbox.workspace, env: { LANG: 'C.UTF-8' } });
    this.processOwner = process;
    const streams = await this.track('process_start', process.start(this.options.signal ? { signal: this.options.signal } : {}));
    const session = new ConcurrentProgramSession(streams, this.label, this.token, this.options.operationTimeoutMs, this.options.onOutput);
    this.primary = { process, session };
    await session.ready(); assert.equal(session.identity.platform, 'linux');
    assert.equal(session.identity.cwd, this.sandbox.workspace);
    const initial = await session.request({ kind: 'inspect' });
    assert.equal(initial.project, CONCURRENT_FIXTURE.initialProject); assert.equal(initial.nativeState, CONCURRENT_FIXTURE.initialNativeState);
    this.git = gitState(initial.git);
    await session.request({ kind: 'hold', positive: this.input.positive });
  }

  async mutate(): Promise<void> {
    const previous = this.git; assert(previous);
    const updated = await this.session.request({ kind: 'mutate' });
    const next = gitState(updated.git);
    assert.notEqual(next.head, previous.head); assert.notEqual(next.indexSha256, previous.indexSha256);
    assert.equal(next.configSha256, previous.configSha256);
    this.git = next; this.mutation = 'mutated';
  }

  async continuity(denied: ConcurrentHttpsFixture, signal?: AbortSignal): Promise<ConcurrentContinuity> {
    signal?.throwIfAborted();
    const previousCounter = this.session.counter; const previousHeld = this.session.held.sequence;
    await this.session.progress(previousCounter, previousHeld);
    const snapshot = await this.session.request({ kind: 'inspect', snapshot: true });
    assert.deepEqual(snapshot.identity, this.session.identity);
    assert(integer(snapshot.counter) >= previousCounter + 3);
    assert.equal(snapshot.sourceSha256, sha256(CONCURRENT_FIXTURE.source));
    assert.equal(snapshot.instructionsSha256, sha256(CONCURRENT_FIXTURE.instructions));
    const project = this.mutation === 'initial' ? CONCURRENT_FIXTURE.initialProject : memberProject(this.label);
    const nativeState = this.mutation === 'initial' ? CONCURRENT_FIXTURE.initialNativeState : memberNativeState(this.label);
    assert.equal(snapshot.project, project); assert.equal(snapshot.nativeState, nativeState);
    const git = gitState(snapshot.git); assert.deepEqual(git, this.git, 'A peer transition changed this member\'s Git state.');
    const files = this.sandbox.files; assert.equal(files.kind, 'read_write');
    if (files.kind !== 'read_write') throw new Error('Admitted live file access disappeared.');
    const counterSnapshot = record(snapshot.counterSnapshot); const path = text(counterSnapshot.path);
    const selected = /^native-state\/observations\/([1-9][0-9]*)\.json$/u.exec(path);
    assert(selected && integer(Number(selected[1])) <= CONCURRENT_PROTOCOL.commands, 'Original counter snapshot path exceeds its command scope.');
    const expectedBytes = integer(counterSnapshot.bytes); assert(expectedBytes <= 4096);
    let bytes = Buffer.alloc(0);
    const read = await files.readFile(path, async ({ chunks }) => {
      for await (const chunk of chunks) { bytes = Buffer.concat([bytes, chunk]); assert(bytes.length <= 4096); }
    }, { quotas: { maxBytes: 4096 }, ...(signal ? { signal } : {}) });
    const afterReadCounter = this.session.counter; const afterReadHeld = this.session.held.sequence;
    assert(read.kind === 'completed',
      `Live counter snapshot read returned ${read.kind}${'reason' in read ? ` (${read.reason})` : ''} after ${read.bytes} bytes.`);
    assert.equal(read.bytes, BigInt(bytes.length)); assert.equal(bytes.length, expectedBytes);
    assert.equal(sha256(bytes), text(counterSnapshot.sha256));
    const counter = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    assert.equal(counter.label, this.label); assert.equal(counter.session, this.token); assert.equal(counter.pid, this.session.identity.pid);
    assert(integer(counter.counter) >= previousCounter + 3);
    const network = await this.session.request(networkCommand(this.input.positive, denied, this.input.forbidden));
    const fresh = record(network.fresh); const negative = record(network.denied);
    assert.equal(fresh.status, this.input.positive.status); assert.equal(fresh.bodyBytes, this.input.positive.bodyBytes);
    assert.equal(fresh.bodySha256, this.input.positive.bodySha256); assert.equal(fresh.authorized, true);
    assert.equal(negative.hostname, denied.hostname); assert.equal(negative.port, denied.port); assert.equal(negative.proxyStatus, 403);
    assert(Array.isArray(network.forbidden)); assert.equal(network.forbidden.length, this.input.forbidden.length);
    const forbidden: ConcurrentForbiddenObservation[] = network.forbidden.map((value: unknown, index: number) => {
      const observed = record(value); const fixture = this.input.forbidden[index]; assert(fixture);
      assert.deepEqual(observed.fixture, fixture); assert.equal(observed.proxyStatus, 403);
      const direct = record(observed.direct); assert(direct.code === null || typeof direct.code === 'string');
      const message = text(direct.message);
      if (fixture.transport === 'tcp') {
        assert.equal(direct.kind, 'tcp'); assert.equal(direct.connected, false);
        return { fixture, direct: { kind: 'tcp', connected: false, code: direct.code, message }, proxyStatus: 403 };
      }
      assert.equal(direct.kind, 'udp'); assert.equal(direct.received, false);
      return { fixture, direct: { kind: 'udp', received: false, code: direct.code, message }, proxyStatus: 403 };
    });
    await this.session.progress(afterReadCounter, afterReadHeld);
    const held = this.session.held;
    assert(held.sequence > previousHeld); assert.equal(held.status, this.input.positive.status);
    return { identity: this.session.identity, counter: integer(counter.counter), held,
      fresh: { status: this.input.positive.status, bodyBytes: this.input.positive.bodyBytes, bodySha256: this.input.positive.bodySha256,
        authorized: true, certificateFingerprint256: text(fresh.certificateFingerprint256) },
      denied: { hostname: denied.hostname, port: denied.port, proxyStatus: 403 }, forbidden, sourceSha256: sha256(CONCURRENT_FIXTURE.source),
      instructionsSha256: sha256(CONCURRENT_FIXTURE.instructions), project, nativeState, git };
  }

  async cancel(): Promise<void> {
    this.session.beginStop();
    await this.track('process_stop', this.process.stop());
  }
  async stop(): Promise<void> {
    this.primary?.session.beginStop();
    await this.track('sandbox_stop', this.owner.stop());
    assert.equal(this.owner.state.kind, 'stopped');
    const settled = await observeWithin(this.session.settle(), this.options.operationTimeoutMs, 'original reader settlement');
    if (settled.failure) throw settled.failure;
  }
  async exportProject(): Promise<void> {
    assert.equal(this.owner.state.kind, 'stopped', 'Settle all writers before project publication.');
    try {
      const exported = await this.track('export', exportSandboxDirectory(this.sandbox, { kind: 'subtree', path: 'project' },
        this.input.destination, this.transferOptions('export')));
      this.publication = { directory: exported.directory, exported: exported.summary };
      await this.verifyExport(exported.directory, exported.summary);
    } catch (error) { if (error instanceof SandboxDirectoryCleanupError) this.artifactCleanup = error; throw error; }
  }

  private async verifyExport(directory: string, summary: SandboxTransferSummary): Promise<void> {
    assert.deepEqual(await readdir(directory), ['project'], 'Project export included auxiliary state or immutable inputs.');
    const project = join(directory, 'project');
    assert.deepEqual((await readdir(project)).sort(), ['.git', 'counter.json', 'same-path.txt', 'source.txt']);
    assert.equal(await readFile(join(project, 'source.txt'), 'utf8'), CONCURRENT_FIXTURE.source);
    assert.equal(await readFile(join(project, 'same-path.txt'), 'utf8'),
      this.mutation === 'initial' ? CONCURRENT_FIXTURE.initialProject : memberProject(this.label));
    const counter = record(JSON.parse(await readFile(join(project, 'counter.json'), 'utf8')));
    assert.equal(counter.label, this.label); assert.equal(counter.session, this.token); assert.equal(counter.pid, this.session.identity.pid);
    assert(integer(counter.counter) >= this.session.counter);
    assert.equal(sha256(await readFile(join(project, '.git/config'))), this.git?.configSha256);
    assert.equal(sha256(await readFile(join(project, '.git/index'))), this.git?.indexSha256);
    assert.equal((await readFile(join(project, '.git/HEAD'), 'utf8')).trim(), this.git?.head);
    assert.deepEqual(await readdir(join(project, '.git/hooks')), []);
    let files = 0n; let directories = 0n; let payloadBytes = 0n;
    async function walk(path: string): Promise<void> {
      for (const name of await readdir(path)) {
        const child = join(path, name); const metadata = await lstat(child);
        if (metadata.isDirectory()) { directories++; await walk(child); }
        else { assert(metadata.isFile() && metadata.nlink === 1, 'Project export contains shared or non-file state.'); files++; payloadBytes += BigInt(metadata.size); }
      }
    }
    await walk(directory);
    assert.equal(summary.files, files); assert.equal(summary.directories, directories);
    assert.equal(summary.payloadBytes, payloadBytes); assert.equal(summary.symlinks, 0n);
  }

  async destroy(): Promise<void> {
    this.primary?.session.beginStop();
    await this.track('sandbox_destroy', this.owner.destroy());
    assert.equal(this.owner.state.kind, 'destroyed');
    if (this.primary) {
      const settled = await observeWithin(this.primary.session.settle(), this.options.operationTimeoutMs, 'destroyed original readers');
      if (settled.failure) throw settled.failure;
    }
  }

  async cleanup(): Promise<readonly ConcurrentCleanupFailure[]> {
    const failures: ConcurrentCleanupFailure[] = [];
    this.primary?.session.beginStop();
    try { await this.owner.destroy(); }
    catch (error) { failures.push({ member: this.label, operation: 'destroy', error }); }
    if (this.owner.state.kind === 'destroyed') {
      if (this.primary) {
        try {
          const settled = await observeWithin(this.primary.session.settle(), this.options.operationTimeoutMs, 'cleanup original readers');
          if (settled.failure) failures.push({ member: this.label, operation: 'readers', error: settled.failure });
        } catch (error) { failures.push({ member: this.label, operation: 'reader_settlement', error }); }
      }
      try {
        const settled = await observeWithin(Promise.allSettled(this.operations.map(({ task }) => task)),
          this.options.operationTimeoutMs, 'cleanup entered-operation settlement');
        for (const [index, result] of settled.entries()) {
          const entered = this.operations[index]; assert(entered);
          if (result.status === 'rejected') failures.push({ member: this.label, operation: 'entered_operation', enteredOperation: entered.name, error: result.reason });
        }
      } catch (error) { failures.push({ member: this.label, operation: 'entered_operation_settlement', error }); }
    }
    if (this.artifactCleanup) {
      try { await this.artifactCleanup.retryCleanup(); this.artifactCleanup = undefined; }
      catch (error) { failures.push({ member: this.label, operation: 'export_directory', error }); }
    }
    return failures;
  }

  async result(): Promise<ConcurrentMemberResult> {
    assert(this.imported && this.publication && this.primary);
    const settled = await this.primary.session.settle(); assert(!settled.failure && settled.exit);
    return { label: this.label, sandboxId: this.owner.id, processId: this.primary.process.id, readerId: this.primary.session.readerId,
      identity: this.primary.session.identity, imported: this.imported, ...this.publication, processExit: settled.exit,
      recoveryRecord: this.owner.recoveryRecord };
  }
}
